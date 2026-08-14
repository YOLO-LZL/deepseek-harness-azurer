# @deepseek-ai/dsh-fs-ssh

English | [中文](README.zh.md)

SSH filesystem backend for one remote execution location. `SshFileSystem` implements the filesystem service with framed helper operations, canonical remote paths, and provider-specific error translation.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-fs`; this backend registers no prompt or tool schema of its own.

#### KV Cache effect

None: remote filesystem selection changes execution routing, not the assembled model request.

## Known Limitations and Deferred Work

- The backend serves POSIX remote paths through the SSH helper and does not provide a Windows remote-path implementation.
