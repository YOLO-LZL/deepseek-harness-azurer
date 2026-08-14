# @deepseek-ai/dsh-workspace-ssh

English | [中文](README.zh.md)

SSH execution-world provider for remote workspaces. The plugin registers `ssh` workspace operations, validates saved-connection or config-alias targets, and returns co-located SSH filesystem and subprocess backends.

## Model Experience

Indirectly, through workspace and tool consumers; this provider registers no prompt or tool schema of its own.

#### KV Cache effect

None: selecting an SSH workspace changes execution routing without changing model request tokens.

## Known Limitations and Deferred Work

- Remote workspaces require a reachable POSIX host with OpenSSH and the managed helper prerequisites; provider errors remain remote execution errors rather than local filesystem fallbacks.
