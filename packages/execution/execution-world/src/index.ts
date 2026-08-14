/**
 * Execution-world Service Definition (`ctx.executionWorlds`): the routing layer
 * between JSON-persistable execution locations and the live filesystem /
 * subprocess / workspace backends of one execution world. Local, E2B, and SSH
 * providers register their capabilities here; consumers resolve a location
 * (usually a session's persisted execution location) and operate on the
 * returned backends, so `ctx.fs` + `ctx.subprocess` always belong to the same
 * world as the session.
 *
 * Default calls keep working without a location: `resolve(undefined)` routes
 * to the built-in `local` provider, preserving non-session behavior.
 * @module @deepseek-ai/dsh-execution-world
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { ExecutionError, LOCAL_PROVIDER_ID } from '@deepseek-ai/dsh-execution-location'
import type { ExecutionLocation, WorkspaceProviderOperations } from '@deepseek-ai/dsh-execution-location'
import type {
  ExecutionWorldProvider,
  ResolvedExecutionWorld,
} from './types.ts'

export {
  E2B_PROVIDER_ID,
  ExecutionError,
  LOCAL_PROVIDER_ID,
  SSH_PROVIDER_ID,
  executionLocationEquals,
  localLocation,
} from '@deepseek-ai/dsh-execution-location'
export type {
  ExecutionCapabilities,
  ExecutionErrorCode,
  ExecutionJsonValue,
  ExecutionLocation,
  WorkspaceDirEntry,
  WorkspaceProviderOperations,
  WorkspaceStatus,
} from '@deepseek-ai/dsh-execution-location'
export type { ExecutionWorldProvider, ResolvedExecutionWorld } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    executionWorlds: ExecutionWorldRegistry
  }

  interface Events {
    /**
     * A provider registered (or re-registered after disposal). Emitted with
     * the provider object; UI capability status listens for this.
     * @param provider - the registered provider.
     * @mode emit
     */
    'execution-worlds/registered'(provider: ExecutionWorldProvider): void
    /**
     * A provider was unregistered and its routes disappeared.
     * @param id - the removed provider id.
     * @mode emit
     */
    'execution-worlds/unregistered'(id: string): void
  }
}

/**
 * The execution-world registry: one registered provider per stable id,
 * effect-scoped registration, duplicate-id rejection, and location routing.
 */
export class ExecutionWorldRegistry extends Service {
  private readonly providers = new Map<string, ExecutionWorldProvider>()

  constructor(ctx: Context) {
    super(ctx, 'executionWorlds')
  }

  /**
   * Register one execution-world provider. Registration is effect-scoped: the
   * returned disposer (and the enclosing cordis effect scope) removes the
   * provider and every route to it.
   * @param provider - the provider to register; its id must be unique.
   * @returns the disposer unregistering this provider (idempotent).
   * @throws a plain `Error` when the id is empty or already registered.
   */
  register(provider: ExecutionWorldProvider): () => void {
    const id = provider.id
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('execution world provider id must be a non-empty string')
    }
    if (this.providers.has(id)) {
      throw new Error(`execution world provider '${id}' is already registered`)
    }
    this.providers.set(id, provider)
    this.ctx.emit('execution-worlds/registered', provider)
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      // A replacement registration must not be removed by an earlier disposer.
      if (this.providers.get(id) !== provider) return
      this.providers.delete(id)
      this.ctx.emit('execution-worlds/unregistered', id)
    }
    this.ctx.effect(() => dispose, `execution-worlds/${id}`)
    return dispose
  }

  /**
   * Look up one registered provider.
   * @param id - provider id.
   * @returns the provider, or `undefined` when unknown.
   */
  provider(id: string): ExecutionWorldProvider | undefined {
    return this.providers.get(id)
  }

  /**
   * The registered providers in registration order — the capability status
   * surface for Host APIs and the UI.
   * @returns a fresh array of providers.
   */
  listProviders(): ExecutionWorldProvider[] {
    return [...this.providers.values()]
  }

  /**
   * Resolve a location to its live backends. The location must name a
   * registered provider; the provider interprets its own target and path
   * syntax.
   * @param location - the location to resolve; `undefined` routes to the
   *   built-in `local` provider's default location.
   * @returns the resolved world with its backends.
   * @throws {@link ExecutionError} with `execution-provider-not-found` when
   *   the provider is unknown or the local default is not registered.
   */
  resolve(location?: ExecutionLocation): ResolvedExecutionWorld {
    const provider = this.resolveProvider(location)
    return provider.resolve(location ?? provider.defaultLocation())
  }

  /**
   * Resolve the workspace-provider operations for one location.
   * @param location - the location to resolve; `undefined` routes to local.
   * @returns the workspace operations.
   * @throws {@link ExecutionError} with `execution-provider-not-found` when
   *   the provider is unknown, and `execution-unavailable` when the provider
   *   registers no workspace capability.
   */
  workspace(location?: ExecutionLocation): WorkspaceProviderOperations {
    const provider = this.resolveProvider(location)
    return this.workspaceOfProvider(provider)
  }

  /**
   * Resolve the workspace-provider operations of one named provider, without
   * a location — the create-input path, where the location does not exist yet.
   * @param providerId - provider id.
   * @returns the workspace operations.
   * @throws {@link ExecutionError} with `execution-provider-not-found` when
   *   the provider is unknown, and `execution-unavailable` when the provider
   *   registers no workspace capability.
   */
  workspaceOf(providerId: string): WorkspaceProviderOperations {
    const provider = this.providers.get(providerId)
    if (provider === undefined) {
      throw new ExecutionError(
        `execution provider '${providerId}' is not registered`,
        'execution-provider-not-found',
      )
    }
    return this.workspaceOfProvider(provider)
  }

  /** Resolve the provider a location (or the local default) names. */
  private resolveProvider(location: ExecutionLocation | undefined): ExecutionWorldProvider {
    const id = location?.providerId ?? LOCAL_PROVIDER_ID
    const provider = this.providers.get(id)
    if (provider === undefined) {
      throw new ExecutionError(
        location === undefined
          ? `the local execution provider '${LOCAL_PROVIDER_ID}' is not registered — load fs-local/subprocess-local or the local provider plugin`
          : `execution provider '${id}' is not registered`,
        'execution-provider-not-found',
      )
    }
    return provider
  }

  private workspaceOfProvider(provider: ExecutionWorldProvider): WorkspaceProviderOperations {
    const ops = provider.workspace
    if (ops === undefined) {
      throw new ExecutionError(
        `execution provider '${provider.id}' registers no workspace capability`,
        'execution-unavailable',
      )
    }
    return ops
  }
}

export default ExecutionWorldRegistry
