# Install Tandem Core 0.1.0

## Prebuilt Web packages

Core ships a separate archive for each native target: `tandem-core-0.1.0-linux-x64.tar.gz`, `tandem-core-0.1.0-darwin-arm64.tar.gz`, `tandem-core-0.1.0-darwin-x64.tar.gz`, and `tandem-core-0.1.0-win32-x64.tar.gz`. The `apps/cli/lib/` files and `apps/web/dist/` assets are platform-independent JavaScript/static assets, but the system addon is a platform-specific ELF or Mach-O binary. Linux CI packages carry glibc and musl flock addons plus the static `landlock-run` executable. A local Linux package can carry only the available glibc addon; without `landlock-run`, Landlock reports unusable and Web startup still works. macOS packages carry their matching Mach-O addon. Windows uses the Harness's built-in Windows locking implementation and carries no `system.node`.

The archive root is always `tandem-core-0.1.0/`. Each archive has a sibling `.sha256` file. Use Node.js 24 and pnpm 11.28.5; unpack into a new directory and run:

```sh
pnpm install --filter @deepseek-ai/dsh... --frozen-lockfile --ignore-scripts
```

This installs the CLI's complete workspace dependency closure without the Desktop workspace or its Electron runtime. `--ignore-scripts` prevents native source-build fallbacks: esbuild's `@esbuild/<platform>` package, sharp's `@img/sharp-<platform>` and libvips packages, and Koffi's `@koromix/koffi-<platform>` package are selected through optionalDependencies. The `node-pty` package carries platform prebuilds; its installer otherwise checks for them and falls back to node-gyp. Run the packaged `packages/subprocess/subprocess-local/scripts/ensure-spawn-helper.mjs` after install; it restores the executable bit used by the macOS PTY helper. These dependencies affect build, image, FFI, and PTY features respectively; missing them does not prevent the Web listener from serving its page. Rust/Cargo is not used by consumers.

On Linux/macOS, a convenience wrapper is available as `bin/dsh`. On native Windows, invoke Node directly; this avoids shell-wrapper and PATH differences:

```text
node apps/cli/lib/bin.js web --host 127.0.0.1 --port 3080 --no-open
```

Set `DSH_HOME` to a Core-specific location before launch, for example `$HOME/.local/share/tandem-core` on Linux/macOS or `$env:LOCALAPPDATA\\tandem-core` on Windows. Open `http://127.0.0.1:3080` and stop the process with Ctrl-C. `DSH_TELEMETRY_DISABLED=1` is only needed by automated smoke tests.

Configure your own provider and API key in the application. No model request is needed just to start the Web interface. This artifact includes the Tandem Core AgentTeams APIs but not the Electron desktop application or companion Sidebar. Keep the listener on loopback unless you have configured authenticated remote access.

## Native dependency matrix

| Dependency | Linux x64 | macOS arm64/x64 | Windows x64 | Effect when unavailable |
|---|---|---|---|---|
| `@deepseek-ai/node-addon-system` | Linux glibc/musl `system.node`; CI also includes `landlock-run` | Matching macOS `system.node` | Not used; Harness Windows locking applies | Missing POSIX addon breaks session locks; missing Landlock disables Linux confinement and reports unusable. |
| `node-pty` | npm package host prebuild; postinstall restores helper mode | npm package host prebuild; helper mode restoration matters to PTY use | npm package host ConPTY prebuild | Affects interactive terminal/PTY tools, not Web page startup. |
| `koffi` | `@koromix/koffi-linux-x64` optional package | Matching `@koromix/koffi-darwin-arm64` or `@koromix/koffi-darwin-x64` package | `@koromix/koffi-win32-x64` optional package | Used by selected system integrations, not the Web server listener. |
| `sharp` | `@img/sharp-linux-x64` and libvips optional packages | `@img/sharp-darwin-arm64` or `@img/sharp-darwin-x64` plus libvips | `@img/sharp-win32-x64` and libvips optional packages | Image processing paths fail when invoked; Web server startup does not require image decoding. |
| `esbuild` | `@esbuild/linux-x64` optional package | `@esbuild/darwin-arm64` or `@esbuild/darwin-x64` | `@esbuild/win32-x64` optional package | Build-time only; prebuilt Core does not build Web assets at install. |
| Electron | Excluded with filtered install | Excluded with filtered install | Excluded with filtered install | Desktop-only; not needed by `dsh web`. A full unfiltered install also downloads Electron and builder dependencies. |
| Other native optional packages | Platform packages selected by npm/pnpm for enabled feature dependencies | Same, for the host triplet | Same, for win32-x64 | CUA, LibreOffice and provider runtimes affect those features only; they are not required to serve the prebuilt Web UI. |

The workspace uses pnpm's reviewed `allowBuilds` policy. `--ignore-scripts` suppresses lifecycle native-source builds/download fallbacks; the required C Node-API addon is already included in each supported archive. Do not use `--prod`: this workspace resolves runtime peers through the CLI's development links.

## Build from source

A source build requires the platform's native C/C++ toolchain; Linux additionally needs musl-gcc for Landlock, and macOS uses the system compiler for its addon. Build the CLI and Web assets with `pnpm run build`, then run `node apps/cli/lib/bin.js web --port 3080 --no-open`. Native platform archives must be built on their matching native runners; Windows is not supported through WSL for this package workflow.
