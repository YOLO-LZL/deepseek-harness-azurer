# Agent Note: SSH 设置在 schema 解析时迁移缺少 id 的连接记录

Status: implemented

[English](2026-08-14-ssh-settings-id-migration.md) | 中文

## Problem

持久化的 `ssh-connections` namespace 可能包含缺少 `id` 的连接记录，以及使用连接名称的工作区默认项。必填的 `id` 字段会在 namespace 注册时拒绝该文档，因此运行时迁移无法执行，SSH 设置区域也无法使用。

## Decision

SSH settings schema 只通过逐条兼容 transform 接受缺少 id 的记录，并输出带 UUID 的 canonical `SshConnection`。由于序列化后的 schema 会在 settings 客户端重新创建，transform 只使用浏览器和 Node 都提供的 Web 标准全局对象。运行时在注册后检查原始 user layer，并用解析后的连接记录和按 id 记录的工作区默认项替换缺少 id 的分节，从而把生成的 id 保存在磁盘上。

## Alternatives considered

**永久将 `id` 设为可选。** 拒绝，因为消费者和持久化的 canonical 数据都要求稳定 id；永久可选的 schema 会允许未迁移的记录离开迁移路径。

**只在严格 schema 注册之后迁移。** 拒绝，因为注册会在运行时获得 scope 之前校验存储分节，所以缺少 id 的文档仍然无法触发迁移。

**在序列化 schema 中使用只适用于 Node 的导入迁移回调。** 拒绝，因为浏览器会从序列化源码执行回调，无法解析 Node 模块绑定。

## Consequences

已有的 SSH 设置会立即以 canonical id 加载，首次运行时写入会使这些 id 持久化。按名称记录的工作区默认项会同时改写为 id。新写入仍然校验必填的 canonical id 字段，settings 客户端在重新创建 schema 后也能校验相同的兼容格式。

## Verification

`packages/ssh/ssh/tests/settings-migration.spec.ts` 覆盖 Host 解析、序列化 schema 重新创建、namespace 注册、id 持久化和默认项重映射。聚焦 SSH model 与迁移测试、SSH 和 UI-SSH 类型检查、UI-SSH 回归测试以及一次冷启动 Web 验证均已通过。
