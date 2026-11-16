---
description: "基于 waterfall 的问答服务，用于工具、权限插件、本地 answerer 与 Agent-scoped Web 交互。"
kind: "package-reference"
---

# @deepseek-ai/dsh-user-questions

[English](README.md) | 中文

## 概述

当工具或权限流程需要用户提供结构化答案时，使用 `ctx.userQuestions`。`ask()` 会等待回答；`askTimed()` 可以放行 agent 继续独立工作，而问题仍留在会话中供用户回答。

## 目录

- [提出问题](#service-userquestionservice-ctx-key-userquestions)
- [职责](#role)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="service-userquestionservice-ctx-key-userquestions"></a>
## 提出问题

`attachSessionWait(sessionId, callId, signal)`、`stageSessionAnswer(sessionId, callId, answer, expectedRevision, signal)` 与 `submitSessionBatch(sessionId, callId, submission, signal)` 让浏览器操作直接寻址 Session，不经过通用 Agent lookup。它们通过可选的 `sessionAgentAcquisition` 服务持有特殊所有者；普通根仍使用已配置的 Agent 解析器。所有路径执行同一套存活调用方准入与提交检查。stream 持有驻留直到关闭；单次调用在 `finally` 释放。subagent 提供方恢复真实父链，不因此授予 worker 人机交互权限。

当工作无法在没有答案的情况下继续时调用 `ask()`。当 agent 可以在一段前台等待后继续独立工作时调用 `askTimed()`。回答 UI 通过 `attachWait` 接手等待，取得 Host 计算的剩余时长，并用本地时钟倒计时。没有接手方时，包括最后一个 Client 断开之后，服务在原 deadline 放行模型。`userQuestions` projection 从工具调用、其结果和最终回复派生持久问题；Client 接手状态不落盘。

对于单选题，`custom` 会覆盖选中的选项，且 `selected` 为空。对于多选题，`custom` 可以补充 `selected` 中的标签。UI 可以把跳过的条目保留为 `{ id, selected: [] }`，既维持现有回答形态，也保留该批次中的其他回答。

问题可以携带呈现意图 `intent`，声明它就是某种已知决策，识别该标记的 UI 可以按该决策呈现；目前唯一的标记是 `plan-review`，其 `detail` 是待审阅的计划，`approve` 指明表示同意的选项。意图只改变呈现：遵循它的 UI 回答的选项标签与通用 UI 相同，不认识该标记的 UI 则渲染通用选项列表。`ask()` 会以 `BAD_INTENT` 拒绝两种类型无法表达的断言：`approve` 未命名该问题自己的任何选项，以及没有 `detail` 的问题声明了意图。`dsh-plan-mode` 在 `exit_plan_mode` 的审阅问题上设置它。

请求携带 agent 时，每次提问、回答、附着等待、暂存和提交都验证它是否为注册表中的精确存活实例。没有 `humanInteractionPolicy` 时仅允许运行时根调用。可选提供方继承 `HumanInteractionPolicy`，根据 `{ agent, session, isSubagent, parentChain }` 决策；`check()` 返回 `{ allowed: true }` 或 `{ allowed: false, reason }`。`parentChain` 从直接存活父级排到根。设置 `userQuestions.config.requirePolicy: true` 后，缺少提供方会拒绝交互。仅在没有安装或要求策略时，才允许不带 agent 的本地请求。

携带 `wait.callId` 的调用用 `stageAnswer(agent, callId, answer, expectedRevision?)` 持久暂存逐题答案，再用 `submitBatch(agent, callId, { answers?, expectedRevision? })` 提交唯一的完整批次。省略 answers 会提交暂存答案；空 selected 且没有 custom 表示明确跳过该题。版本过期返回 `conflict`；批次被接受后，重复提交（含另一面板）返回 `already-submitted`。服务先 flush 接受记录，再 resolve 前台等待，或将 `user-question-reply` steer 给精确的提问 agent。超时或重启后不重建 Promise，提交改走同一 agent 的 inbox。原生 RPC 解析必须沿真实父链恢复它，不能创建无关的根。`acceptedAt` 记录接受时间；`deliveredAt` 来自工具结果或获准的用户消息。投递错误保持可见；Agent 重建时会恢复尚未送达的已接受批次。重新激活保留 `continued`、`partial` 的版本与暂存答案；仅仍为 open 的前台等待记录一次转为 `continued` 的变更。

<a id="role"></a>
## 职责

`userQuestions` projection 折叠工具调用与结果、PTC 子调用、获准的回复和 `user-question/batch` 版本，不另存一份问题状态。`query(session)` 返回批次；`listQuestions(session)` 按 sessionId/callId/questionId 返回逐题记录，包含文本、选项、多选与自定义开关、暂存答案和投递事实。`queryTree(rootSessionId, sessions)` 按完整持久父链过滤调用方提供的 Session，支持不唤醒模型的 detached 读取。`subscribe(listener)` 观察已提交的投影变化并返回取消订阅函数；调用方负责释放。旧 `answer` RPC 为既有消费方保留仅处理 continued 的布尔行为；新浏览器面板的前台和 continued 答复都使用 `submitSessionBatch`。

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-ask-user`：它会将成功回答保留为紧凑 JSON，或返回以下失败之一：`Error: ask_user_question was aborted before the user answered`、`Error: ask_user_question requires at least one question`、`Error: human interaction requires the exact live calling agent when an agent is supplied`、`Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result`、`Error: no user-questions answerer accepted the request` 或 `Error: <message>`。等待人类回答不会增加 token。

#### KV Cache 影响

不会直接使 KV Cache 失效；请求前缀的任何变更均由上述消费方负责。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **带 Agent scope 的 Web 回答**：Remote Events 仅在请求带有存活 Agent scope 时路由随产品交付的 Web 回答者；agentless 调用方需要本地未限定 scope 的 waterfall listener。
- **词汇仅包含问题表单形态**：可供选择的选项加可选的自定义文本；更丰富的交互形态（文件选择器、diff 预览确认）尚无 seam 词汇。
- **未暂存的输入仍在本地**：`stageAnswer` 让明确暂存的逐题答案跨重启和客户端保留；消费方没有暂存的按键输入仍只存在浏览器中。没有持久化服务的 detached Session 仅提供内存中的接受记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 唯一投影从会话日志派生全部问题。重复提交已接受批次不会产生第二条回复。已继续的答复可以创建新轮次，但不会改写已结束的工具结果。
