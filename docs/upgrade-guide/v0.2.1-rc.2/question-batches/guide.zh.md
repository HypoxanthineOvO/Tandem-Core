---
kind: upgrade-guide
description: "旧构建会拒绝包含持久问答批次事件的 Session。"
---

# 持久问答批次

[English](guide.md) | 中文

## 变更

带调用 ID 的问题会记录 `user-question/batch` 版本，其中包含暂存答案和提交回执。生成的 Session 词表不含该事件的构建会拒绝读取日志，不会静默丢失已接受答案。Session 格式版本不变。既有问题和 agent-message 归属仍可读取；三个新增的 agent-message 元数据字段都是可选项。详见[持久类型确认](../../../persistence-changes/2026-11-07-collaboration-messages-question-batches.zh.md)。

## 迁移

1. 同时升级问答 Host 与原生问答 Client。自定义回答面板的前台和已继续问题都使用 `submitBatch`；需要在 Host 保留逐题答案时使用 `stageAnswer`。
2. 写入新批次前保留备份。旧发布版不能重开这些新写入的 Session；之后仍需用新发布版访问它们。不要删除必需事件或改写已有存储代来强行降级。
3. 开放子级提问的部署安装 `HumanInteractionPolicy` 提供方，并在 `userQuestions` config 中设置 `requirePolicy: true`。没有安装或要求策略时，仍然仅允许运行时根调用。
4. 验证重开 Session 后 `query(session)` 能重建暂存答案，重复 `submitBatch` 返回 `already-submitted`，不产生第二条回复。
