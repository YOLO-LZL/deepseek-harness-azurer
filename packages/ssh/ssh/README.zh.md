# @deepseek-ai/dsh-ssh

[English](README.md) | 中文

SSH 运行时（`ctx.ssh`）负责已保存的连接设置、本地 `~/.ssh/config` 别名发现和生命周期绑定的 OpenSSH 传输。工作区和工具消费方在打开远端执行世界前，通过该运行时解析保存的连接 id 或配置别名。

## 模型体验

模型影响通过 `@deepseek-ai/dsh-tool-ssh` 和工作区消费方间接产生；此运行时不注册自己的提示词或工具 schema。

#### KV Cache 效果

无：连接设置为执行选择传输，不改变已有模型请求 token。

## Known Limitations and Deferred Work

- 仅支持基于密钥的非交互 OpenSSH 会话；BatchMode 会拒绝密码和口令提示。
- 发现的 `~/.ssh/config` 别名只读，不会复制到持久连接设置。
