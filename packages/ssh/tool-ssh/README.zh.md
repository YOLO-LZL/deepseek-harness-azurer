# @deepseek-ai/dsh-tool-ssh

[English](README.md) | 中文

用于显式 SSH 命令和持久 SSH 连接管理的模型工具。`ssh_exec` 通过本地 OpenSSH 客户端执行带外远端命令；`ssh_connections` 为工作区保存、列出、删除和绑定连接记录。

## 模型体验

### SSH 工具 schema

#### What the model sees

插件挂载时，模型看到 [`ssh_exec` 与 `ssh_connections` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ssh)。

#### Token effect

每个已挂载工具 schema 都会把其说明和参数加入下一次请求的工具上下文。

#### KV Cache effect

插件配置和已挂载工具集不变时，工具前缀保持稳定；添加或移除此插件会改变工具上下文。

## Known Limitations and Deferred Work

- `ssh_exec` 使用本地 OpenSSH 客户端并拒绝密码提示；部署必须通过普通 OpenSSH 机制提供密钥材料。
- 工具不会覆盖用户的主机密钥策略；未知或不受信任的主机会按 OpenSSH 配置失败。
