# @deepseek-ai/dsh-client-ui-ssh

English | [中文](README.zh.md)

Browser-side SSH settings and workspace-create components. The plugin renders saved SSH connections, validates local drafts before the settings service writes them, and exposes remote directory browsing through the Host API.

## Model Experience

None, as this browser-side UI registers no model request context.

#### KV Cache effect

None: rendering or editing SSH settings in the browser does not change model request tokens.

## Known Limitations and Deferred Work

- Remote directory actions require the Host process to have a usable OpenSSH client and a reachable target; the UI surfaces the Host result without providing its own transport fallback.
