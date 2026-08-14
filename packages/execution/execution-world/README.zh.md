# @deepseek-ai/dsh-execution-world

[English](README.md) | 中文

执行世界 Service Definition 与路由层（`ctx.executionWorlds`）：JSON 可持久化的 [`ExecutionLocation`](src/types.ts) 命名一个执行世界、effect 作用域的提供方注册（重复 id 拒绝）、以及从位置到该世界存活的 filesystem / subprocess / workspace 后端的路由。

`ctx.fs` + `ctx.subprocess` 定义同一个执行世界（[可移植执行世界决策](../../../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md)）。本包把该原则从"每个进程一个提供方"推广为"按 Session 路由"：Session 在其 header 中持久化执行位置，消费方在触碰文件或进程前先在这里解析。本地世界（`{ providerId: 'local', target: null, root }`）内建；E2B 与 SSH 提供方注册各自的 id。`resolve(undefined)` 路由到本地默认，因此非 Session 调用方无需改动。

## 加载

```yaml
# The registry itself.
- id: execution-world
  name: '@deepseek-ai/dsh-execution-world'

# The built-in local provider (registers 'local' over ctx.fs/ctx.subprocess).
- id: execution-world-local
  name: '@deepseek-ai/dsh-execution-world/local'
```

注册尽力而为：没有 `ctx.fs` 或 `ctx.subprocess` 的 profile 仍会得到一个本地提供方，缺失的 seam 在用时回答 `execution-unavailable`，因此 harness 启动从不依赖任何特定后端被挂载。提供方通过 `registry.register(provider)` 注册；注册是 effect 作用域的（所在 cordis effect 结束时销毁）、重复 id 被拒绝、注销后指向该提供方的所有路由消失。

## 错误码

`ExecutionError` 继承 `HarnessError`，携带稳定 `code`：

| 码 | 含义 |
|---|---|
| `execution-provider-not-found` | 位置命名了未注册的提供方（或本地默认缺失） |
| `execution-unavailable` | 已注册的提供方当前无法服务（无 ssh 客户端、连接被拒、沙箱消失、seam 未挂载） |
| `workspace-provider-invalid-target` | 创建输入命名了提供方拒绝的 target |
| `workspace-remote-path-invalid` | 工作区路径未通过提供方的远端路径校验 |
| `execution-policy-unsupported` | 操作需要提供方无法强制执行的策略（例如 read-only 下的远端 bash） |

## 模型体验

模型影响通过工作区和工具消费方间接产生；此注册表不注册自己的提示词或工具 schema。

#### KV Cache 效果

无：执行世界路由在请求组装后选择后端，不改变模型请求 token。

## Known Limitations and Deferred Work

- 注册表只路由、不执行：后端拥有自己的连接/生命周期，首次使用时惰性连接（E2B 的 `getSandbox()` 模式）。
- 位置是解析约定，不是包含边界——提供方自行说明其路径限制。
