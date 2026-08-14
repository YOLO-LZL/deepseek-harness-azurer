# @deepseek-ai/dsh-ssh

English | [中文](README.zh.md)

SSH runtime (`ctx.ssh`) for saved connection settings, local `~/.ssh/config` alias discovery, and lifecycle-bound OpenSSH transports. Workspace and tool consumers resolve a saved connection id or config alias through this runtime before opening a remote execution world.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-ssh` and workspace consumers; this runtime registers no prompt or tool schema of its own.

#### KV Cache effect

None: connection settings select a transport for execution and do not alter existing model request tokens.

## Known Limitations and Deferred Work

- Only key-based noninteractive OpenSSH sessions are supported; password and passphrase prompts are rejected by BatchMode.
- Discovered `~/.ssh/config` aliases are read-only and are not copied into persistent connection settings.
