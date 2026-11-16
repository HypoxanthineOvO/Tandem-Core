---
description: "主线会话连续性的纯版本化账本模型、回流分类与确定性固定区渲染。"
kind: "package-library"
---

# @deepseek-ai/dsh-continuity

[English](README.md) | 中文

## 摘要

`dsh-continuity` 把主 Session 日志中的 continuity 事件折叠成版本化账本，并推导连续性所需的决定：乐观提交、主线账面字段分类、defer/wake 回流、受管副作用授权，以及账本 checkpoint 使用的确定性固定区。包为纯 TypeScript：不注册插件、不持有可变状态、不调用模型；Session、锁、持久化与投递由运行时使用方拥有。

## Model Experience

#### 模型看到的内容

账本 checkpoint 使用确定性固定区。`renderPendingDecisions(state, items, limits)` 单独渲染中文待带入通知，包含原决议版本、字段名、改动前后的值、原因和来源支线；提案明确标为尚未采纳。它按事件 ID 查原始决议，不用收件箱摘要或当前字段值代替。

#### Token 影响

通知中的值和原因先脱敏，再以 `…（已截断）` 标明截断，不拆开代理对。敏感字段路径与嵌套凭据属性整体替换；凭据赋值、Bearer/Basic 授权、带特征前缀的 token 和 URL 凭据使用 `[已脱敏]`。这些展示规则不改原始账本或固定区渲染；账本不用于存放凭据。调用方提供单值和完整通知的 UTF-16 字符上限。决议按顺序整条装入一批，并预留中文剩余条数提示；返回值只包含本批实际展示的 inbox ID。单条决议仍放不下或缺少原始详情时明确报错，不生成残缺决议。固定区的 token 成本由压缩预算控制。

#### KV Cache 影响

通知追加到对话，不改变系统提示或工具声明。固定区按账本状态和 renderer 版本确定性渲染；新版本有意替换 checkpoint，同一版本保留相同文本与哈希。

## 已知限制与后续工作

- **运行入口**：消费者导入 `@deepseek-ai/dsh-continuity`，在源码工具之外解析到构建后的 JavaScript；运行时包不要导入 `/src/*`。源码工具通过生成的 `tsconfig` 别名解析公共入口；本包还启用 `erasableSyntaxOnly`，拒绝参数属性、枚举和含运行值的命名空间。
- **不含运行时职责**：持久化、锁、唤醒、待阅投递和 Teams 集成在消费包中。
- **启发式 token 计价**：在接入精确 tokenizer 前使用 4 字符/token 的共享密度。

## Source map

| 文件 | 职责 |
|---|---|
| [`src/types.ts`](src/types.ts) | 账本值与持久 `continuity/*` Session 事件 |
| [`src/ledger.ts`](src/ledger.ts) | 乐观提交、重放折叠、分类、读集合、副作用 |
| [`src/render.ts`](src/render.ts) | 确定性固定区渲染与文本 token 估算 |
| [`src/pending.ts`](src/pending.ts) | 有字符上限、经过脱敏的待带入决议通知 |
| [`tests/ledger.spec.ts`](tests/ledger.spec.ts) | 幂等、冲突、分类、授权、渲染 |
