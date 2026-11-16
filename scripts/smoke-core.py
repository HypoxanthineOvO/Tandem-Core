#!/usr/bin/env python3
"""Compatibility entry point for the cross-platform Core package smoke."""
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
archive = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / 'artifacts/tandem-core-0.1.0-linux-x64.tar.gz'
subprocess.run(['node', str(root / 'scripts/smoke-core.mjs'), str(archive)], check=True)
