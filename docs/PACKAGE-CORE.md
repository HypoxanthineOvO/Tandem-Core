# Core archive directories (reference)

[`scripts/package-core.py`](../scripts/package-core.py) packages the checkout's tracked source and existing built assets. Build the CLI/Web assets and target native addon before packaging a native release. Darwin archives require a macOS host; Windows releases require a Windows host.

```sh
python3 scripts/package-core.py linux-x64 --stage-dir /tmp/tandem-stage --output-dir /tmp/tandem-artifacts
```

`--stage-dir` selects the parent of a uniquely named temporary directory, removed when the packager exits. It defaults to `.release-stage` in the checkout. The parent itself is retained. `--output-dir` selects the exact archive/checksum directory and takes precedence over `TANDEM_ARTIFACT_DIR`; both support absolute paths, relative paths (from the calling directory), and `~`. Without either output override, native archives go to `artifacts/` and cross-Windows candidates go to `artifacts/candidates/`.

```sh
TANDEM_ARTIFACT_DIR=/tmp/tandem-candidates python3 scripts/package-core.py win32-x64 \
  --allow-cross-windows-candidate --stage-dir /tmp/tandem-stage
```

An existing archive or `.sha256` file causes packaging to fail without changing either file. Choose a fresh `--output-dir` for another build; there is no implicit overwrite option. Archives and checksums are completed in a unique temporary directory on the output filesystem and published with exclusive atomic hardlinks. A concurrent output-name collision fails instead of replacing another invocation's files; a filesystem without hardlink support fails without overwriting them.

The cross-Windows option is Linux-only and excludes all `.node` files. A custom output directory never removes the archive's `tandem-install.json.candidateValidation` marker: `windowsTested` remains `false`, and the notice prohibits adding an untested candidate to the installer manifest. Windows runtime dependency installation and lifecycle verification remain separate requirements; naming an output directory does not validate or publish a release.
