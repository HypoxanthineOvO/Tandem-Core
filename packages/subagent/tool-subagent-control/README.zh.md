---
description: "供用户与维护者在组合或调试可继续子级控制功能时使用的全局 send_message、interrupt_agent 与 list_agents 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

[English](README.md) | 中文

## 概述

`dsh-tool-subagent-control` 为可继续子级添加全局控制工具：`send_message` 在同一真实树的可续聊节点之间进行 steering（中途引导），`interrupt` 停止子级当前轮次但保留其收件箱与后代，`list_agents`（来自可单独加载的 `list-agents` 插件）按持久化 ID 与标签列出可继续子级。父级与可继续子级继承相同的 `send_message` 定义和顺序，因此模型通信不会增加子级专属工具 schema。是否加载这些工具不会决定委派工具是否启动可继续工作。

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

在模型需要对可继续子级发消息、中断或列出的任何组合中挂载本包。根插件只需要 subagent 服务；列表工具是独立插件，部署方可以省略。

### 最小配置

先加载 subagent 服务、一个后端、委派工具与本包。加上独立的列表插件即可公开全部三个工具：

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
- name: '@deepseek-ai/dsh-tool-subagent-control'
- name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'
```

根插件提供 `send_message` 与 `interrupt`；配置 `legacyInterruptAgent: true` 会额外注册旧名 `interrupt_agent`，供已有会话使用，默认 false。两个停止工具名执行相同的直接父级检查。列表插件独立提供 `list_agents`。

### send_message

提供 `message`，并在 `agent_id`（精确 id）和 `to`（精确 id、唯一任务 label 或 `parent`/`main`/`self`）中二选一。回复上级用 `to: "parent"`，省略 `agent_id`。空字符串、纯空白字符串和 `null` 视为未提供。两个字段均非空时，必须解析到同一会话；目标冲突或无法解析时在投递前拒绝，并说明收到的值。同树兄弟和更深节点均可通信；他树和不可续聊目标被拒绝。重名返回候选 id 与完整名字分段数组，不猜测。工作中的目标在最近步骤接收消息；空闲目标启动回合。冷目标沿真实父链恢复。结果只用稳定 `messageId` 确认收件，不返回答案。

可选 `kind` 为 `message`（默认）、`question`、`answer`、`report` 或 `result`；`reply_to`、`report_kind` 和 `result_status` 分别携带关联、报告分类和结果状态。`report_kind: human-summary` 只有在 `kind: report` 且 `reply_to` 为核心提醒 id 时，才能越过人工回合返回限制。工具从已记录的调用 id 推导稳定投递 effect，重放不重复唤醒。发送者身份由服务填写，消息不能冒充父级。

### interrupt

外部执行会永久停止，不能接收后续消息。本地目标只停止当前轮次：已排队消息保持暂停，直到之后调用 `send_message`；后代继续运行，子级仍可接受后续消息。调用在停止请求被接受后立即返回，不等待目标完全停稳；已记录但未运行的直接子级返回 `{ accepted: false, reason: 'not-running' }` 及 `agent … is not running; nothing to interrupt`；未知和间接目标即使已卸载仍被拒绝，而自身、同级、陈旧及非直接父级调用方会收到出错结果。

### list_agents

列出调用方 agent 下方的可继续子级：`children`（默认）从父目录读取直接子级，不打开子日志；`descendants` 按稳定前序递归读取子级目录，并为每个条目标注其持久化直接父级会话 ID 与深度。状态来自在线 Agent 注册表——`running` 或 `inactive`。外部条目被省略，不读取子 Session。可读取的一次性子级不出现在输出中，但其目录仍是遍历节点。未知模式与无法读取的子级目录（包括一次性子级）仅在 `descendants` 作用域中以诊断信息呈现。普通 Session fork 不是目录条目，因此从源 Session 列表中既无法发现这些 fork，也无法发现其后代。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具把什么委托给 subagent 服务；可观察行为已在[使用本包](#use-this-package)中说明。

### 设计理念

`ctx.subagents.sendMessage()`、`interrupt()` 与列表投影之上的轻量适配器；工具不执行任何生命周期路由。驻留、冷恢复与授权归服务所有，工具把确切在线的调用 Agent（`exec.agent`）同时作为 sender 与权限凭据传入。

### 投递与信号所有权

工具转发其执行信号，该信号只在 inbox 接受之前掌管准入。目标一旦接受消息，该消息便无法再通过本工具取消。每条消息都以 `Agent <sender-id> sent a message:` 作为前缀，并记录 `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`；该来源信息由服务推导，且绝不被视为权限。

### 列表投影

`list_agents` 从调用 agent 推导根 id，不使用 cursor 读取服务目录，通过在线 Agent 注册表细化每个候选的状态，并省略无法接受 `send_message` 的一次性子级。后代遍历保留每个父目录的事件顺序。未知模式产生诊断，但其目录仍可遍历；无法读取的目录产生诊断，并停止该分支。可达目录中不存在的后代无法被发现。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `send_message` 与 `interrupt` 注册 |
| [`src/list-agents.ts`](src/list-agents.ts) | `list_agents` 注册：直接子级发现与状态细化 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从工具 schema 进入其背后的继续执行服务。

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——可继续子级、Activation、inbox、中断与后续消息权限。
- [dsh-tool-subagent](../tool-subagent/README.zh.md)——启动可继续子级的委派工具。
- [生成工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-control)——三个工具的 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

已生成的 [schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-control)：`send_message` 接受 `message`、二选一的 `agent_id`/`to` 和可选消息关联参数；`interrupt` 接受直接子级的 `agent_id`；`list_agents` 保持原样。

#### Token 影响

每个父级请求支付固定的 schema 成本。

#### KV Cache 影响

前缀保持稳定；schema 不会在运行时改变。

### 中断结果

#### 模型看到什么

接受时返回 `interrupt requested for agent <agent_id>`。未授权的调用方——self、sibling、陈旧或非直接父级——会成为指明拒绝原因的出错结果；目标不存在或已结算仍渲染接受行。

#### Token 影响

每次调用产生一条简短确认消息；被中断轮次的中止只在子级自己的 transcript（文本记录）中可见。

#### KV Cache 影响

仅追加；每个结果都位于可复用请求前缀之后。

### 投递结果

#### 模型看到什么

接受时返回 `message delivered to agent <agent_id>`；规范输出携带被接受的 `messageId`。失败——他树目标、不可用的父级、未知子级、缺少描述符而无法恢复的子级，或准入被拒——会成为出错的结果，其消息说明该消息未送达。

#### Token 影响

每次调用产生一条简短确认消息；目标的响应绝不会通过本次调用返回。子级使用同一个工具，并传入其初始任务中的父级 ID，将选定内容追加到父级历史中。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 列表结果

#### 模型看到什么

按稳定目录顺序，每个可继续子级占一行：`<id> [<status>] — <label>`（`running` 表示正在执行轮次；`inactive` 表示没有轮次在执行，包括已加载和仅存于存储的情况；两种状态均不表示任务完成或结果）。仅 `descendants` 作用域会为未知模式或无法读取的子级目录添加 `<id> [diagnostic: <reason>]`，包括无法读取的一次性子级。`descendants` 作用域会在每行标签的破折号之前按前序插入 ` parent=<id> depth=<n>`。可读取的一次性子级会被省略；`(no subagents)` 表示投影后没有留下可继续子级或诊断信息。

#### Token 影响

随所列可继续子级和诊断数量线性增长——`descendants` 作用域下为目录可达后代；没有游标或上限，因此长期存活且有许多持久化子级的父级每次调用都会承担完整列表成本。

#### KV Cache 影响

仅追加；每个结果都位于可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明控制工具无法观察或引导什么；它们是当前包约束。

- **已投递消息没有独立结果**——接受时只返回其 inbox `messageId`；目标后续工作会落入该目标的持久化会话，绝不会通过本工具收集。回复是另一条显式指定地址的 `send_message`，而非本次调用的结果。
- **冷投递要求根在线、祖先可恢复**——根不可用或祖先不支持恢复时明确拒绝，不改变父子归属。外部执行仍不可续聊。
- **列表是快照，而非投递承诺**——它可能与发布、dispose（资源释放）或后续消息发生竞态，另一个进程也可能激活当前进程报告为 `inactive` 的子级；跨进程准确性需要共享租约。`interrupt` 自己执行权威的在线 lineage 检查，因此过期的发现结果不会授予权限。
- **没有分页或删除**——系统返回完整且稳定排序的集合；只要子级会话仍在持久化存储中，它就会继续出现在列表中，服务级上限或删除操作留待后续产品决策。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
