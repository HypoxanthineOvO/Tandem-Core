---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-01-prompt-modes

[English](2026-11-01-prompt-modes.md) | 中文

## 概述

记录对话模式选择、支线本地读取版本及 session-mode/continuity-baseline 消息来源，同时刷新已存在的连续性事件与 compact-checkpoint 可选 strategy 字段的清单。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-prompt-modes
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "8449aeae390fd7152234b5bdae8ad5ac78b255318b05d8429e907ae05803f927"
    decision: same-version
  - root: "event:continuity/ack"
    previous: null
    after: "5e575bcbc6dfc81a44a1fa06990e184d1ed97c9e3a001097dbdae3632cf46b10"
    decision: same-version
  - root: "event:continuity/branch-read"
    previous: null
    after: "d3cbc40e36b0da014339786df41b35f54cef08e781580e4e3099d18d364eb173"
    decision: same-version
  - root: "event:continuity/delivery"
    previous: null
    after: "e7a92fb3a187e718d31d882cd0446a3ca18dc1c6b870a3cbd5b8c18db6cba3bb"
    decision: same-version
  - root: "event:continuity/observe"
    previous: null
    after: "26c1896f19b8c2b96b1b65bb5455274bd9bd0e68a3ddee1e4c76075cf84caaff"
    decision: same-version
  - root: "event:continuity/read"
    previous: null
    after: "0cd08990fff8b833ba92d48443029629945b18467382b61e47b8b55f95586056"
    decision: same-version
  - root: "event:continuity/transaction"
    previous: null
    after: "2ebb903d54b6c34b6ad716a4fae9bcaddb66912020b8e5a284a7d4e74d0e11d5"
    decision: same-version
  - root: "event:continuity/wake"
    previous: null
    after: "2d6d95a2fb54b2eb985d7ce3268eac01cf31019cb256f513f16770ab7bdf6dbd"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "b72367c7e9876b93d754d0fa8251cd2d502299c77696b47e9eb1046dbca22c68"
    decision: same-version
  - root: "event:session-mode/selected"
    previous: null
    after: "b864273d453fa3f21a525d8ce680805b9b782c52bee0586c201a87d2ec89a61a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "1b4e1505d9960443f391d372d42256e2fc4799af05240b4aa664d53a00a0136c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "9936acdfe391ab5206c8595d220fd1fa229321bd71b8f1a414f7da2d8b50b286"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

历史事件载荷不变，写入版本仍为 V4。新增选择与支线读取事件使用必须识别的独立事件类型；不认识它们的旧读取器会拒绝日志，而非按错误策略恢复。新增消息来源保留普通用户角色正文表示，作为扩展元数据保留，不改变既有来源标签的含义。可选 checkpoint strategy 字段和既有连续性事件的运行语义保持不变。不重写或删除任何已提交的历史代际。

<a id="verification"></a>
## 验证

连续性控制器、子预设排除、父级结果路由、结算正文与可续聊定向测试共 199 项子代理测试通过。模式通知另有经 Loader 组合的 Agent-loop 测试及包内模型可见文本快照；完整合同回归与构建结果记录在任务完成证据中。

<a id="dev-note"></a>
## 开发备注

无。
