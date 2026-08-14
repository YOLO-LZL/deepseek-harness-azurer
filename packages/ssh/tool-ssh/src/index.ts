/**
 * SSH model tools: `ssh_exec` (explicit cross-host commands through the local
 * shell executor, for hosts NOT bound to the calling session's execution
 * world) and `ssh_connections` (persisted connection management over the
 * `ssh-connections` settings namespace). Both tools are built over the in-repo
 * ssh runtime; SSH workspaces' ordinary operations go through the execution
 * world instead, and `ssh_exec` remains for explicit out-of-band commands.
 * @module @deepseek-ai/dsh-tool-ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-shell'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ExecutionLocation } from '@deepseek-ai/dsh-execution-location'
import { discoverSshConfigHosts } from '@deepseek-ai/dsh-ssh'
import type { SshConfigHost, SshConnectionsSettings, SshExecArgs } from '@deepseek-ai/dsh-ssh'
import {
  applyConnectionsAction,
  buildSshCommand,
  composeConnectionsResult,
  renderConnectionsResult,
  renderResult,
  resolveTarget,
  validateExecArgs,
} from '@deepseek-ai/dsh-ssh'
import type { SshConnectionsResult, SshExecResult, SshTarget } from '@deepseek-ai/dsh-ssh'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-ssh'

/** Services required while registering the SSH model tools. */
export const inject = ['tools', 'shell', 'ssh']

/** Minimal structural face of the shell executor this tool consumes. */
export interface ShellLike {
  sandboxMode: string | undefined
  resolve(request: unknown): unknown
  run(request: unknown): Promise<{
    aborted: boolean
    exitCode: number | null
    signal: string | null
    timedOut: boolean
    timeoutMs: number
    stdout: { text: string; truncated: boolean; spillPath?: string }
    stderr: { text: string; truncated: boolean; spillPath?: string }
    sandbox?: { mode: string; denied: boolean; enforcement?: string; runnerFailed?: boolean }
  }>
}

/** Load-time configuration for the SSH model tools. */
export interface SshToolConfig {
  /** Default foreground command timeout in milliseconds. */
  timeoutMs?: number
  /** SSH connection timeout in seconds. */
  connectTimeout?: number
  /** Local OpenSSH configuration file used to discover aliases. */
  sshConfigPath?: string
}

/**
 * Build the extended ssh_exec tool definition.
 * @param options - shell, settings, workspace, and timeout dependencies.
 * @returns registered tool metadata and execution behavior.
 */
export function createSshExecDefinition(options: {
  shell: ShellLike
  sandboxPolicy: { resolve(input?: { session?: unknown }): { mode: string; workspaceRoot: string } | undefined } | undefined
  readSettings: () => SshConnectionsSettings | undefined
  resolveWorkspaceDefault: (exec: ToolRunContext) => Promise<string | undefined>
  /** Hosts discovered from ~/.ssh/config, for error-message hints. */
  readConfigHosts: () => Promise<SshConfigHost[]>
  timeoutMs: number
  connectTimeout: number
}): ToolDefinition {
  return {
    name: 'ssh_exec',
    description: 'Connect to a remote Linux server over SSH and run a command, returning exit code, stdout, and stderr. '
      + 'Key-based authentication only (BatchMode=yes, so no password or passphrase prompts; a missing or unauthorized key fails fast instead of hanging). '
      + '`host` is [user@]host or ANY alias defined in the local ~/.ssh/config — ssh resolves the alias itself, so no ssh_connections save is needed for config hosts. '
      + '`command` is the bash script to run on the remote host (sent to `bash -s` via stdin). '
      + 'Omit `host` to use `connection` (a saved connection) or the current workspace\'s default connection. '
      + 'Omit `key_path` to use ssh default keys (~/.ssh) and ssh-agent.',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Remote host as [user@]host, e.g. "root@10.0.0.5" or "ubuntu@example.com", or an alias from ~/.ssh/config. May be omitted when `connection` or a workspace default resolves it.' },
        command: { type: 'string', description: 'Bash command(s) to run on the remote Linux host.' },
        port: { type: 'integer', description: 'SSH port. Default 22.' },
        key_path: { type: 'string', description: 'Absolute path to the SSH private key file. Omit to use ssh default keys and ssh-agent.' },
        timeout_ms: { type: 'number', description: 'Foreground timeout in milliseconds. Default 30000.' },
        connection: { type: 'string', description: 'Label or id of a saved ssh connection (see ssh_connections); its host/port/user/keyPath fill in the gaps. Explicit `host`/`port`/`key_path` win.' },
      },
      required: ['host', 'command'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['exitCode', 'signal', 'timedOut', 'timeoutMs', 'stdout', 'stderr'],
        properties: {
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          timeoutMs: { type: 'number' },
          stdout: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'truncated'],
            properties: {
              text: { type: 'string' },
              truncated: { type: 'boolean' },
              spillPath: { type: 'string' },
            },
          },
          stderr: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'truncated'],
            properties: {
              text: { type: 'string' },
              truncated: { type: 'boolean' },
              spillPath: { type: 'string' },
            },
          },
          sandbox: {
            type: 'object',
            additionalProperties: false,
            required: ['mode', 'denied'],
            properties: {
              mode: { type: 'string' },
              denied: { type: 'boolean' },
              enforcement: { type: 'string' },
              runnerFailed: { type: 'boolean' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value as unknown as SshExecResult) }],
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const input = args as SshExecArgs
      validateExecArgs(input)
      const workspaceDefault = await options.resolveWorkspaceDefault(exec)
      const configHosts = await options.readConfigHosts()
      const target: SshTarget = resolveTarget(input, options.readSettings(), workspaceDefault, configHosts)

      const policy = options.sandboxPolicy === undefined
        ? undefined
        : options.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
      const request: Record<string, unknown> = {
        command: buildSshCommand(input, target, { connectTimeout: options.connectTimeout }),
        timeoutMs: input.timeout_ms ?? options.timeoutMs,
        stdin: input.command,
        signal: exec.signal,
      }
      if (policy !== undefined) request.sandboxPolicy = policy

      const result = await options.shell.run(options.shell.resolve(request))
      if (result.aborted) throw new Error('tool call aborted')
      return {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        timeoutMs: result.timeoutMs,
        stdout: {
          text: result.stdout.text,
          truncated: result.stdout.truncated,
          ...result.stdout.spillPath !== undefined ? { spillPath: result.stdout.spillPath } : {},
        },
        stderr: {
          text: result.stderr.text,
          truncated: result.stderr.truncated,
          ...result.stderr.spillPath !== undefined ? { spillPath: result.stderr.spillPath } : {},
        },
        ...result.sandbox !== undefined ? { sandbox: result.sandbox } : {},
      }
    },
  }
}

/**
 * Build the ssh_connections model tool for persisted connection management.
 * @param scope - writable SSH connection settings namespace.
 * @param resolveWorkspaceId - resolves the calling workspace for `use`.
 * @param readConfigHosts - reads local OpenSSH aliases for `list`.
 * @returns registered tool metadata and execution behavior.
 */
export function createSshConnectionsDefinition(
  scope: SettingsScope<SshConnectionsSettings>,
  resolveWorkspaceId: (exec: ToolRunContext) => Promise<string | undefined>,
  readConfigHosts?: () => Promise<SshConfigHost[]>,
): ToolDefinition {
  return {
    name: 'ssh_connections',
    description: 'Manage persisted SSH connections (durable via the ssh-connections settings namespace) and bind workspaces to one. '
      + '`action` is one of: save (persist a connection: label, host, optional port/user/keyPath), list (show saved connections AND hosts '
      + 'discovered from the local ~/.ssh/config — those need no save, pass the alias as ssh_exec `host`), '
      + 'delete (remove one by label or id), use (bind the CURRENT workspace to a connection so ssh_exec may omit host; '
      + 'omit `label` to clear the workspace default). Connections are never secrets: only key paths are stored, key content stays on disk.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'list', 'delete', 'use'],
          description: 'Operation: save a connection, list connections (saved + ~/.ssh/config hosts), delete one, or use one as the current workspace default.',
        },
        label: { type: 'string', description: 'Connection label. Required by save/delete; optional by use (omitting clears the workspace default).' },
        host: { type: 'string', description: 'Remote host as [user@]host. Required by save.' },
        port: { type: 'integer', description: 'SSH port (1-65535). Optional, defaults to 22.' },
        user: { type: 'string', description: 'Optional user override, prepended to host when host has no user part.' },
        keyPath: { type: 'string', description: 'Absolute path to the private key. Optional, defaults to ~/.ssh and ssh-agent.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action', 'message'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          message: { type: 'string' },
          connections: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'host'],
              properties: {
                label: { type: 'string' },
                host: { type: 'string' },
                port: { type: 'integer' },
                user: { type: 'string' },
                keyPath: { type: 'string' },
              },
            },
          },
          configHosts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['alias', 'hostName'],
              properties: {
                alias: { type: 'string' },
                hostName: { type: 'string' },
                port: { type: 'integer' },
                user: { type: 'string' },
                identityFile: { type: 'string' },
              },
            },
          },
          defaultLabel: { type: 'string' },
          workspaceId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderConnectionsResult(value as unknown as SshConnectionsResult) }],
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const input = args as { action: 'save' | 'list' | 'delete' | 'use'; label?: string; host?: string; port?: number; user?: string; keyPath?: string }
      const workspaceId = await resolveWorkspaceId(exec)
      const configHosts = input.action === 'list' && readConfigHosts !== undefined
        ? await readConfigHosts()
        : []
      const mutation = applyConnectionsAction(scope.get(), input, workspaceId, configHosts)
      await scope.update(mutation.patch as object)
      return composeConnectionsResult(input, mutation, workspaceId, configHosts)
    },
  }
}

/**
 * Install the ssh tools. `shell` is required (the local shell executor runs
 * the ssh client); the settings namespace mounts only where a settings
 * service exists.
 * @param ctx - host context.
 * @param options - resolved runtime config (timeoutMs, connectTimeout, sshConfigPath).
 */
export function apply(
  ctx: Context,
  options: SshToolConfig = {},
): void {
  const runtime = ctx.ssh
  const shell = ctx.shell as ShellLike
  if (shell === undefined) {
    throw new Error('dsh-tool-ssh: ctx.shell is required to run the ssh client')
  }
  const timeoutMs = options.timeoutMs ?? runtime.config.timeoutMs
  const connectTimeout = options.connectTimeout ?? runtime.config.connectTimeout
  const sshConfigPath = options.sshConfigPath ?? runtime.config.sshConfigPath

  /** The calling session's persisted execution location, when it has one. */
  const sessionLocation = (exec: ToolRunContext): ExecutionLocation | undefined =>
    (exec.agent?.session as { header?: { executionLocation?: ExecutionLocation } } | undefined)?.header?.executionLocation

  /** cwd of the calling session, when the agent carries one. */
  const sessionCwd = (exec: ToolRunContext): string | undefined =>
    (exec.agent?.session as { header?: { cwd?: string } } | undefined)?.header?.cwd

  /** Resolve the calling workspace id, when the registry is available. */
  const resolveWorkspaceId = async (exec: ToolRunContext): Promise<string | undefined> => {
    const registry = (ctx.get as unknown as (service: string) => unknown)('workspaceRegistry') as
      WorkspaceRegistry | undefined
    if (registry === undefined) return undefined
    const location = sessionLocation(exec)
    if (location !== undefined) return registry.resolveByLocation(location)?.id
    const cwd = sessionCwd(exec)
    if (cwd === undefined) return undefined
    const workspace = await registry.resolveByPath(cwd)
    return workspace?.id
  }

  /** Read the ssh-connections namespace value, when mounted. */
  const readSettings = (): SshConnectionsSettings | undefined => runtime.connectionsSettings()

  /** Resolve the current workspace's default connection id, when resolvable. */
  const resolveWorkspaceDefault = async (exec: ToolRunContext): Promise<string | undefined> => {
    const workspaceId = await resolveWorkspaceId(exec)
    if (workspaceId === undefined) return undefined
    return runtime.workspaceDefault(workspaceId)
  }

  ctx.tools.register(createSshExecDefinition({
    shell,
    sandboxPolicy: (ctx.get as unknown as (service: string) => unknown)('sandboxPolicy') as
      | { resolve(input?: { session?: unknown }): { mode: string; workspaceRoot: string } | undefined }
      | undefined,
    readSettings,
    resolveWorkspaceDefault,
    readConfigHosts: () => discoverSshConfigHosts(sshConfigPath),
    timeoutMs,
    connectTimeout,
  }))

  // Optional settings wiring: runs only where a settings service is mounted.
  ctx.inject(['settings'], (sctx) => {
    const scope = runtime.connectionsScope()
    if (scope === undefined) return
    sctx.tools.register(createSshConnectionsDefinition(
      scope,
      resolveWorkspaceId,
      () => discoverSshConfigHosts(sshConfigPath),
    ))
  })
}
