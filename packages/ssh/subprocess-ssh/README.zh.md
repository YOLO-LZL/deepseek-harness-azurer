# @deepseek-ai/dsh-subprocess-ssh

[English](README.md) | 中文

一个远端执行位置的 SSH subprocess 后端。`SshSubprocessRuntime` 启动分帧 helper 操作、管理远端进程组并公开 terminal 句柄，同时由 SSH 运行时保留生命周期所有权。

## 模型体验

模型影响通过 shell 和 terminal 消费方间接产生；此后端不注册自己的提示词或工具 schema。

#### KV Cache 效果

无：subprocess 路由和远端进程状态不会修改模型请求 token。

## Known Limitations and Deferred Work

- 远端进程生命周期依赖 SSH 连接和 helper 状态；连接丢失后，后续进程观察可能不可用。
