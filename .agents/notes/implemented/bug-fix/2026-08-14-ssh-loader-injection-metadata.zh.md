# Agent Note: SSH loader 条目保留函数插件元数据

Status: implemented

[English](2026-08-14-ssh-loader-injection-metadata.md) | 中文

## Problem

`tool-ssh` 和 `workspace-ssh` 都是函数插件，但两个模块都导出了 `default`。Loader 的 `unwrapExports()` 会在 Cordis 收到 `name` 或 `inject` 之前选中这个值；随后 `tool-ssh` 在没有注入依赖的情况下读取 `ctx.ssh`，导致启动中止。`workspace-ssh` 也会被当作插件回调实例化 provider 类，而不是运行 `apply`，因此 SSH execution-world provider 不会注册。

## Decision

两个条目都改为仅使用命名的函数插件导出。`tool-ssh` 声明 `name = 'tool-ssh'` 和 `inject = ['tools', 'shell', 'ssh']`；`workspace-ssh` 声明 `name = 'workspace-ssh'` 和 `inject = ['executionWorlds', 'ssh']`。`ssh` runtime 仍然默认导出 Service 类，因为该类就是插件入口。必需服务通过注入的 context 读取；可选 settings 继续放在嵌套的 `ctx.inject(['settings'], ...)` 注册中。`tsconfig.base.json` 将 SSH UI package 的 Host 入口映射到 `packages/client/ui-ssh/src`；既有 client 通配映射会解析其 `/client` 入口。

## Alternatives considered

**保留默认导出。** 拒绝，因为 Loader 会丢弃 Cordis 用来等待必需服务和识别函数插件的命名空间元数据。

**使用 `ctx.get()` 读取必需服务。** 拒绝，因为全局查找不会声明加载依赖；插件可能在服务挂载前运行，也会掩盖组合配置错误。

**将 SSH 服务改为可选。** 拒绝，因为 `ssh_exec` 没有 `shell` 和 `ssh` 就无法工作，workspace provider 没有 `executionWorlds` 和 `ssh` 就无法注册。

## Consequences

Loader 会在应用每个 SSH consumer 前等待其必需服务，并保留 effect 作用域内的注册与释放行为。source profile 启动会从 TypeScript source 解析两个 SSH plugin face，而不会依赖陈旧 bundle。即使系统没有 SSH 客户端，web profile 也能完成启动；工具和 provider 继续使用既有 runtime 级可用性行为。

## Verification

`pnpm exec tsc -p packages/ssh/tool-ssh/tsconfig.json --noEmit`、`pnpm exec tsc -p packages/ssh/workspace-ssh/tsconfig.json --noEmit` 和 `pnpm dsh web --help` 均通过。最后一项会经过真实 web profile 组合并到达应用帮助路径，不再触发 Loader 错误。
