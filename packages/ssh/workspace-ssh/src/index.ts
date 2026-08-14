/**
 * SSH execution-world provider: registers the `ssh` provider in the
 * execution-world registry and implements the workspace-provider operations
 * (canonicalize, status, list, create, session root, location resolution)
 * over the framed transport. Per-location filesystem/subprocess backends are
 * built and cached here.
 * @module @deepseek-ai/dsh-workspace-ssh
 */

import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ExecutionError } from '@deepseek-ai/dsh-execution-location'
import type {
  ExecutionLocation,
  WorkspaceDirEntry,
  WorkspaceProviderOperations,
} from '@deepseek-ai/dsh-execution-location'
import type { ExecutionWorldProvider, ResolvedExecutionWorld } from '@deepseek-ai/dsh-execution-world'
import type { SshRuntime, SshTransport } from '@deepseek-ai/dsh-ssh'
import { sshLocation } from '@deepseek-ai/dsh-ssh'
import type { SshTargetReference } from '@deepseek-ai/dsh-ssh'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'workspace-ssh'

/** Services required to register the SSH execution-world provider. */
export const inject = ['executionWorlds', 'ssh']

/** Omit the signal key entirely when undefined (exact optional properties). */
function signalOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

/**
 * Parse and validate a location's SSH target reference.
 * @param location - execution location to inspect.
 * @param operation - caller name included in a provider mismatch error.
 * @returns a saved-connection or config-alias reference.
 */
export function parseSshTarget(location: ExecutionLocation, operation: string): SshTargetReference {
  if (location.providerId !== 'ssh') {
    throw new ExecutionError(
      `ssh provider cannot ${operation} for provider '${location.providerId}'`,
      'execution-provider-not-found',
    )
  }
  const target = location.target
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new ExecutionError('ssh location target must be a target reference object', 'workspace-provider-invalid-target')
  }
  const record = target as Record<string, unknown>
  if (record.kind === 'connection' && typeof record.connectionId === 'string' && record.connectionId.length > 0) {
    return { kind: 'connection', connectionId: record.connectionId }
  }
  if (record.kind === 'config' && typeof record.alias === 'string' && record.alias.length > 0) {
    return { kind: 'config', alias: record.alias }
  }
  throw new ExecutionError('ssh location target is not a valid target reference', 'workspace-provider-invalid-target')
}

/** Stable per-location cache key. */
function locationKey(location: ExecutionLocation): string {
  return `${location.providerId}\u0000${JSON.stringify(location.target)}\u0000${location.root}`
}

/**
 * The SSH workspace-provider operations for one runtime.
 * @param runtime - SSH runtime that owns transport lifetimes.
 * @returns workspace operations served over SSH.
 */
export function createSshWorkspaceOperations(runtime: SshRuntime): WorkspaceProviderOperations {
  return {
    async canonicalize(location, path, opts) {
      opts?.signal?.throwIfAborted()
      const reference = parseSshTarget(location, 'canonicalize')
      const absolute = posix.resolve(location.root, path)
      const transport = runtime.transportFor(location)
      try {
        const result = await transport.op('realpath', { path: absolute }, signalOpts(opts?.signal))
        const canonical = String(result.path)
        if (!posix.isAbsolute(canonical)) {
          throw new ExecutionError(`canonicalize returned a non-absolute path for '${absolute}'`, 'workspace-remote-path-invalid')
        }
        return canonical
      } catch (error) {
        if (error instanceof ExecutionError) throw error
        throw new ExecutionError(
          `cannot canonicalize '${absolute}' on ${describeReference(runtime, reference)}: ${String(error)}`,
          'workspace-remote-path-invalid',
          { cause: error },
        )
      }
    },

    async status(location, opts) {
      opts?.signal?.throwIfAborted()
      try {
        const result = await runtime.transportFor(location).op('stat', {
          path: location.root,
          follow: false,
        }, signalOpts(opts?.signal))
        if (result.missing === true) {
          return { kind: 'missing-dir', message: `'${location.root}' does not exist on the remote host` }
        }
        return result.type === 'directory'
          ? { kind: 'ok' }
          : { kind: 'missing-dir', message: `'${location.root}' is not a directory on the remote host` }
      } catch (error) {
        return { kind: 'unreachable', message: String(error) }
      }
    },

    async listDirectory(location, path, opts) {
      opts?.signal?.throwIfAborted()
      const absolute = posix.resolve(location.root, path)
      const result = await runtime.transportFor(location).op('list', { path: absolute }, signalOpts(opts?.signal))
      const entries = (result.entries as unknown[]).map((entry) => {
        const raw = entry as { name: string; type: string; size?: number }
        return {
          name: raw.name,
          type: raw.type as WorkspaceDirEntry['type'],
          ...raw.size !== undefined ? { size: raw.size } : {},
        }
      })
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    },

    async createDirectory(location, path, opts) {
      opts?.signal?.throwIfAborted()
      const absolute = posix.resolve(location.root, path)
      await runtime.transportFor(location).op('mkdir', { path: absolute }, signalOpts(opts?.signal))
    },

    async ensureSessionRoot(location) {
      const reference = parseSshTarget(location, 'ensureSessionRoot')
      const key = createHash('sha256')
        .update(JSON.stringify(reference))
        .digest('hex')
        .slice(0, 16)
      const root = posix.join(runtime.config.remoteStateDir, 'sessions', key)
      await runtime.transportFor(location).op('mkdir', { path: root })
      await runtime.transportFor(location).op('chmod', { path: root, mode: '700' })
      return root
    },

    async resolveLocation(input) {
      if (input.providerId !== 'ssh') {
        throw new ExecutionError(
          `ssh workspace provider cannot resolve provider '${input.providerId}'`,
          'workspace-provider-invalid-target',
        )
      }
      const target = input.target
      if (target === null || typeof target !== 'object' || Array.isArray(target)) {
        throw new ExecutionError('ssh workspace target must be a target reference object', 'workspace-provider-invalid-target')
      }
      const record = target as Record<string, unknown>
      let reference: SshTargetReference
      if (record.kind === 'connection' && typeof record.connectionId === 'string' && record.connectionId.length > 0) {
        reference = { kind: 'connection', connectionId: record.connectionId }
      } else if (record.kind === 'config' && typeof record.alias === 'string' && record.alias.length > 0) {
        reference = { kind: 'config', alias: record.alias }
      } else {
        throw new ExecutionError('ssh workspace target is not a valid target reference', 'workspace-provider-invalid-target')
      }
      if (typeof input.path !== 'string' || input.path.trim().length === 0) {
        throw new ExecutionError('workspace path must be a non-empty string', 'workspace-remote-path-invalid')
      }
      const probe: ExecutionLocation = {
        providerId: 'ssh',
        target: reference,
        root: posix.resolve(input.path),
      }
      // The directory must exist remotely; a missing path rejects.
      const canonical = await this.canonicalize(probe, '.')
      const label = runtime.labelOf(reference)
      const host = reference.kind === 'config'
        ? reference.alias
        : runtime.connection(reference.connectionId)?.host
      return sshLocation(reference, canonical, label, host)
    },
  }
}

function describeReference(runtime: SshRuntime, reference: SshTargetReference): string {
  return runtime.labelOf(reference) ?? JSON.stringify(reference)
}

/** The ssh execution-world provider: one instance per runtime. */
export class SshExecutionWorldProvider implements ExecutionWorldProvider {
  readonly id = 'ssh'
  readonly label = 'SSH'
  readonly capabilities = { filesystem: true, subprocess: true, workspace: true }
  readonly workspace: WorkspaceProviderOperations

  private readonly worlds = new Map<string, ResolvedExecutionWorld & { transport: SshTransport; sessionRoot: string }>()

  constructor(private readonly runtime: SshRuntime) {
    this.workspace = createSshWorkspaceOperations(runtime)
  }

  resolve(location: ExecutionLocation): ResolvedExecutionWorld {
    parseSshTarget(location, 'resolve')
    const key = locationKey(location)
    let world = this.worlds.get(key)
    if (world === undefined) {
      const transport = this.runtime.transportFor(location)
      const sessionRoot = this.runtime.config.remoteStateDir
      world = {
        location,
        transport,
        sessionRoot,
        filesystem: new SshFileSystem(location, transport, sessionRoot),
        subprocess: new SshSubprocessRuntime(location, transport, sessionRoot),
      }
      this.worlds.set(key, world)
    }
    return world
  }

  defaultLocation(): ExecutionLocation {
    // SSH worlds are always connection-anchored; there is no default root.
    throw new ExecutionError(
      'ssh provider has no default location — pass an explicit ssh execution location',
      'execution-provider-not-found',
    )
  }

  /** Dispose every constructed backend (terminates live remote processes). */
  async dispose(): Promise<void> {
    const pending: Promise<unknown>[] = []
    for (const world of this.worlds.values()) {
      const subprocess = world.subprocess as SshSubprocessRuntime | undefined
      if (subprocess !== undefined) pending.push(subprocess.dispose().catch(() => undefined))
    }
    await Promise.allSettled(pending)
    this.worlds.clear()
  }
}

/**
 * Register the ssh provider into the execution-world registry.
 * @param ctx - host context with `executionWorlds` and `ssh` mounted.
 */
export function apply(ctx: Context): void {
  const registry = ctx.executionWorlds
  const runtime = ctx.ssh
  const provider = new SshExecutionWorldProvider(runtime)
  ctx.effect(() => registry.register(provider), 'execution-worlds/ssh')
  ctx.effect(() => () => { void provider.dispose() }, 'execution-worlds/ssh/backends')
}
