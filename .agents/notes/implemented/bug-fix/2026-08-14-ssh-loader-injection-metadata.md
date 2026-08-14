# Agent Note: SSH loader entries preserve function-plugin metadata

Status: implemented

English | [中文](2026-08-14-ssh-loader-injection-metadata.zh.md)

## Problem

The `tool-ssh` and `workspace-ssh` entries are function plugins, but each module exports a `default`. Loader's `unwrapExports()` selects that value before Cordis receives `name` or `inject`; `tool-ssh` then reads `ctx.ssh` without an injected dependency and boot aborts. `workspace-ssh` would likewise instantiate its provider class as the plugin callback instead of running `apply`, leaving the SSH execution-world provider unregistered.

## Decision

Both entries use named-only function-plugin exports. `tool-ssh` declares `name = 'tool-ssh'` and `inject = ['tools', 'shell', 'ssh']`; `workspace-ssh` declares `name = 'workspace-ssh'` and `inject = ['executionWorlds', 'ssh']`. The `ssh` runtime remains a default-exported Service class because its class is the plugin entry. Required services are read through the injected context, while optional settings remain under the nested `ctx.inject(['settings'], ...)` registration. `tsconfig.base.json` maps the SSH UI package's Host entry to `packages/client/ui-ssh/src`; the existing client wildcard resolves its `/client` entry.

## Alternatives considered

**Keep the default exports.** Rejected because Loader discards the namespace metadata that Cordis needs to wait for required services and identify the function plugin.

**Read required services with `ctx.get()`.** Rejected because a global lookup does not declare a load dependency; the plugin could run before the service is mounted and would hide a composition error.

**Make the SSH services optional.** Rejected because `ssh_exec` cannot operate without `shell` and `ssh`, and the workspace provider cannot register without `executionWorlds` and `ssh`.

## Consequences

The Loader waits for each required SSH service before applying its consumer and preserves effect-scoped registration and disposal. Source-profile boot resolves both SSH plugin faces from TypeScript source rather than a stale bundle. A web profile can complete boot even when the SSH client is unavailable; the tools and provider retain their existing runtime-level availability behavior.

## Verification

`pnpm exec tsc -p packages/ssh/tool-ssh/tsconfig.json --noEmit`, `pnpm exec tsc -p packages/ssh/workspace-ssh/tsconfig.json --noEmit`, and `pnpm dsh web --help` pass. The latter traverses the real web profile composition and reaches the app help path without the loader failure.
