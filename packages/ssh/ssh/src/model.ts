/**
 * Pure host-side SSH model logic: connection migration/resolution, target
 * references, ssh command construction, the ssh_connections action semantics,
 * and result rendering. No cordis / schemastery imports — unit-testable in
 * isolation.
 * @module @deepseek-ai/dsh-ssh/model
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type {
  SshConfigHost, SshConnection, SshConnectionsArgs, SshConnectionsSettings, SshExecArgs, SshConfig,
} from './types.ts'

/** One effective connection resolved for a call, before user/port/keyPath merging. */
export interface SshTarget {
  host: string
  port?: number
  user?: string
  keyPath?: string
  /** Where the host came from, for diagnostics. */
  source: 'explicit' | 'connection' | 'workspace-default'
}

/** The ssh_exec tool's canonical structured output. */
export interface SshExecResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  timeoutMs: number
  stdout: { text: string; truncated: boolean; spillPath?: string }
  stderr: { text: string; truncated: boolean; spillPath?: string }
  sandbox?: {
    mode: string
    denied: boolean
    enforcement?: string
    runnerFailed?: boolean
  }
}

/** The ssh_connections tool's canonical structured output. */
export interface SshConnectionsResult {
  ok: boolean
  action: SshConnectionsArgs['action']
  message: string
  connections?: SshConnection[]
  /** Hosts discovered from the local ~/.ssh/config (read-only, not persisted). */
  configHosts?: SshConfigHost[]
  defaultLabel?: string
  workspaceId?: string
}

/**
 * Validate the ssh_exec arguments except host (host is resolved elsewhere).
 * @param args - model arguments to validate.
 */
export function validateExecArgs(args: SshExecArgs): void {
  if (typeof args.command !== 'string' || args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535)) {
    throw new Error(`invalid port: expected an integer between 1 and 65535, got ${JSON.stringify(args.port)}`)
  }
  if (args.timeout_ms !== undefined && (!Number.isFinite(args.timeout_ms) || args.timeout_ms <= 0)) {
    throw new Error(`invalid timeout_ms: expected a positive number, got ${JSON.stringify(args.timeout_ms)}`)
  }
  if (args.connection !== undefined && (typeof args.connection !== 'string' || args.connection.trim().length === 0)) {
    throw new Error('invalid connection: expected a non-empty label or id')
  }
  if (args.key_path !== undefined && !isAbsolute(args.key_path)) {
    throw new Error(`invalid key_path: expected an absolute path, got ${JSON.stringify(args.key_path)}`)
  }
}

/**
 * Comma-separated available labels for error messages.
 * @param settings - current saved connection settings, when mounted.
 * @returns labels or a stable empty marker.
 */
export function availableLabels(settings: SshConnectionsSettings | undefined): string {
  const labels = (settings?.connections ?? []).map(connection => connection.label)
  return labels.length > 0 ? labels.join(', ') : '(none)'
}

/**
 * Suggestion of ~/.ssh/config aliases for error messages.
 * @param configHosts - discovered local OpenSSH aliases, when available.
 * @returns formatted hint text, or an empty string.
 */
export function configAliasHint(configHosts: readonly SshConfigHost[] | undefined): string {
  const aliases = (configHosts ?? []).map(host => host.alias)
  return aliases.length > 0 ? ` (also available from ~/.ssh/config: ${aliases.join(', ')})` : ''
}

/**
 * Migrate a legacy settings value (records without ids, workspace defaults
 * bound by label) into the id-keyed form. Reads are idempotent; the caller
 * persists the migrated value through its own write path when it differs.
 * @param value - the raw resolved settings value.
 * @returns the migrated settings.
 */
export function migrateConnectionsSettings(value: SshConnectionsSettings | undefined): SshConnectionsSettings {
  const connections = (value?.connections ?? []).map(connection => ({
    ...connection,
    id: typeof connection.id === 'string' && connection.id.length > 0 ? connection.id : randomUUID(),
  }))
  const workspaceDefaults: Record<string, string> = {}
  for (const [workspaceId, bound] of Object.entries(value?.workspaceDefaults ?? {})) {
    // A legacy default names a label; resolve it to the connection's id.
    const connection = connections.find(candidate => candidate.id === bound || candidate.label === bound)
    if (connection !== undefined) workspaceDefaults[workspaceId] = connection.id
  }
  return { connections, workspaceDefaults }
}

/**
 * Resolve the effective target for one ssh_exec call, in priority order:
 * explicit `host` → explicit `connection` label/id → workspace default id.
 * @param args - the model arguments (host and connection are optional).
 * @param settings - the resolved ssh-connections namespace, when mounted.
 * @param workspaceDefaultId - the current workspace's default connection id, when resolvable.
 * @param configHosts - hosts discovered from ~/.ssh/config, used only to enrich
 *   error messages (ssh itself resolves config aliases passed as `host`).
 * @returns the connection to run against.
 */
export function resolveTarget(
  args: { host?: string; connection?: string },
  settings: SshConnectionsSettings | undefined,
  workspaceDefaultId: string | undefined,
  configHosts?: readonly SshConfigHost[],
): SshTarget {
  if (typeof args.host === 'string' && args.host.trim().length > 0) {
    return { host: args.host, source: 'explicit' }
  }
  const reference = args.connection ?? workspaceDefaultId
  if (reference === undefined) {
    throw new Error(
      'invalid host: expected a non-empty string — pass `host`, or `connection` (a saved label or id), '
      + 'or bind a workspace default with ssh_connections use'
      + configAliasHint(configHosts),
    )
  }
  const connection = (settings?.connections ?? []).find(candidate =>
    candidate.label === reference || candidate.id === reference)
  if (connection === undefined) {
    throw new Error(
      `unknown ssh connection "${reference}" (available: ${availableLabels(settings)})${configAliasHint(configHosts)}`,
    )
  }
  return {
    host: connection.host,
    ...connection.port !== undefined ? { port: connection.port } : {},
    ...connection.user !== undefined ? { user: connection.user } : {},
    ...connection.keyPath !== undefined ? { keyPath: connection.keyPath } : {},
    source: args.connection !== undefined ? 'connection' : 'workspace-default',
  }
}

/** Quote one token for the PowerShell command line (`'...'`, doubling inner `'`). */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Build the ssh PowerShell command line for one call. Explicit model arguments
 * win over the resolved connection's values. Host-key policy is NOT overridden:
 * the user's OpenSSH configuration decides verification (BatchMode=yes makes
 * an unknown host fail instead of prompting).
 * @param args - model arguments (port/key_path explicit overrides).
 * @param target - the resolved connection.
 * @param config - resolved row-level config (connectTimeout).
 * @returns a PowerShell command line that invokes OpenSSH.
 */
export function buildSshCommand(
  args: { port?: number; key_path?: string },
  target: SshTarget,
  config: { connectTimeout: number },
): string {
  const effectiveHost = target.user !== undefined && !target.host.includes('@')
    ? `${target.user}@${target.host}`
    : target.host
  const argv = [
    'ssh',
    '-p', String(args.port ?? target.port ?? 22),
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${config.connectTimeout}`,
  ]
  const keyPath = args.key_path ?? target.keyPath
  if (keyPath !== undefined) argv.push('-i', keyPath)
  argv.push(effectiveHost, 'bash', '-s')
  return `& ${argv.map(psQuote).join(' ')}`
}

/**
 * Resolve row-level numeric config, falling back to documented defaults.
 * @param config - optional SSH configuration fields.
 * @returns normalized timeouts and remote state directory.
 */
export function resolveConfig(config: SshConfig = {}): {
  timeoutMs: number
  connectTimeout: number
  remoteStateDir: string
} {
  return {
    timeoutMs: typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? config.timeoutMs
      : 30000,
    connectTimeout: typeof config.connectTimeout === 'number' && Number.isFinite(config.connectTimeout) && config.connectTimeout > 0
      ? config.connectTimeout
      : 15,
    remoteStateDir: config.remoteStateDir ?? '.dsh-ssh',
  }
}

/** One pure mutation over the namespace value; the caller persists the returned patch. */
export interface SshConnectionsMutation {
  /** Field-scoped patch over the user section (only touched fields present). */
  patch: Partial<Pick<SshConnectionsSettings, 'connections' | 'workspaceDefaults'>>
  /** The next full resolved value, for reads and messages. */
  next: SshConnectionsSettings
  /** Human-readable result message. */
  message: string
}

function trim(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Apply one ssh_connections action to the current namespace value.
 * @param current - the current resolved value.
 * @param args - the model arguments.
 * @param workspaceId - the calling workspace id; required by `use`.
 * @param configHosts - hosts discovered from ~/.ssh/config; shown read-only by
 *   `list` (never persisted, never touched by save/delete/use).
 * @returns the mutation (patch to persist + next value + message).
 */
export function applyConnectionsAction(
  current: SshConnectionsSettings,
  args: SshConnectionsArgs,
  workspaceId: string | undefined,
  configHosts?: readonly SshConfigHost[],
): SshConnectionsMutation {
  switch (args.action) {
    case 'list': {
      const lines = current.connections.map((connection) => {
        const port = connection.port !== undefined ? `:${connection.port}` : ''
        const user = connection.user !== undefined ? ` (user ${connection.user})` : ''
        const key = connection.keyPath !== undefined ? ` (key ${connection.keyPath})` : ''
        return `${connection.label}: ${connection.host}${port}${user}${key}`
      })
      let message = lines.length > 0 ? lines.join('\n') : 'no ssh connections saved'
      if ((configHosts ?? []).length > 0) {
        if (message.length > 0) message += '\n'
        message += 'from ~/.ssh/config (no save needed — pass the alias as ssh_exec `host`):\n'
          + (configHosts ?? []).map((host) => {
            const port = host.port !== undefined ? `:${host.port}` : ''
            const user = host.user !== undefined ? ` (user ${host.user})` : ''
            const key = host.identityFile !== undefined ? ` (key ${host.identityFile})` : ''
            return `- ${host.alias}: ${host.hostName}${port}${user}${key}`
          }).join('\n')
      }
      return {
        patch: {},
        next: current,
        message,
      }
    }

    case 'save': {
      const label = trim(args.label)
      const host = trim(args.host)
      const user = trim(args.user)
      const keyPath = trim(args.keyPath)
      if (label === undefined) throw new Error('invalid label: expected a non-empty string')
      if (host === undefined) throw new Error('invalid host: expected a non-empty string')
      if (args.port !== undefined && (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535)) {
        throw new Error(`invalid port: expected an integer between 1 and 65535, got ${JSON.stringify(args.port)}`)
      }
      if (keyPath !== undefined && !isAbsolute(keyPath)) {
        throw new Error(`invalid keyPath: expected an absolute path, got ${JSON.stringify(args.keyPath)}`)
      }
      if (current.connections.some(connection => connection.label === label)) {
        throw new Error(`ssh connection "${label}" already exists — delete it first to replace`)
      }
      const connection: SshConnection = {
        id: randomUUID(),
        label,
        host,
        ...args.port !== undefined ? { port: args.port } : {},
        ...user !== undefined ? { user } : {},
        ...keyPath !== undefined ? { keyPath } : {},
      }
      const next: SshConnectionsSettings = {
        ...current,
        connections: [...current.connections, connection],
      }
      return {
        patch: { connections: next.connections },
        next,
        message: `saved ssh connection "${label}" (${host})`,
      }
    }

    case 'delete': {
      const label = trim(args.label)
      if (label === undefined) throw new Error('invalid label: expected a non-empty string')
      const nextConnections = current.connections.filter(connection =>
        connection.label !== label && connection.id !== label)
      if (nextConnections.length === current.connections.length) {
        throw new Error(`unknown ssh connection "${label}"`)
      }
      const workspaceDefaults: Record<string, string> = {}
      for (const [id, bound] of Object.entries(current.workspaceDefaults)) {
        if (bound !== label) workspaceDefaults[id] = bound
      }
      const next: SshConnectionsSettings = { connections: nextConnections, workspaceDefaults }
      return {
        patch: { connections: next.connections, workspaceDefaults },
        next,
        message: `deleted ssh connection "${label}"`,
      }
    }

    case 'use': {
      if (workspaceId === undefined) {
        throw new Error('ssh_connections use: the workspace registry is unavailable in this deployment')
      }
      const label = trim(args.label)
      if (label === undefined) {
        const workspaceDefaults = Object.fromEntries(
          Object.entries(current.workspaceDefaults).filter(([id]) => id !== workspaceId),
        )
        const next: SshConnectionsSettings = { ...current, workspaceDefaults }
        return {
          patch: { workspaceDefaults },
          next,
          message: `cleared the default ssh connection for workspace ${workspaceId}`,
        }
      }
      const connection = current.connections.find(candidate =>
        candidate.label === label || candidate.id === label)
      if (connection === undefined) {
        throw new Error(`unknown ssh connection "${label}" (available: ${availableLabels(current)})`)
      }
      const workspaceDefaults: Record<string, string> = {
        ...current.workspaceDefaults,
        [workspaceId]: connection.id,
      }
      const next: SshConnectionsSettings = { ...current, workspaceDefaults }
      return {
        patch: { workspaceDefaults },
        next,
        message: `bound workspace ${workspaceId} to ssh connection "${label}"`,
      }
    }
  }
}

/**
 * Compose the ssh_connections tool's structured result from a mutation.
 * @param args - model action that produced the mutation.
 * @param mutation - resulting settings mutation.
 * @param workspaceId - calling workspace id, when available.
 * @param configHosts - read-only aliases included by a list response.
 * @returns structured tool output.
 */
export function composeConnectionsResult(
  args: SshConnectionsArgs,
  mutation: SshConnectionsMutation,
  workspaceId: string | undefined,
  configHosts?: readonly SshConfigHost[],
): SshConnectionsResult {
  const result: SshConnectionsResult = {
    ok: true,
    action: args.action,
    message: mutation.message,
  }
  if (args.action === 'list') {
    result.connections = mutation.next.connections
    if ((configHosts ?? []).length > 0) result.configHosts = [...(configHosts ?? [])]
  }
  if (args.action === 'use' && workspaceId !== undefined) {
    result.workspaceId = workspaceId
    const bound = mutation.next.workspaceDefaults[workspaceId]
    const connection = mutation.next.connections.find(candidate => candidate.id === bound)
    if (connection !== undefined) result.defaultLabel = connection.label
  }
  return result
}

/** Append a truncation note to a stream's text. */
function streamText(stream: { text: string; truncated: boolean; spillPath?: string }): string {
  if (!stream.truncated) return stream.text
  return `${stream.text}\n[output truncated; full output: ${stream.spillPath ?? '(unavailable)'}]`
}

/**
 * Render the ssh_exec structured result as model-facing text.
 * @param result - structured command outcome.
 * @returns text shown to the model.
 */
export function renderResult(result: SshExecResult): string {
  const out = streamText(result.stdout)
  const err = streamText(result.stderr)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'

  const markers = []
  if (result.sandbox?.denied === true) {
    markers.push(`[sandbox: file access denied under ${result.sandbox.mode} mode]`)
  }
  if (result.sandbox?.runnerFailed === true) {
    markers.push(`[sandbox: the sandbox runner itself failed under ${result.sandbox.mode} mode — the command did not run]`)
  }
  if (result.timedOut) markers.push(`[timed out after ${result.timeoutMs}ms]`)
  if (result.signal !== null) {
    markers.push(`[killed by signal: ${result.signal}]`)
  } else if (result.exitCode !== 0) {
    markers.push(`[exit code: ${result.exitCode}]`)
  }
  if (markers.length === 0) return body

  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * Render the ssh_connections structured result as model-facing text.
 * @param result - structured connection-management outcome.
 * @returns text shown to the model.
 */
export function renderConnectionsResult(result: SshConnectionsResult): string {
  let body = result.message
  if (result.connections !== undefined && result.connections.length > 0) {
    const lines = result.connections.map(connection =>
      `- ${connection.label}: ${connection.host}${connection.port !== undefined ? `:${connection.port}` : ''}`)
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += lines.join('\n')
  }
  if (result.configHosts !== undefined && result.configHosts.length > 0) {
    const lines = result.configHosts.map(host =>
      `- ${host.alias}: ${host.hostName}${host.port !== undefined ? `:${host.port}` : ''}`)
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `from ~/.ssh/config (no save needed — pass the alias as ssh_exec \`host\`):\n${lines.join('\n')}`
  }
  if (result.workspaceId !== undefined && result.defaultLabel !== undefined) {
    body += `\nworkspace default: ${result.defaultLabel} (${result.workspaceId})`
  }
  return body
}
