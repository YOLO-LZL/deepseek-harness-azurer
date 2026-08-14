# @deepseek-ai/dsh-execution-location

English | [中文](README.zh.md)

Shared JSON-persistable execution-location types, provider ids, error codes, and workspace-provider operations. Consumers store an `ExecutionLocation` in durable records and providers validate its target in their own execution world.

## Model Experience

None, as this package defines locations and errors but registers no model-facing behavior.

#### KV Cache effect

None: location values affect routing after a request is assembled, not its token content.

## Known Limitations and Deferred Work

- Location targets are provider-owned JSON values; this package cannot validate provider-specific reachability or path policy before the selected provider resolves them.
