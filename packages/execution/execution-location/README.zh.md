# @deepseek-ai/dsh-execution-location

[English](README.md) | 中文

共享的可 JSON 持久化执行位置类型、提供方 id、错误码和工作区提供方操作。消费方在持久记录中保存 `ExecutionLocation`，提供方在自己的执行世界中校验其 target。

## 模型体验

本包定义位置和错误，但不注册面向模型的行为。

#### KV Cache 效果

无：位置值在请求组装后影响路由，不影响 token 内容。

## Known Limitations and Deferred Work

- 位置 target 由提供方拥有；本包无法在选定提供方解析前校验特定提供方的可达性或路径策略。
