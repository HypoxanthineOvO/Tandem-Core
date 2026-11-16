---
description: "让派发工具、工作流和受信任插件一致地解析子级 preset、模型权限和深度。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-delegation

[English](README.md) | 中文

## 摘要

从工具、工作流或受信任插件派发任务，使用相同的 preset、精确模型和深度检查。继承对话时可使用独立的只读 preset，而不继承父级工具。预留本地子级身份，在首次模型请求前持久化身份或路由记录。使用本服务不要求任何派发工具对模型可见。

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

将本服务与原生子代理运行时及所选提供方一起挂载。服务不添加工具，也没有独立的部署配置字段；每个受信任消费方显式注册自己的派发权限。

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-delegation'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-subagent-fork-in-process'
```

### 注册并派发

在消费方插件中注入 `subagentDelegation`。使用消费方的 Context 注册提供方、可选的上下文继承提供方、preset 白名单、模型选择权限和深度限制。返回的不透明策略不是工具名称，该 Context 卸载时撤销。`resolve(parent, request, policy, signal)` 校验 preset 引用、精确路由权限、思考等级、实时适配器预检和当前深度；`start(spec, signal, hooks?)` 一次性消费该 spec，返回原生 Activation。取消或准入失败时两个方法都会拒绝；启动被拒绝后，不应继续依赖该子级的任务。

```javascript
const policy = ctx.subagentDelegation.register({
  provider: 'spawn',
  forkProvider: 'fork',
  agentPreset: 'subagent',
  allowedAgentPresets: ['subagent', 'subagent-readonly'],
  modelSelectionSettings: true,
  maxDepth: 2,
}, ctx)
const spec = await ctx.subagentDelegation.resolve(parent, {
  prompt: 'Review the completed work.',
  label: 'Review implementation',
  agentPreset: 'subagent-readonly',
  inheritContext: true,
  delivery: 'caller',
}, policy, signal)
const activation = await ctx.subagentDelegation.start(spec, signal)
try { await activation.result } finally { await activation.dispose() }
```

preset id 必须已声明。Host 采样要求已有的 `@deepseek-ai/dsh-tool-subagent/model-selection-settings` 服务；该入口不添加派发工具。显式选择子级 LLM 时同时提供 `provider` 和 `model`；`reasoningEffort` 可选。即使消费方注册了更宽权限，父级持久化的模型选择策略仍然适用。配置 `modelSelectionSettings: true` 的注册在 `agent/created` 期间捕获 Host 权限，即使没有派发工具；捕获的偏好关闭时禁用显式选择。`selectionPolicy(session, true)` 为全新根会话采样 Host 设置，或继承子级已记录的策略；没有决议的恢复 Session 不采样后来的偏好。省略深度时读取当前 Host 限制，`provider-managed` 则将执行留给后端。`source` 默认 `service`；工具和工作流消费方分别设置 `tool` 和 `workflow`，供执行层准入使用。

### 首次请求前持久化身份

`start()` 在调用 `onChildReserved(childId)` 前预留本地子级 id。调用方可选传入的 `request.childId` 保持不变。`beforeChildStart(child, signal)` 在被等待的 `agent/created` 阶段运行，早于初始任务提交。在该回调中追加子级身份和策略记录，再等待 `ctx.sessions.flush(child.session)`；回调结束前，子级首次模型请求不能启动。flush 失败必须拒绝回调。这些钩子不绕过运行时的重复 id、实时父级、容量和准入检查。

```javascript
const activation = await ctx.subagentDelegation.start(spec, signal, {
  onChildReserved(childId) {
    return reserveIdentity(childId)
  },
  async beforeChildStart(child, signal) {
    signal.throwIfAborted()
    await appendIdentityAndPolicy(child.session)
    if (!await ctx.sessions.flush(child.session)) throw new Error('identity persistence unavailable')
  },
})
```

`onChildReserved` 可返回同步 disposer，清理调用方临时状态。启动成功、失败或取消后，服务都会调用它，并始终释放自身预留。disposer 抛错时，启动以 `AggregateError` 拒绝，并等待释放已接受的 Activation；重试前检查调用方状态及释放失败。回调在返回 disposer 前抛错时，已更改的状态由回调负责。后续失败前已提交的子级记录仍是持久证据；服务不会擦除。外部提供方不接受预留 id 或这两个身份钩子。已接受的工作流可在消费方卸载前调用 `retain(policy)`，并在本次运行和所有子级结束后释放；已撤销的策略不能增加新持有者。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

默认服务类声明能力并实现策略解析。部署注册和一次性 spec 属于该服务实例。既有工具和工作流引擎是消费方；原生提供方和子代理运行时继续负责子级执行、取消、目录成员和结果。消费方不在工具注册表中查找隐藏的派发入口。

共用策略模块保留既有的模型策略事件和投影。Fork 保留已完成轮次的初始内容，原生子级组合在继承范围之后记录显式选定的 preset。循环在首次发送请求前记录所选 preset 当前的系统提示词与工具声明。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [子代理运行时](../subagent/README.zh.md)——Activation 所有权与持久化。
- [派发工具](../tool-subagent/README.zh.md)——模型可见 schema 与结果。
- [Fork 后端](../subagent-fork-in-process/README.zh.md)——继承已完成轮次上下文。
- [工作流引擎](../../workflow/workflow-ptc/README.zh.md)——调用方负责的结构化结果收集。

-----

<a id="model-experience"></a>
## 模型体验

### 派发的子级输入

#### 模型看到什么

服务提供调用方的 `prompt` 和选定的子级 preset，不添加父级工具 schema 或系统区段。原生子级组合及循环记录每一份当前系统提示词／工具声明；继承历史不会将父级 preset 的工具授予独立选定的只读 preset。

#### Token 影响

每个子级消费自己的提示词和所选上下文。服务不增加编排 token；确认和结果渲染由模型可见消费方负责。

#### KV Cache 影响

全新子级不共享父级历史。Fork 可复用未变的继承前缀；更改子级 preset 或路由可能替换系统提示词／工具声明，使该复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明身份准备和策略所有权的适用范围。

- 预留钩子要求本地可续提供方；外部提供方自行分配身份。
- 身份或路由记录的内容和持久化由调用方负责；本服务不推断专家角色。
- 启动成功后，执行所有权转给返回的原生 Activation；之后取消启动信号不能代替释放该 Activation。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
