---
description: "在输入框工具条中显示工作/直接两种会话模式，并支持切换。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-mode

[English](README.md) | 中文

## 概述

本包在输入框工具条中渲染会话模式 chip。它读取 Host 计算的 `sessionMode` 投影，显示当前模式（工作模式或直接模式），并通过 `sessionMode` Remote 切换。新会话默认工作模式。在可继续的子代理会话里不显示该 chip，那里的行为由派活提示词决定。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web bundle 包含本插件。本包没有配置字段。

chip 显示 `工作模式` 或 `直接模式`。点击选择另一种模式；Host 调用进行中 chip 保持禁用，只有推回的投影帧确认记录后才重绘。切换被拒绝或失败时，显示的模式保持不变，chip 旁出现一行简短失败提示。

模式是 Host 的持久状态，不是客户端偏好。工作模式下主线负责拆解、派活，再汇总和核对结果；直接模式下主线自己完成任务。Host 在下一次受理请求时追加模型可见的模式通知，因此会话中途切换不会改动系统提示或工具列表。

通过 profile patch 停用以下条目即可移除 chip：

```yaml
- id: ui-session-mode
  disabled: true
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>内部实现 — 点击展开</summary>

浏览器入口通过 `ctx.slots.inject()` 向 conversation 声明的 `conversation.input.left` 列表 slot 注册一个组件。组件用标准 `useProjection('sessionMode')` 读取当前模式；会话快照带子代理地址时隐藏，`useAccess('sessionMode/set')` 拒绝当前 Peer 时禁用。inject face 调用 `remote.sessionMode.set({ sessionId, mode })`，业务失败转成组件内的失败提示。组件不在本地猜测目标模式：投影是唯一权威。

注册与字典随插件 fiber 卸载。本包不拥有缓存、订阅、轮询或持久状态。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [计划模式控件](../ui-plan/README.zh.md) — 同样是基于 Host 投影的输入框 chip。
- [权限预设](../ui-permission-presets/README.zh.md) — 同排的输入框触发器及其收起规则。
- [Session Controller](../../api/session-controller/README.zh.md) — Host 的 `sessionMode` Remote 与投影。

-----

<a id="model-experience"></a>
## 模型体验

chip 本身不改变任何模型请求。模型可见的效果由 Host 负责：记录切换后，下一次受理请求会追加一条 user 角色的模式通知，例如 `[模式：直接模式。从这里起由你自己完成任务。]`。通知只说明会话策略；工具、预设和系统提示都不变。

#### KV Cache effect

切换那一步没有影响。通知追加在已缓存前缀之后，系统提示与工具列表不变，因此会话中途切换模式不会让命中率归零。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 控件是两态开关，不是选择器。以后新增第三种模式需要菜单和更宽的投影。
- 按设计不在可继续的子代理会话中显示；那些会话运行随模式一起下发的派活提示词。
- 第一帧投影到达前，chip 显示工作模式，与 Host 默认一致；它无法区分没有该能力的旧 Host。
- 口令切换（`切到直接模式` / `切到工作模式`）由 Host 在受理提示时识别，不在本包内；chip 只反映随之而来的投影。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

chip 占用空闲的 `conversation.input.left` 列表，与权限、计划两个座位同排。它刻意不放进 `conversation.input.model`：模型座位是模型选择拥有的单选表面，而模式是独立的策略控件。标签在共享的 460px 容器查询下收起，保证 420px 窄屏内输入框行不会溢出。

</details>
