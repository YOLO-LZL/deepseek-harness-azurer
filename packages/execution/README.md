# execution/ — execution-world family

English | [中文](README.zh.md)

The execution-world registry and routing contract: JSON-persistable execution locations, effect-scoped provider registration, capability descriptors, and the workspace-provider operations. Local, E2B, and SSH execution worlds all speak this contract; the local provider ships in this group, remote providers register their own ids.

| Package | ctx key | Role |
|---|---|---|
| [`execution-world`](execution-world/README.md) (`@deepseek-ai/dsh-execution-world`) | `ctx.executionWorlds` | Execution location vocabulary, the provider registry, routing, error codes, and the built-in local provider (`/local` entry) |

Consumers (shell, jobs, terminal, LSP, tools, agent setup) resolve a session's persisted location here before touching files or processes; non-session callers keep using `ctx.fs`/`ctx.subprocess` directly through the local default.
