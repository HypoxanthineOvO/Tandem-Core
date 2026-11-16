---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-07-collaboration-messages-question-batches

[English](2026-11-07-collaboration-messages-question-batches.md) | 中文

## 概述

新增可选 agent-message 关联元数据（message、effectId、summaryPermit），以及用于暂存答案和幂等批次接受的 user-question/batch 事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-collaboration-messages-question-batches
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-01-prompt-modes"
    after: "382f34f93db2a9fb80b43e89757b7e2faec3c7deeb46fb5897c7fc84d5c8811e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-01-prompt-modes"
    after: "ffc135a926adb72bbd6448f266342f683bb885f58b855532b5a137109919d73f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-01-prompt-modes"
    after: "7d99fd129d5b6ce4210733ba092111de5507e0e7c48aca372c030c8d3a4eafa6"
    decision: same-version
  - root: "event:user-question/batch"
    previous: null
    after: "d082684c2e03f07773dcee49f18f9246d970ecf5d635683096a958d1a3369530"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-01-prompt-modes"
    after: "96c18def2285103c4b50249c917bc8b32aa138303f54f8b8903ad3214d1f6d86"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

既有 AgentMessageSource 字段与判别标记不变；历史消息省略三个可选字段，原意保持不变。不消费这些可选字段的读取方仍按原发送者归属解释消息。问答批次版本使用独立的必需事件判别标记，不修改工具结果或 user-question-reply 来源。当前读取方验证并投影批次；没有该事件词表的旧读取方在解释日志前明确拒绝未知的必需事件。安全拒绝与可选元数据的增量变化允许保留既有会话格式版本。投影 stateVersion 单独递增，不改写历史代。

<a id="verification"></a>
## 验证

定向 user-questions、tool-ask-user 和 ui-user-questions Vitest 测试覆盖准入、暂存、前台结算、超时、重复提交与子级投递。user-questions 的 Loader 组合使用真实 JSONL 后端暂存答案，重建组合后从并发面板提交一次，持久化唯一 inbox 回复，并区分已回答与明确跳过。生成词表前的 JSONL 读取明确拒绝未知必需事件；重新生成 known-event-types 后新读取方可读取。受影响包的 tsc -b 与持久化目录检查验证声明字段。

<a id="dev-note"></a>
## 开发备注

无。
