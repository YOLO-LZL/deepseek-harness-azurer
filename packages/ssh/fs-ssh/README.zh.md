# @deepseek-ai/dsh-fs-ssh

[English](README.md) | 中文

一个远端执行位置的 SSH filesystem 后端。`SshFileSystem` 通过分帧 helper 操作、规范化远端路径和提供方专用错误转换来实现 filesystem 服务。

## 模型体验

模型影响通过 `@deepseek-ai/dsh-tool-fs` 间接产生；此后端不注册自己的提示词或工具 schema。

#### KV Cache 效果

无：远端 filesystem 选择改变执行路由，不改变已组装的模型请求。

## Known Limitations and Deferred Work

- 后端通过 SSH helper 服务 POSIX 远端路径，不提供 Windows 远端路径实现。
