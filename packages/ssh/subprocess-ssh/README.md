# @deepseek-ai/dsh-subprocess-ssh

English | [中文](README.zh.md)

SSH subprocess backend for one remote execution location. `SshSubprocessRuntime` launches framed helper operations, manages remote process groups, and exposes terminal handles while keeping lifecycle ownership in the SSH runtime.

## Model Experience

Indirectly, through shell and terminal consumers; this backend registers no prompt or tool schema of its own.

#### KV Cache effect

None: subprocess routing and remote process state do not modify model request tokens.

## Known Limitations and Deferred Work

- Remote process lifecycle depends on the SSH connection and helper state; a lost connection can make later process observation unavailable.
