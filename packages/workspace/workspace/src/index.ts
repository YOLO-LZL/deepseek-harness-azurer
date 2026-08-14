/**
 * Workspace entity registry (`ctx.workspaceRegistry`): durable workspace records,
 * stable registry order, and header-validated session membership over the
 * domain data form. Workspaces live in execution worlds: a record carries its
 * JSON-persistable execution location, and membership compares canonical
 * locations (not host realpaths), so remote (SSH) workspaces are first-class.
 * @module @deepseek-ai/dsh-workspace
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { ExecutionError, executionLocationEquals, localLocation } from '@deepseek-ai/dsh-execution-world'
import type {
  ExecutionJsonValue,
  ExecutionLocation,
  ExecutionWorldRegistry,
} from '@deepseek-ai/dsh-execution-world'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceEntity } from './entity.ts'
import type { WorkspaceEntityHost } from './entity.ts'
import { locationOfRecord } from './location.ts'

export { WorkspaceMoveInvalidError } from './entity.ts'
import { realpathNormalize } from './paths.ts'
import { workspaceDomainSpec } from './spec.ts'
import type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
import type { Workspace, WorkspaceId as WorkspaceIdBrand } from './types.ts'

export type { Workspace } from './types.ts'
export { workspaceDomainState, workspaceRecord, workspaceDomainSpec } from './spec.ts'
export type { WorkspaceDomainState, WorkspaceRecord } from './spec.ts'
export { realpathNormalize } from './paths.ts'
export { locationOfRecord } from './location.ts'

/** Identifies one workspace record (see `src/types.ts` for the brand rationale). */
export type WorkspaceId = WorkspaceIdBrand

/**
 * Brand a string as a {@link WorkspaceId}.
 * @param id - Raw workspace id string.
 * @returns the same string, branded at compile time.
 */
export function WorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId
}

/**
 * A workspace create request. `local` names a host directory (the pre-provider
 * shape); `provider` names a target in a registered execution world whose
 * provider validates the target and path strictly. The generic RPC schema
 * bounds JSON depth/size; the provider performs the business validation.
 */
export type WorkspaceCreateInput =
  | { readonly kind: 'local'; readonly path: string }
  | {
    readonly kind: 'provider'
    readonly providerId: string
    readonly target: ExecutionJsonValue
    readonly path: string
  }

/**
 * An archiveSession request named a session neither live nor in session
 * persistence — a definite miss only; storage faults propagate as themselves.
 */
export class WorkspaceUnknownSessionError extends Error {
  /**
   * @param sessionId - The unknown session id.
   */
  constructor(readonly sessionId: SessionId) {
    super(`cannot archive session '${sessionId}': live sessions and session persistence hold no such session`)
    this.name = 'WorkspaceUnknownSessionError'
  }
}

/** A workspace reorder named a source or anchor absent from the durable registry order. */
export class WorkspaceOrderInvalidError extends Error {
  /**
   * @param workspaceId - Missing source or anchor id.
   */
  constructor(readonly workspaceId: WorkspaceId) {
    super(`cannot reorder unknown workspace '${workspaceId}'`)
    this.name = 'WorkspaceOrderInvalidError'
  }
}


declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceRegistry: WorkspaceRegistry
  }
}

interface BootstrapGroup {
  readonly location: ExecutionLocation
  readonly headers: SessionHeader[]
  newestAt: number
}

const sameIds = (left: readonly WorkspaceId[], right: readonly WorkspaceId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

const compareHeaders = (left: SessionHeader, right: SessionHeader): number =>
  right.createdAt - left.createdAt || String(left.id).localeCompare(String(right.id))

/**
 * Stable group key of one execution location: provider, JSON target, and root.
 * This is the membership canon for both local and remote workspaces.
 */
function locationKey(location: ExecutionLocation): string {
  return `${location.providerId}\u0000${JSON.stringify(location.target)}\u0000${location.root}`
}

/**
 * Durable workspace registry. Startup waits for `sessionPersistence`, builds
 * one canonical-location header index, and completes the one-time history
 * bootstrap before the service becomes active. The persistence dependency is
 * mandatory so an unavailable peer can never be mistaken for an empty
 * history and commit the initialized marker.
 *
 * The registry delegates workspace-provider operations (canonicalize,
 * validate/status, list, create, ensureSessionRoot, location resolution) to
 * the execution-world registry when one is mounted; without it, local
 * create/resolve fall back to this package's original realpath/stat path.
 */
export class WorkspaceRegistry extends Service {
  static inject = ['storageDomain', 'sessionPersistence']

  private table?: KvTable<WorkspaceId, WorkspaceRecord>
  private global?: DomainGlobal<WorkspaceDomainState>
  private state?: WorkspaceDomainState
  private readonly entities = new Map<WorkspaceId, WorkspaceEntity>()
  private readonly headers = new Map<SessionId, SessionHeader>()
  private readonly sessionLocations = new Map<SessionId, ExecutionLocation>()
  private readonly invalidSessionLocations = new Map<SessionId, string>()
  private operationTail: Promise<void> = Promise.resolve()

  private readonly host: WorkspaceEntityHost = {
    table: () => this.requireTable(),
    sessionLocation: id => this.sessionLocations.get(id),
    readSessionHeader: id => this.readSessionHeader(id),
    canonicalizeLocation: header => this.canonicalizeLocation(header),
    rememberSessionLocation: (id, location) => {
      this.sessionLocations.set(id, location)
      this.invalidSessionLocations.delete(id)
    },
  }

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  /** Open the domain, finish bootstrap when required, and rebuild the ordered cache. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    this.table = domain.table('workspaces')
    this.global = domain.global
    this.state = domain.global.get()

    await this.recoverPendingMutation()
    this.validateStoredState(this.state)
    if (!this.state.initialized) {
      const headers = await this.ctx.sessionPersistence.list()
      await this.replaceHeaderIndex(headers)
      await this.bootstrap(headers)
    } else if (this.table.size > 0) {
      await this.replaceHeaderIndex(await this.ctx.sessionPersistence.list())
    }

    await this.indexLiveSessions()
    this.validateStoredState(this.requireState())
    this.rebuildEntities()
    this.reportFilteredCandidates()
  }

  /**
   * Create or reuse a workspace. The input names either a host directory
   * (`kind: 'local'`) or a target in a registered execution world
   * (`kind: 'provider'`); the owning workspace provider canonicalizes and
   * validates the location. A nonexistent path rejects; repeated calls for
   * the same canonical location return the existing entity without changing
   * its title. A newly created workspace is prepended to the durable
   * registry order. Different canonical locations may share a display title.
   * @param input - Discriminated create request (local path or provider target).
   * @param title - Display title used only when a new record is created.
   * @returns the existing or newly durable workspace.
   */
  // TODO: `title` lost its last production caller when the gateway's
  // create-by-name branch was deleted
  // (.agents/notes/implemented/simplification/2026-07-31-one-route-to-add-a-workspace.md);
  // drop the parameter with its @param clause and the `create(path, title?)`
  // lines in this package's README pair.
  async create(input: WorkspaceCreateInput, title?: string): Promise<Workspace> {
    const location = await this.resolveCreateLocation(input)
    return await this.enqueueOperation(() => this.createCanonical(location, title))
  }

  /**
   * Look up a workspace by id.
   * @param id - Workspace id.
   * @returns the workspace, or `undefined` when unknown.
   */
  get(id: WorkspaceId): Workspace | undefined {
    return this.entities.get(id)
  }

  /**
   * Synchronous workspace projection in durable registry order. Every
   * entity's `sessionIds` getter is already filtered by the startup/live
   * canonical-location header index; this method performs no persistence
   * reads.
   * @returns a fresh ordered array of workspace entities.
   */
  list(): Workspace[] {
    return this.requireState().workspaceIds.map((id) => {
      const entity = this.entities.get(id)
      if (entity === undefined) {
        throw new Error(`workspace registry order references missing workspace '${id}'`)
      }
      return entity
    })
  }

  /**
   * Delete one workspace registration while retaining its directory and every
   * session log. The durable order is updated before the table deletion; a
   * failed table write restores the prior order and keeps the entity
   * published. Unknown ids are an idempotent no-op for domain callers.
   * @param id - Workspace registration to remove.
   * @returns `true` when a record was deleted, `false` when it was unknown.
   */
  delete(id: WorkspaceId): Promise<boolean> {
    return this.enqueueOperation(() => this.deleteKnown(id))
  }

  /**
   * Move one workspace within the durable display order, DOM-insertBefore-like.
   * With an anchor it lands before that workspace; without one it appends.
   * @param id - Workspace to move.
   * @param beforeId - Workspace anchor; omitted appends.
   * @returns the complete committed workspace order.
   */
  insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]> {
    return this.enqueueOperation(async () => {
      const state = this.requireState()
      if (!state.workspaceIds.includes(id)) throw new WorkspaceOrderInvalidError(id)
      if (beforeId !== undefined && !state.workspaceIds.includes(beforeId)) {
        throw new WorkspaceOrderInvalidError(beforeId)
      }
      if (beforeId === id) return state.workspaceIds
      const without = state.workspaceIds.filter(workspaceId => workspaceId !== id)
      const at = beforeId === undefined ? without.length : without.indexOf(beforeId)
      const workspaceIds = [...without.slice(0, at), id, ...without.slice(at)]
      if (sameIds(workspaceIds, state.workspaceIds)) return state.workspaceIds
      await this.setState({ ...state, workspaceIds })
      return workspaceIds
    })
  }

  /**
   * The registry-global archive set: sessions hidden from every grouping
   * surface. Archiving never touches workspace accounting — an archived
   * session keeps its `sessionIds` slot so unarchiving restores its position.
   * @returns the archived session ids in archive order.
   */
  get archivedSessionIds(): readonly SessionId[] {
    return this.requireState().archivedSessionIds
  }

  /**
   * Archive one session durably. The session must exist (live or in session
   * persistence); its workspace accounting — or lack of one — is irrelevant.
   * An already archived id resolves without writing.
   * @param sessionId - The session to archive.
   * @returns resolution after durability.
   */
  archiveSession(sessionId: SessionId): Promise<void> {
    return this.enqueueOperation(async () => {
      // The chain slot serializes against every other registry write, so this
      // check-then-write pair cannot interleave with another archive.
      if (this.requireState().archivedSessionIds.includes(sessionId)) return
      if (!(await this.sessionKnown(sessionId))) {
        throw new WorkspaceUnknownSessionError(sessionId)
      }
      const state = this.requireState()
      await this.setState({ ...state, archivedSessionIds: [...state.archivedSessionIds, sessionId] })
    })
  }

  /**
   * Whether a session is live, header-indexed, or present in a fresh
   * persistence listing. Only a definite miss returns false — a failing
   * `sessionPersistence.list()` propagates so storage faults never
   * masquerade as an unknown session.
   */
  private async sessionKnown(id: SessionId): Promise<boolean> {
    if (this.ctx.get('sessions')?.get(id) !== undefined) return true
    if (this.headers.has(id)) return true
    await this.indexHeaders(await this.ctx.sessionPersistence.list())
    return this.headers.has(id)
  }

  /**
   * Resolve by canonical directory path without creating or mutating a
   * workspace. Only local workspaces are addressable by host path: the path
   * is canonicalized through the local provider (or this package's fallback)
   * and matched against local records.
   * @param path - Existing directory path in any spelling.
   * @returns the workspace owning the canonical path, when one exists.
   */
  async resolveByPath(path: string): Promise<Workspace | undefined> {
    const location = await this.resolveLocalPathLocation(path)
    for (const entity of this.entities.values()) {
      if (executionLocationEquals(entity.location, location)) return entity
    }
    return undefined
  }

  /**
   * Resolve by execution location without creating or mutating a workspace.
   * Remote (SSH) workspaces are only addressable this way — their directories
   * are not host paths. The location must match a record canonically.
   * @param location - the execution location to match.
   * @returns the workspace owning the location, when one exists.
   */
  resolveByLocation(location: ExecutionLocation): Workspace | undefined {
    for (const entity of this.entities.values()) {
      if (executionLocationEquals(entity.location, location)) return entity
    }
    return undefined
  }

  /** Canonicalize a host path into a local execution location (provider or fallback). */
  private async resolveLocalPathLocation(path: string): Promise<ExecutionLocation> {
    const worlds = this.executionWorlds()
    if (worlds !== undefined) {
      return await worlds.workspaceOf('local').resolveLocation({
        providerId: 'local',
        target: null,
        path,
      })
    }
    const canonical = await realpathNormalize(path)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`cannot resolve a workspace at '${canonical}': path is not a directory`)
    }
    return localLocation(canonical)
  }

  /** Validate and canonicalize a create input through the owning workspace provider. */
  private async resolveCreateLocation(input: WorkspaceCreateInput): Promise<ExecutionLocation> {
    const worlds = this.executionWorlds()
    if (worlds === undefined) {
      if (input.kind !== 'local') {
        throw new ExecutionError(
          'no execution-world registry is mounted; remote workspace creation is unavailable',
          'execution-provider-not-found',
        )
      }
      return await this.resolveLocalPathLocation(input.path)
    }
    const providerInput = input.kind === 'local'
      ? { providerId: 'local', target: null as ExecutionJsonValue, path: input.path }
      : { providerId: input.providerId, target: input.target, path: input.path }
    const ops = worlds.workspaceOf(providerInput.providerId)
    return await ops.resolveLocation(providerInput)
  }

  private async createCanonical(location: ExecutionLocation, title?: string): Promise<WorkspaceEntity> {
    for (const entity of this.entities.values()) {
      if (executionLocationEquals(entity.location, location)) return entity
    }

    const workspaceName = title ?? basename(location.root)
    const table = this.requireTable()
    const state = this.requireState()
    const id = WorkspaceId(randomUUID())
    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      path: location.root,
      title: workspaceName,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
      location,
    }
    const entity = new WorkspaceEntity(this.host, id, record)
    this.entities.set(id, entity)
    const pendingState: WorkspaceDomainState = {
      ...state,
      pendingMutation: { operation: 'create', workspaceId: id },
    }
    try {
      await this.setState(pendingState)
    } catch (error) {
      this.entities.delete(id)
      throw error
    }
    try {
      await table.put(id, record)
    } catch (error) {
      this.entities.delete(id)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record write and pending-marker rollback both failed`,
        )
      }
      throw error
    }

    try {
      await this.setState({
        initialized: true,
        workspaceIds: [id, ...state.workspaceIds],
        archivedSessionIds: state.archivedSessionIds,
      })
    } catch (error) {
      this.entities.delete(id)
      try {
        await table.delete(id)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and record rollback both failed; the pending marker remains recoverable`,
        )
      }
      try {
        await this.setState(state)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' order write and pending-marker rollback both failed`,
        )
      }
      throw error
    }
    return entity
  }

  private async deleteKnown(id: WorkspaceId): Promise<boolean> {
    const entity = this.entities.get(id)
    if (entity === undefined) return false
    const state = this.requireState()
    const nextState = {
      initialized: true,
      workspaceIds: state.workspaceIds.filter(workspaceId => workspaceId !== id),
      archivedSessionIds: state.archivedSessionIds,
    }
    await this.setState({
      ...nextState,
      pendingMutation: { operation: 'delete', workspaceId: id },
    })
    this.entities.delete(id)
    try {
      await this.requireTable().delete(id)
    } catch (error) {
      this.entities.set(id, entity)
      try {
        await this.setState(state)
      } catch (rollbackError) {
        // The durable marker still says to finish deletion, so the cache must
        // agree with that recoverable direction rather than republish a row
        // absent from the persisted order.
        this.entities.delete(id)
        throw new AggregateError(
          [error, rollbackError],
          `workspace '${id}' record deletion and registry-order rollback both failed`,
        )
      }
      throw error
    }
    try {
      await this.setState(nextState)
    } catch (error) {
      // The deletion committed at the table write and was already published
      // to Host streams. Keep the durable marker for startup recovery rather
      // than reporting failure after the requested state became true.
      this.ctx.logger.warn(
        `workspace '${id}' was deleted but its pending marker could not be cleared: ${String(error)}`,
      )
    }
    return true
  }

  /**
   * Complete the one mutation explicitly named by durable state. Unexplained
   * order/table divergence still reaches {@link validateStoredState} and
   * fails loud; this path never guesses which operation created a row from its shape alone.
   */
  private async recoverPendingMutation(): Promise<void> {
    const state = this.requireState()
    const pending = state.pendingMutation
    if (pending === undefined) return
    if (state.workspaceIds.includes(pending.workspaceId)) {
      throw new Error(
        `workspace domain is inconsistent: pending ${pending.operation} workspace `
        + `'${pending.workspaceId}' is still present in registry order`,
      )
    }
    await this.requireTable().delete(pending.workspaceId)
    await this.setState({
      initialized: state.initialized,
      workspaceIds: state.workspaceIds,
      archivedSessionIds: state.archivedSessionIds,
    })
  }

  private async bootstrap(headers: readonly SessionHeader[]): Promise<void> {
    const table = this.requireTable()
    const state = this.requireState()
    const groupsByLocation = new Map<string, BootstrapGroup>()
    for (const header of headers) {
      const location = this.sessionLocations.get(header.id)
      if (location === undefined) continue
      const key = locationKey(location)
      const group = groupsByLocation.get(key)
      if (group === undefined) groupsByLocation.set(key, { location, headers: [header], newestAt: header.createdAt })
      else {
        group.headers.push(header)
        if (header.createdAt > group.newestAt) group.newestAt = header.createdAt
      }
    }
    const groups: BootstrapGroup[] = [...groupsByLocation.values()].map((group) => {
      group.headers.sort(compareHeaders)
      return group
    }).sort((left, right) =>
      right.newestAt - left.newestAt || left.location.root.localeCompare(right.location.root))

    const byLocation = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      byLocation.set(locationKey(locationOfRecord(record)), id)
      for (const sessionId of record.sessionIds) accounted.set(sessionId, id)
    }

    for (const group of groups) {
      const key = locationKey(group.location)
      let id = byLocation.get(key)
      if (id === undefined) {
        const sessionIds = group.headers
          .map(header => header.id)
          .filter(sessionId => !accounted.has(sessionId))
        if (sessionIds.length === 0) continue
        id = WorkspaceId(randomUUID())
        const createdAt = new Date(group.newestAt).toISOString()
        const record: WorkspaceRecord = {
          path: group.location.root,
          title: basename(group.location.root),
          sessionIds,
          createdAt,
          updatedAt: createdAt,
          location: group.location,
        }
        await table.put(id, record)
        byLocation.set(key, id)
        for (const sessionId of sessionIds) accounted.set(sessionId, id)
        continue
      }

      const current = table.get(id) as WorkspaceRecord
      const historical = group.headers
        .map(header => header.id)
        .filter(sessionId => accounted.get(sessionId) === undefined || accounted.get(sessionId) === id)
      const historicalSet = new Set(historical)
      const sessionIds = [
        ...historical,
        ...current.sessionIds.filter(sessionId => !historicalSet.has(sessionId)),
      ]
      if (sameSessionIds(current.sessionIds, sessionIds)) continue
      await table.update(id, record => ({
        ...record,
        sessionIds,
        updatedAt: new Date().toISOString(),
      }))
      for (const sessionId of historical) accounted.set(sessionId, id)
    }

    const groupRank = new Map(groups.map(group => [locationKey(group.location), group.newestAt]))
    const priorRank = new Map(state.workspaceIds.map((id, index) => [id, index]))
    const workspaceIds = [...table.entries()]
      .sort(([leftId, left], [rightId, right]) => {
        const leftTime = groupRank.get(locationKey(locationOfRecord(left))) ?? Date.parse(left.createdAt)
        const rightTime = groupRank.get(locationKey(locationOfRecord(right))) ?? Date.parse(right.createdAt)
        return rightTime - leftTime
          || (priorRank.get(leftId) ?? Number.MAX_SAFE_INTEGER)
            - (priorRank.get(rightId) ?? Number.MAX_SAFE_INTEGER)
          || String(leftId).localeCompare(String(rightId))
      })
      .map(([id]) => id)

    if (!sameIds(state.workspaceIds, workspaceIds)) {
      await this.setState({ initialized: false, workspaceIds, archivedSessionIds: state.archivedSessionIds })
    }
    await this.setState({ initialized: true, workspaceIds, archivedSessionIds: state.archivedSessionIds })
  }

  private validateStoredState(state: WorkspaceDomainState): void {
    const table = this.requireTable()
    const order = new Set<WorkspaceId>()
    for (const id of state.workspaceIds) {
      if (order.has(id)) {
        throw new Error(`workspace domain is inconsistent: registry order repeats workspace '${id}'`)
      }
      if (table.get(id) === undefined) {
        throw new Error(`workspace domain is inconsistent: registry order references missing workspace '${id}'`)
      }
      order.add(id)
    }
    if (state.initialized && order.size !== table.size) {
      const orphan = [...table.keys()].find(id => !order.has(id))
      throw new Error(
        `workspace domain is inconsistent: workspace '${orphan as WorkspaceId}' is absent from registry order`,
      )
    }

    const locations = new Map<string, WorkspaceId>()
    const accounted = new Map<SessionId, WorkspaceId>()
    for (const [id, record] of table.entries()) {
      const key = locationKey(locationOfRecord(record))
      const locationHolder = locations.get(key)
      if (locationHolder !== undefined) {
        throw new Error(
          `workspace domain is inconsistent: execution location '${record.path}' is claimed `
          + `by both workspace '${locationHolder}' and workspace '${id}'`,
        )
      }
      locations.set(key, id)
      for (const sessionId of record.sessionIds) {
        const holder = accounted.get(sessionId)
        if (holder !== undefined) {
          throw new Error(
            `workspace domain is inconsistent: session '${sessionId}' is accounted `
            + `by both workspace '${holder}' and workspace '${id}'`,
          )
        }
        accounted.set(sessionId, id)
      }
    }
  }

  private rebuildEntities(): void {
    this.entities.clear()
    for (const id of this.requireState().workspaceIds) {
      const record = this.requireTable().get(id) as WorkspaceRecord
      this.entities.set(id, new WorkspaceEntity(this.host, id, record))
    }
  }

  private async replaceHeaderIndex(headers: readonly SessionHeader[]): Promise<void> {
    this.headers.clear()
    this.sessionLocations.clear()
    this.invalidSessionLocations.clear()
    await this.indexHeaders(headers)
  }

  private async indexHeaders(headers: readonly SessionHeader[]): Promise<void> {
    for (const header of headers) await this.indexHeader(header)
  }

  private async indexHeader(header: SessionHeader): Promise<void> {
    this.headers.set(header.id, header)
    this.sessionLocations.delete(header.id)
    if (header.executionLocation !== undefined) {
      try {
        const location = await this.canonicalizeLocation(header)
        this.sessionLocations.set(header.id, location)
        this.invalidSessionLocations.delete(header.id)
      } catch (error) {
        this.invalidSessionLocations.set(
          header.id,
          `execution location for provider '${header.executionLocation.providerId}' does not resolve: ${String(error)}`,
        )
      }
      return
    }
    if (header.cwd === undefined) {
      this.invalidSessionLocations.set(header.id, 'header has no cwd or execution location')
      return
    }
    try {
      const path = await realpathNormalize(header.cwd)
      if (!(await stat(path)).isDirectory()) {
        this.invalidSessionLocations.set(header.id, `cwd '${header.cwd}' is not a directory`)
        return
      }
      this.sessionLocations.set(header.id, localLocation(path))
      this.invalidSessionLocations.delete(header.id)
    } catch {
      this.invalidSessionLocations.set(header.id, `cwd '${header.cwd}' does not resolve`)
    }
  }

  /**
   * Canonicalize one header into its canonical execution location: the
   * persisted location canonicalized by its provider when present, else the
   * local interpretation of `cwd` (the pre-location format).
   * @param header - the session header to canonicalize.
   * @returns the canonical location; rejects when the world cannot serve or
   *   the directory does not exist.
   */
  private async canonicalizeLocation(header: SessionHeader): Promise<ExecutionLocation> {
    if (header.executionLocation !== undefined) {
      const worlds = this.executionWorlds()
      if (worlds === undefined) {
        throw new ExecutionError(
          `cannot canonicalize session '${header.id}': no execution-world registry is mounted`,
          'execution-provider-not-found',
        )
      }
      const ops = worlds.workspace(header.executionLocation)
      const root = await ops.canonicalize(header.executionLocation, header.executionLocation.root)
      return { ...header.executionLocation, root }
    }
    if (header.cwd === undefined) {
      throw new Error(`session '${header.id}' header carries no cwd or execution location`)
    }
    const cwd = await realpathNormalize(header.cwd)
    if (!(await stat(cwd)).isDirectory()) {
      throw new Error(`cwd '${header.cwd}' is not a directory`)
    }
    return localLocation(cwd)
  }

  private async indexLiveSessions(): Promise<void> {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) return
    await this.indexHeaders(sessions.list().map(session => session.header))
  }

  private reportFilteredCandidates(): void {
    for (const entity of this.entities.values()) {
      const record = this.requireTable().get(entity.id) as WorkspaceRecord
      for (const sessionId of record.sessionIds) {
        const location = this.sessionLocations.get(sessionId)
        if (location !== undefined && executionLocationEquals(location, entity.location)) continue
        const reason = this.invalidSessionLocations.get(sessionId)
          ?? (this.headers.has(sessionId)
            ? `canonical location '${location === undefined ? '(unresolved)' : location.root}' differs from workspace location '${record.path}'`
            : 'session header is missing')
        this.ctx.logger.warn(
          `workspace '${entity.id}' filtered session '${sessionId}' from membership: ${reason}`,
        )
      }
    }
  }

  private async readSessionHeader(id: SessionId): Promise<SessionHeader> {
    const live = this.ctx.get('sessions')?.get(id)
    if (live !== undefined) {
      this.headers.set(id, live.header)
      return live.header
    }
    const cached = this.headers.get(id)
    if (cached !== undefined) return cached

    const headers = await this.ctx.sessionPersistence.list()
    await this.indexHeaders(headers)
    const header = this.headers.get(id)
    if (header === undefined) {
      throw new Error(`cannot validate session '${id}': session persistence holds no such session`)
    }
    return header
  }

  /** The mounted execution-world registry, when this deployment has one. */
  private executionWorlds(): ExecutionWorldRegistry | undefined {
    return (this.ctx.get as unknown as (service: string) => unknown)('executionWorlds') as
      ExecutionWorldRegistry | undefined
  }

  private requireTable(): KvTable<WorkspaceId, WorkspaceRecord> {
    if (this.table === undefined) throw new Error('workspace registry is not started yet')
    return this.table
  }

  private requireState(): WorkspaceDomainState {
    if (this.state === undefined) throw new Error('workspace registry is not started yet')
    return this.state
  }

  private async setState(state: WorkspaceDomainState): Promise<void> {
    await (this.global as DomainGlobal<WorkspaceDomainState>).set(state)
    this.state = state
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(async () => {
      // A committed delete may leave only its marker cleanup pending. Retry
      // recovery before another create/delete can overwrite that pending operation record.
      await this.recoverPendingMutation()
      return await operation()
    })
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

const sameSessionIds = (left: readonly SessionId[], right: readonly SessionId[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

export default WorkspaceRegistry
