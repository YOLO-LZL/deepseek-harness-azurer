# @deepseek-ai/dsh-execution-world

English | [中文](README.zh.md)

Execution-world Service Definition and routing layer (`ctx.executionWorlds`): the JSON-persistable [`ExecutionLocation`](src/types.ts) naming one execution world, effect-scoped provider registration with duplicate-id rejection, and the route from a location to the live filesystem / subprocess / workspace backends of that world.

`ctx.fs` + `ctx.subprocess` define one execution world (the [portable execution-world decision](../../../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md)). This package generalizes that principle from "one provider per process" to "routable per session": a session persists its execution location in its header, and consumers resolve it here before touching files or processes. The local world (`{ providerId: 'local', target: null, root }`) is built in; E2B and SSH providers register their own ids. `resolve(undefined)` routes to the local default, so non-session callers keep working unchanged.

## Loading

```yaml
# The registry itself.
- id: execution-world
  name: '@deepseek-ai/dsh-execution-world'

# The built-in local provider (registers 'local' over ctx.fs/ctx.subprocess).
- id: execution-world-local
  name: '@deepseek-ai/dsh-execution-world/local'
```

Registration is best-effort: a profile without `ctx.fs` or `ctx.subprocess` still gets a local provider whose missing seam answers `execution-unavailable`, so harness startup never depends on any particular backend being mounted. Providers register through `registry.register(provider)`; registration is effect-scoped (the enclosing cordis effect disposes it), duplicate ids are rejected, and unregistering removes every route to the provider.

## Error codes

`ExecutionError` extends `HarnessError` with a stable `code`:

| Code | Meaning |
|---|---|
| `execution-provider-not-found` | A location named an unregistered provider (or the local default is missing) |
| `execution-unavailable` | A registered provider cannot serve right now (no ssh client, connection refused, sandbox gone, seam unmounted) |
| `workspace-provider-invalid-target` | A create input named a target the provider refuses |
| `workspace-remote-path-invalid` | A workspace path failed the provider's remote-path validation |
| `execution-policy-unsupported` | An operation needs a policy the provider cannot enforce (e.g. remote bash under read-only) |

## Model Experience

Indirectly, through workspace and tool consumers; this registry registers no prompt or tool schema of its own.

#### KV Cache effect

None: execution-world routing selects backends after request assembly and does not change model request tokens.

## Known Limitations and Deferred Work

- The registry routes, it does not execute: backends own their connection/lifecycle, lazily connecting on first use (the E2B `getSandbox()` pattern).
- A location is a resolution convention, not a containment boundary — providers document their own path limits.
