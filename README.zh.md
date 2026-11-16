# Tandem Core

Tandem Core 是 Tandem 多模型 Agent 团队使用的核心框架。

本项目 fork 自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，是独立维护的非官方版本。保留 DeepSeek AI 的 MIT 许可证、第三方声明及品牌规范。为减少兼容性改动，内部 `@deepseek-ai/*` 包名与 `dsh` 命令不变。

[English](README.md) · [安装](docs/INSTALL-CORE.md) · [补丁清单](docs/TANDEM-PATCHES.md) · [上游记录](UPSTREAM.md)

## 运行

下载对应平台的 `tandem-core-0.1.0-{linux-x64,darwin-arm64,darwin-x64,win32-x64}.tar.gz`，按[安装说明](docs/INSTALL-CORE.md)操作。模型服务使用你自己的凭据；本包不含私人渠道网关、账号或部署配置。

## 开发

需要 Node.js 24、pnpm 11.28.5；构建系统原生组件需要 C 编译器，Linux 完整原生包还需要 musl-gcc。

```sh
pnpm install --frozen-lockfile
pnpm run build
node apps/cli/lib/bin.js web --no-open
```

运行前阅读[安全说明](SAFETY.zh.md)，扩展核心前阅读[架构](docs/architecture.zh.md)。仓库保留的上游文档说明配置及插件体系。

## 许可证

[MIT](LICENSE)。另见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [BRAND_GUIDELINES.md](BRAND_GUIDELINES.md)。
