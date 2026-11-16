# Tandem Core

Tandem Core is the agent-harness fork maintained for Tandem multi-model agent teams.

This is an independent fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), not an official DeepSeek product. DeepSeek AI's MIT license, third-party notices and brand guidelines remain in this repository. Internal `@deepseek-ai/*` workspace names and the `dsh` command remain unchanged for compatibility.

[中文](README.zh.md) · [Install](docs/INSTALL-CORE.md) · [Patch inventory](docs/TANDEM-PATCHES.md) · [Upstream](UPSTREAM.md)

## Run

Download the platform archive `tandem-core-0.1.0-{linux-x64,darwin-arm64,darwin-x64,win32-x64}.tar.gz` and follow [INSTALL-CORE.md](docs/INSTALL-CORE.md). Use your own provider credentials; this package includes no private provider gateway, accounts or deployment configuration.

## Develop

Requires Node.js 24 and pnpm 11.28.5. Native system builds require a C compiler; Linux full native packaging also needs musl-gcc.

```sh
pnpm install --frozen-lockfile
pnpm run build
node apps/cli/lib/bin.js web --no-open
```

Read [SAFETY.md](SAFETY.md) before running agents and [architecture](docs/architecture.md) before extending the core. Configuration and plugin architecture are documented in the retained upstream documentation.

## License

[MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [BRAND_GUIDELINES.md](BRAND_GUIDELINES.md).
