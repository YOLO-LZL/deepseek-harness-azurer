# execution/ — 执行世界家族

[English](README.md) | 中文

执行世界注册表与路由契约：JSON 可持久化的执行位置、effect 作用域的提供方注册、能力描述与 workspace provider 操作。本地、E2B 与 SSH 执行世界都使用这一契约；本地提供方随本家族提供，远端提供方注册各自的 id。

| 包 | ctx 键 | 职责 |
|---|---|---|
| [`execution-world`](execution-world/README.md)（`@deepseek-ai/dsh-execution-world`） | `ctx.executionWorlds` | 执行位置词汇、提供方注册表、路由、错误码，以及内建本地提供方（`/local` 入口） |

消费方（shell、jobs、terminal、LSP、工具、agent setup）在触碰文件或进程前，先在这里解析 Session 持久化的位置；非 Session 调用方继续通过本地默认直接使用 `ctx.fs`/`ctx.subprocess`。
