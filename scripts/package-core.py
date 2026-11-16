#!/usr/bin/env python3
"""Package built Core assets; cross-built Windows archives are untested candidates only."""
import argparse
import atexit
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile

PRODUCT = 'tandem-core'
VERSION = '0.1.0'
TARGETS = {'linux-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64'}
root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('target', choices=sorted(TARGETS))
parser.add_argument('--allow-cross-windows-candidate', action='store_true',
                    help='Linux only: emit an untested win32-x64 candidate; never publish it')
parser.add_argument('--stage-dir', type=Path,
                    help='Parent for an automatically cleaned temporary staging directory (default: .release-stage)')
parser.add_argument('--output-dir', type=Path,
                    help='Archive directory; overrides TANDEM_ARTIFACT_DIR (default: artifacts, or artifacts/candidates for cross-Windows)')
args = parser.parse_args()
target = args.target
cross_windows = args.allow_cross_windows_candidate
if cross_windows and (sys.platform != 'linux' or target != 'win32-x64'):
    parser.error('--allow-cross-windows-candidate requires Linux host and win32-x64 target')

platform = {'linux-x64': ('linux-x64',), 'darwin-arm64': ('darwin-arm64',), 'darwin-x64': ('darwin-x64',), 'win32-x64': ()}[target]
if target.startswith('darwin-') and sys.platform != 'darwin':
    raise SystemExit(f'{target} must be packaged on its native macOS runner')
if target == 'win32-x64' and sys.platform != 'win32' and not cross_windows:
    raise SystemExit('win32-x64 requires a native Windows runner; Linux may explicitly use --allow-cross-windows-candidate')
if target == 'linux-x64' and sys.platform != 'linux':
    raise SystemExit('linux-x64 must be packaged on a native Linux runner')

stage_parent = (args.stage_dir or root / '.release-stage').expanduser().resolve()
stage_parent.mkdir(parents=True, exist_ok=True)
stage_root = Path(tempfile.mkdtemp(prefix=f'{PRODUCT}-package-{target}-', dir=stage_parent))
atexit.register(shutil.rmtree, stage_root)
stage = stage_root / f'{PRODUCT}-{VERSION}'
stage.mkdir()
files = set(filter(None, subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z']).decode().split('\0')))
files.add('tandem-install.json')
for base in ['apps', 'packages', 'vendor', 'native']:
    for directory, dirs, names in os.walk(root / base):
        dirs[:] = [d for d in dirs if d not in ['node_modules', '.desktop-build', 'tests', 'stress-tests']]
        for name in names:
            path = Path(directory) / name
            relative = path.relative_to(root)
            if 'lib' in relative.parts or 'dist' in relative.parts or path.suffix == '.node':
                files.add(str(relative))
for name in sorted(files):
    source = root / name
    if name.startswith('native/system/packages/') and '/bin/' in name:
        package = name.split('/')[3]
        if package not in platform:
            continue
    # Windows resolves native dependencies with pnpm on the user's machine.
    if target == 'win32-x64' and source.suffix == '.node':
        continue
    if not source.is_file() or source.name.endswith(('.map', '.tsbuildinfo')) or name == 'audit.allowlist.json':
        continue
    parts = Path(name).parts
    if any(p in parts for p in ['tests', 'stress-tests', 'snapshots', '__snapshots__', '.agents', '.github', 'benchmarks']):
        continue
    if name.startswith(('website/', 'python/')) and name not in ['website/package.json', 'python/sdk-runtime/package.json']:
        continue
    target_path = stage / name
    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target_path)
    # Bundlers put the checkout path in CSS module region comments.
    data = target_path.read_bytes()
    if str(root).encode() in data:
        text = data.decode('utf-8')
        target_path.write_text(text.replace(str(root), '/workspace/tandem-core'))

manifest = json.loads((stage / 'tandem-install.json').read_text())
manifest['target'] = target
if cross_windows:
    manifest['candidateValidation'] = {
        'host': 'linux',
        'windowsTested': False,
        'notice': 'Untested on Windows. Candidate only; do not add to the installer manifest.',
    }
(stage / 'tandem-install.json').write_text(json.dumps(manifest, indent=2) + '\n')

addon = {'darwin-arm64': 'native/system/packages/darwin-arm64/bin/system.node',
         'darwin-x64': 'native/system/packages/darwin-x64/bin/system.node',
         'linux-x64': 'native/system/packages/linux-x64/bin/glibc/system.node'}
if target in addon and not (stage / addon[target]).is_file():
    raise SystemExit(f'missing target addon {addon[target]}; build native/system on the target runner first')

default_output = root / ('artifacts/candidates' if cross_windows else 'artifacts')
artifacts = (args.output_dir or Path(os.environ.get('TANDEM_ARTIFACT_DIR', str(default_output)))).expanduser().resolve()
artifacts.mkdir(parents=True, exist_ok=True)
archive = artifacts / f'{PRODUCT}-{VERSION}-{target}.tar.gz'
checksum = artifacts / (archive.name + '.sha256')
if any(output.exists() or output.is_symlink() for output in (archive, checksum)):
    raise SystemExit(f'refusing to overwrite existing archive/checksum in {artifacts}; select a new --output-dir')

# Build on the destination filesystem, then publish each complete file exclusively.
# os.link is atomic and never replaces an existing name, including a concurrent writer's.
with tempfile.TemporaryDirectory(prefix=f'.{PRODUCT}-output-', dir=artifacts) as temporary:
    output_stage = Path(temporary).resolve()
    temporary_archive = output_stage / archive.name
    temporary_checksum = output_stage / checksum.name
    with tarfile.open(temporary_archive, 'x:gz') as bundle:
        bundle.add(stage, arcname=stage.name)
    digest = hashlib.sha256(temporary_archive.read_bytes()).hexdigest()
    with temporary_checksum.open('x') as stream:
        stream.write(f'{digest}  {archive.name}\n')
    published = []
    try:
        for source, destination in ((temporary_archive, archive), (temporary_checksum, checksum)):
            os.link(source, destination)
            published.append((source, destination))
    except OSError:
        for source, destination in published:
            # Remove only this invocation's new hardlink, never a pre-existing file.
            assert destination.is_absolute() and destination.parent == artifacts
            if destination.is_file() and destination.samefile(source):
                destination.unlink()
        raise
print(f'{archive.name}: {archive.stat().st_size} bytes; sha256 {digest}')
