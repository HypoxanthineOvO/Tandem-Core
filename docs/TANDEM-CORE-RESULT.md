# Tandem Core 0.1.0 Web package result

## Linux package

- Frozen archive: `artifacts/tandem-core-0.1.0-linux-x64.tar.gz` (43,294,211 bytes), SHA-256 `3b55ab3cb12b7c64f976273c55b901a4d280d6708a5aef1f21e82948fb282517`. This artifact was left unchanged while the install-script executor tested it.
- Native-lock candidate: `artifacts/candidates/flock-smoke-20261115/tandem-core-0.1.0-linux-x64.tar.gz` (43,294,857 bytes), SHA-256 `9b0ed1e2dfe92c454514086a37b83ed9ad17460ee83cd0fdc700d77510024e8a`. Verify from its directory with `sha256sum -c tandem-core-0.1.0-linux-x64.tar.gz.sha256`.
- Target: Linux x64 glibc with the existing Node-API v8 flock addon. The candidate loads `system.node` from the extracted install and successfully acquires a real flock. It has no Landlock executable; its probe reports unusable. CI builds the complete static launcher and musl addon.
- Install: `pnpm install --filter @deepseek-ai/dsh... --frozen-lockfile --ignore-scripts`, followed by `node packages/subprocess/subprocess-local/scripts/ensure-spawn-helper.mjs`.
- Candidate measurement on Node v24.16.0 / pnpm 11.28.5: pnpm reported 1,125 resolved packages, 1,123 reused, zero downloaded, and 12.8 seconds. Install plus postinstall helper took 14 seconds; measured installed tree was 1,389,792,556 bytes. This used a warm local pnpm store; cold network duration and downloaded bytes were not measured. Electron was absent.
- Fresh temp-directory smoke: `dsh web` served authenticated homepage HTTP 200 and `/api/session/list` HTTP 200 on 127.0.0.1:3190. The process exited with code 0 and the owned temporary directory was removed. Port 3081 was not used.

## Platform assessment

The POSIX lock addon is C built against stable Node-API v8 by the host C compiler; the Linux Landlock launcher is also C and statically linked with musl. Neither requires Rust/Cargo for these Core package targets.

`apps/cli/lib/` and `apps/web/dist/` are JavaScript/static assets and can be shared. The native addon cannot: macOS requires a host-built Mach-O Node-API v8 addon per architecture; Linux needs its ELF addon and optionally separate glibc/musl binaries; Windows uses the Harness lock implementation and has no system addon. Archives therefore use native target triplets rather than a universal tarball.

The machine-readable install interface is `tandem-install.json` at archive root. It gives Node major, pnpm version, filtered install args, required postinstall, Node CLI entrypoint, `web` arguments, and `DSH_HOME` environment key. Electron Desktop is excluded by the install filter. `--ignore-scripts` avoids compilation/download lifecycle fallbacks; platform optional packages carry esbuild, sharp/libvips, and Koffi binaries. The node-pty package includes host prebuilds and the explicit helper postinstall restores its PTY helper mode.

## CI and outstanding verification

`.github/workflows/tandem-core.yml` builds on Ubuntu x64, macOS 14 arm64, macOS 13 x64, and native Windows x64 for matching pull requests, main-branch pushes, or manual dispatch. It builds the shared Core/Web output and target native payload, packages the platform archive, verifies the checksum during a clean filtered install, loads POSIX `system.node` and acquires a flock on Linux/macOS, starts the Web app on an available 3190-3199 port, probes homepage and session API, stops the process, and uploads archive plus SHA-256 sidecar. It does not create a Release or publish remotely.

The current host cannot run macOS or native Windows. Verify these on CI: Mach-O architecture for both macOS payloads; native Windows workspace install and Web/API smoke; PowerShell shutdown leaves no child process; package target manifest matches platform; and Windows long-path behavior. The Windows invocation uses `node apps/cli/lib/bin.js`, not the POSIX `bin/dsh` wrapper. Installation roots should remain short under `%LOCALAPPDATA%`.

## Dependency scope

| Component | Delivery and failure effect |
|---|---|
| system addon | Linux glibc/musl and macOS architecture-specific binaries; missing POSIX flock fails lock acquisition. Windows uses its existing implementation. |
| Landlock | Linux static executable, CI-built; missing binary disables confinement and is reported unusable, never replaced by unconfined execution. |
| node-pty | npm platform prebuilds; missing host payload affects PTY/interactive terminal functions, not Web listener startup. |
| sharp / esbuild / Koffi | Platform optional packages; affect image processing, build tooling, or selected FFI features respectively. |
| Electron | Desktop-only and absent from the filtered Web install. |
