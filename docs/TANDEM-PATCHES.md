# Tandem Core patch inventory

This reference groups the imported changes relative to `6d64d332f06fe1454059270f20c8d4f67db71876`. The local source was integration commit `2501530c` plus pending image and subagent-control fixes. `UPSTREAM.md` records source hashes and the snapshot-history decision.

## Runtime and APIs

| Group | Core ownership | Scope |
|---|---|---|
| Shared subagent delegation | `packages/subagent/subagent-delegation`, `subagent`, `tool-subagent`, `tool-subagent-control`, `subagent-fork-in-process` | Shared policy registration, provider/model and preset selection, prepared single-use activation, native admission, true descendant control, parent settlement, request-route attribution and continuity. |
| User-question admission | `packages/interaction/user-questions`, `tool-ask-user`, `packages/client/ui-user-questions` | Execution-time question policy, batch answers with distinct pending/skipped/answered states, projections and question composer. |
| Work/direct modes | `packages/api/session-controller/src/mode.ts` and session command/controller consumers | Session-mode selection, logged mode notices, main-thread-only switching; mode does not replace the system prompt or tool list. |
| File links | `packages/client/file-links` | `chatPathMentions` enables chat-path recognition for external sidebar and file-opening consumers. |
| PTC/workflows | `packages/workflow`, `packages/ptc-runtime` and tool consumers | Workflow dispatch, presentation and execution integration retained from the integration fork. |
| Image handling | `packages/attachment/attachment-local`, `packages/llm/llm-pi-ai`, `packages/experimental/cua` | Request-image normalization, provider/model byte and dimension limits, replay-safe image adaptation, large computer-use images. Newly imported `image-limits.ts` and its fixture/spec are included. |
| Retry and session acquisition | `packages/core/agent-loop`, `packages/core/agent`, session controller | Failed-input retry, queued attachments and ownership-aware live session acquisition. |

## Client and composition

Preset display metadata and icons, queue display, subagent header configurability and settings, question panels, and dollar-math compatibility are retained in their owning client packages. Base bundle and compiler references register the shared delegation service. Internal workspace names remain unchanged.

## AgentTeams dependencies

AgentTeams integrates through these Core seams; it does not require the removed private deployment layer:

- `@deepseek-ai/dsh-subagent-delegation`: `ctx.subagentDelegation` policy registration and shared selection/preparation/start flow, with the native activation/admission checks still authoritative.
- `@deepseek-ai/dsh-subagent`: `ctx.subagents` activation/control/tree access, live parent ownership and settlement; optional route-equivalence service for policy-owned selected-versus-actual model attribution.
- `@deepseek-ai/dsh-user-questions`: execution-time question admission and batched question/answer projection. The `user-question/batch` durable event is required data; old cores cannot safely reopen these sessions.
- Agent/session APIs, `agent/request` middleware, settings registration and reversible Cordis effects for role/model selection and task-local routing policy.
- Session-controller mode and command APIs, session projections, and subagent continuity interfaces for human intervention and bringing confirmed branch decisions back to the main thread.
- Client `file-links.chatPathMentions` and configurable subagent header presentation for the companion sidebar.

## Cross-platform Web distribution

The Web archive is built on its target runner and includes shared CLI/Web assets plus only that target's native payload. Linux carries glibc/musl flock addons and Landlock; macOS carries its matching Mach-O flock addon; Windows uses the existing Windows lock provider and no system addon. The supported Windows launch command is `node apps/cli/lib/bin.js web`; the POSIX `bin/dsh` wrapper is not used by PowerShell installers. The Web package workflow excludes the Electron Desktop workspace.

Windows runtime paths use Node path APIs in the inspected CLI and profile code; native Windows `pwsh` and the existing `tool-pwsh` composition are enabled by the default preset. `node-pty` supplies the Windows ConPTY prebuild and `koffi` remains a feature dependency. Server smoke shutdown uses Node child-process termination and removes only its own temporary directory. Long-path behavior still depends on Windows policy and must be verified in CI; installation roots should remain short (for example `%LOCALAPPDATA%\\tandem-core`).

## Snapshots and generated files

Recorded session snapshots under `snapshots/`, owner-local `__snapshots__`, expected outputs, persistence schema/catalog changes, bilingual metadata, tool/config catalogs, and the question-batches/shared-delegation upgrade guides are retained separately from runtime code. They document the fork's session format and visible output; they are not credentials or runtime state. The source archive retains test fixtures; the prebuilt runtime package excludes test snapshots.

## Distribution-only changes

Root/CLI version is `0.1.0`; the root product is Tandem Core and the CLI stays `dsh`. README documents the independent fork and upstream attribution. The private `hypo/` tree (portal, login, proxy, account sync, personal presets, deployment and reports) is removed. Provider-specific personal names in synthetic settlement tests are replaced by neutral test identifiers. No production configuration or provider credentials are included. The SDK client version is also `0.1.0` because its subprocess launcher enforces equality with the CLI version.

## Known test adjustments

The original integration state reproduced 11 failures with byte-identical runtime and test files and its original CLI/SDK metadata. Runtime semantics are unchanged by this release cleanup.

1. `agent-loop/interception`: a failed first input remains queued before the adjacent second input; the expected queue now includes both.
2. `agent-loop/loop`, strict-variable assembly failure: recovery replays the original input and then runs the new prompt. The fixture supplies two replies and expects two requests/three balanced turns.
3. `agent-loop/loop`, failed pre-step with steering: recovery likewise retains the original prompt and later steering; the fixture supplies two replies and expects the replay plus the new prompt.
4. `agent-loop/loop`, pre-step listener failure: the subsequent wake processes the retained first prompt before the second prompt; both receive mock replies.
5. `agent-loop/resource-lifecycle`, two loop and root cases: the fixture now mounts the required shared delegation service. The root case passes; the separate loop-only queue cancellation assertion remains unresolved below.
6. `agent-loop/serial-listener-review`: the shared-preset tool-installation fixture now mounts the required delegation service so the intended duplicate-tool failure can actually execute.
7. `subagent/continuation`, cold routeless resume: request middleware supplies a test adapter route without inventing a persisted descriptor model route.
8. `subagent/continuation`, routeless image queue: the initial fixture turn uses a middleware-resolved mock route, while the descriptor remains routeless and queue admission still avoids a model-capability lookup.
9. `subagent-dsh-sdk`: CLI and SDK metadata share version `0.1.0`; no launcher compatibility check is bypassed.

### Remaining inherited failures

- Loop-only teardown does not emit the queue-cancellation splices expected by its lifecycle test, although root teardown passes.
- A checkpoint error before the first step retains the pending human input for retry; the old continuation test waits for an activation settlement that never arrives while that input remains parked.
- A parent reopened after teardown still exposes a subagent settlement notice where the old continuation test expects an empty result.
- The minimal remote-access source-attribution fixture records additional recovery inbox splices beyond its two accepted prompts; visible/model-input duplication is not yet established, so the original assertion remains.

Reproduction conditions, impact and baseline comparison are recorded in [KNOWN-ISSUES.md](KNOWN-ISSUES.md). Their assertions remain failing tests. Independent review assigns publication severity.

## 如何合并上游（维护教程）

本仓库从本地 `Hypo-DSH-Core` 的 `d6e2fdfc05a24d6bfacdf3181a72e418dbfee444` clone，保留其历史。所记录的上游基准 `6d64d332f06fe1454059270f20c8d4f67db71876` 在公开上游未必可达；不要假定 snapshot 与公开分支有共同祖先。插件、providers、proxy 的产品逻辑留在 Tandem 主仓库，Core 只维护必须修改框架的接口与上述既有补丁。

1. 在干净工作树上记录 `git rev-parse HEAD`，用 `git branch backup/tandem-before-upstream` 保留当前点；工作中的修改先独立提交，不覆盖未提交文件。
2. 在单独的维护 clone 中获取上游：`git fetch https://github.com/deepseek-ai/deepseek-harness.git <upstream-ref>`，记下 `FETCH_HEAD` 的完整 hash。此命令不新增或修改 remote；本文步骤没有在本次整合中执行。
3. 用 `git merge-base HEAD FETCH_HEAD` 检查共同祖先。若可达，在新分支执行 `git switch -c integrate/upstream` 后 `git merge --no-ff FETCH_HEAD`；私有、尚未共享的维护分支也可选择 `git rebase --onto FETCH_HEAD <verified-old-upstream-base>`，但不得重写已共享或本次保留的来源历史。冲突逐项对照上表，失败可用 `git merge --abort` 或 `git rebase --abort` 回到备份。
4. 若没有共同祖先，不做盲目的 `--allow-unrelated-histories` 或把整个 snapshot 当作一个 rebase 补丁。先确认旧基准的源码来源，在新的上游 checkout 中按上表逐项移植必要接口补丁；用文件差异、测试与 session-format 记录核对。人工建立并审查新的基准说明后，再作为独立维护分支继续，不删除旧 clone。
5. 更新 `UPSTREAM.md` 和本清单中的基准、保留/移除的补丁，运行 `pnpm install --frozen-lockfile`、`pnpm run typecheck`、`pnpm run build` 及相关测试。对照 `KNOWN-ISSUES.md` 的四个既有失败，不压制断言；使用 Tandem 插件执行隔离安装与加载冒烟。
6. 审查后本地提交；构建新的平台包、更新主仓库 manifest 的 sha256 与 Release URL。推送、正式发布及线上切换另行授权。

## Tandem Web branding

The Web product name is **Tandem**, with **Work in tandem.** as the English and Chinese home headline. The home attribution reads **Built on DeepSeek Harness** (Chinese: **基于 DeepSeek Harness 构建**) below the headline, without a Preview badge. The sidebar keeps the version as secondary text. LICENSE, NOTICE and upstream copyright notices remain unchanged.

The upstream [English](../BRAND_GUIDELINES.md) and [Chinese](../BRAND_GUIDELINES.zh.md) guidelines allow accurate relationship attribution, recommend (but do not require) the DSH abbreviation, prohibit the full DeepSeek Harness trademark as a fork project name, and restrict official artwork that implies endorsement. They do not separately ban all whale imagery. Tandem uses its own approved tandem-T mark for the sidebar, home, running status, wordmark, browser and installed Web app instead of upstream artwork.

| Files | Branding ownership |
|---|---|
| `packages/client/locale/src/locales/{en,zh}.ts` | Tandem product name; the existing locale key remains stable. |
| `packages/client/ui-brand-official/src/client/{Brand.tsx,index.ts}` and `tests/browser-plugin.client.spec.tsx` | Legacy official-profile brand slot occupants use the Tandem artwork. |
| `packages/client/ui-primitives/src/{FishLogo,BrandWordmark}.tsx` and paired README files | Tandem vector artwork reconstructed from promo `tandemT` geometry; legacy export names remain compatible with plugins. |
| `packages/client/ui-conversation/src/client/locales.ts`, `skeleton/EmptyHero.tsx`, `skeleton/HeroShell.module.css` | Headline, quiet upstream attribution and static Tandem mark; removes whale morphs and Preview pill. |
| `packages/client/ui-chat/src/client/chat/{RunningWhaleTail.tsx,ChatView.module.css}` | Running status uses the shared Tandem mark; no whale mask is referenced. |
| `apps/web/{index.html,vite.config.ts}`, `apps/web/public/{favicon.svg,favicon-dark.svg,favicon.ico,apple-touch-icon.png,tandem-icon-*.png,manifest.webmanifest}` | Document title, theme-independent vector favicons, PNG icons (16/32/48/64/180/192/512), ICO and install metadata. Raster sizes derive from the approved transparent 512px promo icon. |
| `scripts/client-build-environment.ts` | Both default and legacy `official` build profiles resolve the Tandem title. |
| `packages/client/ui-settings-models/src/{onboarding-copy.ts,client/locales.ts}`, account and onboarding locales, plugin-manager locales, and Office preview locales | Tandem welcome and product self-references; DeepSeek account remains the upstream account service. The material welcome change has its own acknowledgement version. |
| Owner-local tests in ui-primitives, ui-chat, ui-sidebar, ui-layout, ui-conversation and `apps/web/tests/` | Updated brand assertions, selectors and owner-local browser snapshots; account/onboarding text snapshots and browser fixture welcome metadata match the Tandem copy. |

Electron packaging and unrelated website artwork are outside this Web patch. No desktop icon resources are referenced by the Web build. Internal package names, CLI commands and persistence identifiers remain unchanged. Keep this patch isolated when merging upstream; preserve the generic branding slots and legacy primitive exports.

首页 golden 同时反映已有的 Work/Direct 模式按钮，为既有 baseline 输出。The five home goldens and the welcome-dialog golden are refreshed with the new branding. Unrelated tool-schema and non-home UI golden drift remains unchanged; the voice-input replay also encounters that existing tool-schema pin mismatch. The assembled-boot mock still lacks the `subagents/continuityStatus` endpoint. These are recorded validation leftovers, not branding behavior changes.
