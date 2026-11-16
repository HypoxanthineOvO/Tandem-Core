---
kind: upgrade-guide
description: "自定义派发组合需要共用派发服务，工作流现在执行完整 LLM 路由和 Host 深度限制。"
---

# 共用子代理派发

[English](guide.md) | 中文

## 变更

挂载 `@deepseek-ai/dsh-tool-subagent` 或 `@deepseek-ai/dsh-workflow-ptc` 的自定义组合还必须挂载 `@deepseek-ai/dsh-subagent-delegation`。随附 base bundle 已包含它。派发参数 schema 和 Activation 确认结果不变。

工作流 `agent()` 调用现在与原生派发共用 preset、精确模型权限、适配器预检和深度检查。只提供 provider 或 model 的 LLM 覆盖会被拒绝。省略工作流深度时采用 Host 的 `subagent.maxDepth` 设置，而不是不发送限制。无法执行数值上限的外部提供方要求显式配置 `maxDepth: provider-managed`。

Fork 支持显式选择独立 preset。省略 preset 时保留父级当前 preset；选择只读 preset 时保留对话历史，而不是父级可写工具。

## 迁移

1. 在自定义组合的原生 subagent 服务旁添加 `- name: '@deepseek-ai/dsh-subagent-delegation'`。确认 profile 依赖包含该包；使用更新后的 base bundle 时不要重复添加服务条目。
2. 更新工作流覆盖，同时提供两个 LLM 字段：`agent('task', { provider: 'your-provider', model: 'your-model' })`。在 Session 的允许模型策略中登记该路由，并确认适配器可解析它。
3. Host 默认值不符合预期上限时配置 `workflow-ptc.config.maxDepth`。仅对自行负责递归策略的后端使用 `provider-managed`。配置 `agentPreset` 选定固定的工作流子级 preset。
4. 检查合成 profile，并运行 `pnpm exec vitest run packages/subagent/subagent-delegation/tests packages/workflow/workflow-ptc/tests`，不使用模型凭据。确认 fork 的只读子级没有 `write`、`edit` 或 `bash` 声明，且超出所选深度的工作流返回启动错误，不创建子级。

5. 把 `interrupt_agent` 改为 `interrupt`；只有既有会话仍需要旧名时才设置 `tool-subagent-control.config.legacyInterruptAgent: true`。两个名称都只允许确切的直接父级调用，不允许祖父级或兄弟，即使目标已卸载也一样。历史日志可读不代表历史工具名仍可执行。已记录但未运行的直接子级现在返回 `{ accepted: false, reason: 'not-running' }`，不再报告停止请求成功。
