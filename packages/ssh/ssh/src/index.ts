/**
 * SSH runtime Service Definition (`ctx.ssh`): persisted connection settings,
 * ~/.ssh/config discovery, and per-connection transports. The service is
 * best-effort by design: a missing system ssh client, an unreadable config,
 * or no saved connections never blocks harness startup — the capability
 * status is exposed for Host APIs and the UI.
 * @module @deepseek-ai/dsh-ssh
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ExecutionError } from '@deepseek-ai/dsh-execution-location'
import type { ExecutionLocation } from '@deepseek-ai/dsh-execution-location'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import { discoverSshConfigHosts } from './discovery.ts'
import { migrateConnectionsSettings, resolveConfig, resolveTarget } from './model.ts'
import type { SshTarget } from './model.ts'
import { SshConnectionsSettingsSchema, validateConnections } from './schema.ts'
import { SshTransport, createSystemSshSpawner } from './transport.ts'
import type { SshChannel, SshSpawner, SshTransportTarget } from './transport.ts'
import type { SshConfig, SshConfigHost, SshConnection, SshConnectionsSettings, SshTargetReference } from './types.ts'
import { SSH_CONNECTIONS_NS } from './types.ts'

export {
  SSH_HELPER_PROTOCOL_VERSION,
  helperFileName,
  renderHelperSource,
} from './helper.ts'
export { parseSshConfig } from './config.ts'
export { discoverSshConfigHosts, readSshConfig, resolveSshConfigPath } from './discovery.ts'
export { encodeFrame, FrameReader } from './frames.ts'
export {
  SshTransport,
  SshTransportError,
  createSystemSshSpawner,
} from './transport.ts'
export type { SshChannel, SshOpResponse, SshSpawner, SshTransportTarget } from './transport.ts'
export {
  applyConnectionsAction,
  buildSshCommand,
  composeConnectionsResult,
  migrateConnectionsSettings,
  renderConnectionsResult,
  renderResult,
  resolveConfig,
  resolveTarget,
  validateExecArgs,
} from './model.ts'
export type {
  SshConnectionsMutation,
  SshConnectionsResult,
  SshExecResult,
  SshTarget,
} from './model.ts'
export { SshConnectionSchema, SshConnectionsSettingsSchema, validateConnections } from './schema.ts'
export type { SshConfig, SshConfigHost, SshConnection, SshConnectionsSettings, SshExecArgs, SshConnectionsArgs, SshTargetReference } from './types.ts'
export { SSH_CONNECTIONS_NS } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    ssh: SshRuntime
  }
}

/** The `ssh` transport argument validation used by every adapter. */
function assertSshLocation(location: ExecutionLocation, operation: string): SshTargetReference {
  if (location.providerId !== 'ssh') {
    throw new ExecutionError(
      `ssh adapter cannot ${operation} for provider '${location.providerId}' — the routing layer selected the wrong backend`,
      'execution-provider-not-found',
    )
  }
  const target = location.target
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new ExecutionError('ssh location target must be a target reference object', 'workspace-provider-invalid-target')
  }
  const reference = target as Record<string, unknown>
  if (reference.kind === 'connection' && typeof reference.connectionId === 'string') {
    return { kind: 'connection', connectionId: reference.connectionId }
  }
  if (reference.kind === 'config' && typeof reference.alias === 'string') {
    return { kind: 'config', alias: reference.alias }
  }
  throw new ExecutionError('ssh location target is not a valid target reference', 'workspace-provider-invalid-target')
}

interface ResolvedSshConfig {
  timeoutMs: number
  connectTimeout: number
  remoteStateDir: string
  sshConfigPath: string | undefined
}

interface SchemaResolvedConfig extends SshConfig {
  timeoutMs: number
  connectTimeout: number
  remoteStateDir: string
}

/** Whether the persisted user layer still has a connection record without a stable id. */
function hasLegacyConnectionIds(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const connections = (value as Record<string, unknown>).connections
  if (!Array.isArray(connections)) return false
  return connections.some((connection) => {
    if (typeof connection !== 'object' || connection === null || Array.isArray(connection)) return true
    const id = (connection as Record<string, unknown>).id
    return typeof id !== 'string' || id.length === 0
  })
}

/**
 * Build an ssh execution location for a connection or config alias.
 * @param reference - the stable target reference.
 * @param root - the canonical remote root directory.
 * @param label - optional display label (connection label or alias).
 * @param host - optional display host.
 * @returns an SSH execution location for the target.
 */
export function sshLocation(
  reference: SshTargetReference,
  root: string,
  label?: string,
  host?: string,
): ExecutionLocation {
  return {
    providerId: 'ssh',
    target: reference,
    root,
    ...(label !== undefined || host !== undefined
      ? { display: { ...label !== undefined ? { label } : {}, ...host !== undefined ? { host } : {} } }
      : {}),
  }
}

/**
 * The SSH runtime: connection registry over the `ssh-connections` settings
 * namespace (with legacy migration), read-only ~/.ssh/config aliases, and
 * per-connection transport instances.
 */
export class SshRuntime extends Service {
  static Config: z<SshConfig> = z.object({
    timeoutMs: z.number().default(30000),
    connectTimeout: z.number().default(15),
    sshConfigPath: z.string(),
    remoteStateDir: z.string().default('.dsh-ssh'),
  })

  /** Resolved SSH runtime settings used by transports and tools. */
  readonly config: ResolvedSshConfig
  private readonly transports = new Map<string, SshTransport>()
  private scope: SettingsScope<SshConnectionsSettings> | undefined
  private memory: SshConnectionsSettings = { connections: [], workspaceDefaults: {} }
  private readonly spawner: SshSpawner
  private sshPresent: boolean | undefined
  private sshProbe: Promise<boolean> | undefined

  constructor(ctx: Context, config: SshConfig) {
    super(ctx, 'ssh')
    const resolved = config as SchemaResolvedConfig
    const numbers = resolveConfig(config)
    this.config = {
      timeoutMs: numbers.timeoutMs,
      connectTimeout: numbers.connectTimeout,
      remoteStateDir: resolved.remoteStateDir,
      sshConfigPath: config.sshConfigPath,
    }
    this.spawner = createSystemSshSpawner()

    // Optional settings wiring: runs only where a settings service is mounted.
    ctx.inject(['settings'], (sctx) => {
      const scope = sctx.settings.register<SshConnectionsSettings>(
        settingsNamespace(SSH_CONNECTIONS_NS),
        SshConnectionsSettingsSchema,
        { validate: validateConnections },
      )
      this.scope = scope
      const migrate = () => { this.migrateLegacy(scope, sctx.settings) }
      migrate()
      scope.watch(migrate)
    })

    ctx.effect(() => () => {
      for (const transport of this.transports.values()) transport.close()
      this.transports.clear()
    }, 'ssh runtime teardown')
  }

  /** Migrate legacy (label-keyed) settings and persist when changed. */
  private migrateLegacy(scope: SettingsScope<SshConnectionsSettings>, settings: Pick<SettingsProvider, 'describe'>): void {
    const current = scope.get()
    const migrated = migrateConnectionsSettings(current)
    const raw = settings.describe().find(descriptor => String(descriptor.ns) === SSH_CONNECTIONS_NS)?.user
    if (hasLegacyConnectionIds(raw) || JSON.stringify(migrated) !== JSON.stringify(current)) {
      void scope.replace({ connections: migrated.connections, workspaceDefaults: migrated.workspaceDefaults })
        .catch((error: unknown) => {
          this.ctx.logger.warn(`ssh-connections migration could not persist: ${String(error)}`)
        })
    }
  }

  /** The resolved connections (from settings when mounted, else memory). */
  private settingsValue(): SshConnectionsSettings {
    return this.scope?.get() ?? this.memory
  }

  /**
   * The mounted settings scope, when a settings service exists.
   * @returns the writable scope, or `undefined` without settings.
   */
  connectionsScope(): SettingsScope<SshConnectionsSettings> | undefined {
    return this.scope
  }

  /**
   * The resolved connections settings value (mounted scope or memory).
   * @returns the current connection settings.
   */
  connectionsSettings(): SshConnectionsSettings {
    return this.settingsValue()
  }

  /**
   * Probe for a usable system ssh client. Cached; never throws.
   * @returns true when `ssh` is on PATH and starts.
   */
  sshAvailable(): Promise<boolean> {
    if (this.sshPresent !== undefined) return Promise.resolve(this.sshPresent)
    this.sshProbe ??= new Promise<boolean>((resolve) => {
      const channel: SshChannel = this.spawner(['ssh', '-V'])
      let stderr = ''
      const timer = setTimeout(() => { channel.close(); resolve(false) }, 5000)
      channel.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      void channel.exit.then(({ code }) => {
        clearTimeout(timer)
        // ssh -V prints to stderr and exits 0; some builds exit 1 with output.
        this.sshPresent = code === 0 || stderr.toLowerCase().includes('openssh')
        resolve(this.sshPresent)
      })
    })
    return this.sshProbe
  }

  /**
   * All saved connections in save order.
   * @returns the current connection records.
   */
  listConnections(): SshConnection[] {
    return this.settingsValue().connections
  }

  /**
   * Hosts discovered from ~/.ssh/config (read-only).
   * @returns discovered aliases and their resolved facts.
   */
  listConfigHosts(): Promise<SshConfigHost[]> {
    return discoverSshConfigHosts(this.config.sshConfigPath)
  }

  /**
   * Resolve a connection by id or label.
   * @param idOrLabel - stable connection id or display label.
   * @returns the matching connection, or `undefined`.
   */
  connection(idOrLabel: string): SshConnection | undefined {
    return this.settingsValue().connections.find(candidate =>
      candidate.id === idOrLabel || candidate.label === idOrLabel)
  }

  /**
   * The workspace default connection id for one workspace, when bound.
   * @param workspaceId - stable workspace id.
   * @returns the bound connection id, or `undefined`.
   */
  workspaceDefault(workspaceId: string): string | undefined {
    return this.settingsValue().workspaceDefaults[workspaceId]
  }

  /**
   * Resolve a target reference into concrete transport facts.
   * @param reference - saved connection or OpenSSH config alias reference.
   * @returns host, port, key, and timeout values for a transport.
   */
  resolveReference(reference: SshTargetReference): SshTransportTarget {
    if (reference.kind === 'config') {
      return {
        host: reference.alias,
        port: 22,
        connectTimeout: this.config.connectTimeout,
      }
    }
    const connection = this.connection(reference.connectionId)
    if (connection === undefined) {
      throw new ExecutionError(
        `unknown ssh connection '${reference.connectionId}'`,
        'workspace-provider-invalid-target',
      )
    }
    const effectiveHost = connection.user !== undefined && !connection.host.includes('@')
      ? `${connection.user}@${connection.host}`
      : connection.host
    return {
      host: effectiveHost,
      port: connection.port ?? 22,
      ...connection.keyPath !== undefined ? { keyPath: connection.keyPath } : {},
      connectTimeout: this.config.connectTimeout,
    }
  }

  /**
   * Resolve the SSH target reference carried by one execution location.
   * @param location - SSH execution location to inspect.
   * @param operation - caller name included in a provider mismatch error.
   * @returns the validated saved-connection or config-alias reference.
   */
  referenceOf(location: ExecutionLocation, operation: string = 'resolve'): SshTargetReference {
    return assertSshLocation(location, operation)
  }

  /**
   * Display label of one location's reference, when resolvable.
   * @param reference - saved connection or config alias reference.
   * @returns a user-facing label, or `undefined` for a missing connection.
   */
  labelOf(reference: SshTargetReference): string | undefined {
    if (reference.kind === 'connection') return this.connection(reference.connectionId)?.label
    return reference.alias
  }

  /**
   * The transport for one execution location (per-reference instances are
   * cached and closed at service disposal).
   * @param location - an ssh execution location.
   * @returns the live transport; lazily connected.
   */
  transportFor(location: ExecutionLocation): SshTransport {
    const reference = this.referenceOf(location)
    const key = reference.kind === 'connection' ? reference.connectionId : `config:${reference.alias}`
    let transport = this.transports.get(key)
    if (transport === undefined) {
      transport = new SshTransport({
        target: this.resolveReference(reference),
        remoteStateDir: this.config.remoteStateDir,
        spawner: this.spawner,
        opTimeoutMs: this.config.timeoutMs,
      })
      this.transports.set(key, transport)
    }
    return transport
  }

  /**
   * Close and forget one connection's transport after a connection mutation.
   * @param reference - target whose cached transport must be released.
   */
  invalidateTransport(reference: SshTargetReference): void {
    const key = reference.kind === 'connection' ? reference.connectionId : `config:${reference.alias}`
    this.transports.get(key)?.close()
    this.transports.delete(key)
  }

  /**
   * Resolve the effective target for ssh_exec-style calls: explicit host →
   * explicit connection → workspace default.
   * @param args - model arguments.
   * @param workspaceDefaultId - the calling workspace's default connection id.
   * @returns the resolved target (host string form for ssh argv).
   */
  resolveExecTarget(
    args: { host?: string; connection?: string },
    workspaceDefaultId: string | undefined,
  ): Promise<SshTarget> {
    return Promise.resolve(resolveTarget(args, this.settingsValue(), workspaceDefaultId))
  }
}

export default SshRuntime
