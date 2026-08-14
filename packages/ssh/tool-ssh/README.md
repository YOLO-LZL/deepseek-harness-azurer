# @deepseek-ai/dsh-tool-ssh

English | [中文](README.zh.md)

Model tools for explicit SSH commands and persisted SSH connection management. `ssh_exec` invokes the local OpenSSH client for an out-of-band remote command; `ssh_connections` saves, lists, deletes, and binds connection records for a workspace.

## Model Experience

### SSH tool schemas

#### What the model sees

The model sees the [`ssh_exec` and `ssh_connections` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ssh) when this plugin is mounted.

#### Token effect

Each mounted tool schema adds its description and parameters to the next request's tool context.

#### KV Cache effect

The tool prefix remains stable while the plugin configuration and mounted tool set remain unchanged; adding or removing this plugin changes the tool context.

## Known Limitations and Deferred Work

- `ssh_exec` uses the local OpenSSH client and rejects password prompts; deployments must make key material available through normal OpenSSH mechanisms.
- The tool does not override the user's host-key policy; unknown or untrusted hosts fail according to OpenSSH configuration.
