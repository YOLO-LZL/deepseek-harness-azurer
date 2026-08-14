# @deepseek-ai/dsh-workspace-ssh

[English](README.md) | 中文

远端工作区的 SSH 执行世界提供方。该插件注册 `ssh` 工作区操作、校验保存的连接或配置别名 target，并返回同位置的 SSH filesystem 和 subprocess 后端。

## 模型体验

模型影响通过工作区和工具消费方间接产生；此提供方不注册自己的提示词或工具 schema。

#### KV Cache 效果

无：选择 SSH 工作区会改变执行路由，不改变模型请求 token。

## Known Limitations and Deferred Work

- 远端工作区要求可达的 POSIX 主机具备 OpenSSH 和受管 helper 前置条件；提供方错误仍是远端执行错误，不会回退到本地 filesystem。
