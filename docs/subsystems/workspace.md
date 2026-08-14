# Workspaces

English | [中文](workspace.zh.md)

A workspace is the persistent record of a directory the user works in: a stable id over a canonical path, a display title, and the ordered account of sessions that belong to it. The subsystem is one package ([dsh-workspace](../../packages/workspace/workspace), `ctx.workspaceRegistry`) — an optional host-side capability, not part of the agent-loop spine, and invisible to models (no tools, no prompt text, no session events). It stores its records through the [storage domain form](storage.md) and validates session membership against [`SessionHeader.cwd`](persistence.md#sessionheader--metadata-beside-the-log), so `storageDomain` and `sessionPersistence` are mandatory startup dependencies: an unavailable persistence peer leaves the plugin pending rather than being mistaken for an empty history. Design record: [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md); bootstrap and GUI ordering: [Workspace UI product-flow Agent Note](../../.agents/notes/implemented/feature/2026-07-25-workspace-ui-product-flow.md).

Source: [`packages/workspace/workspace/src/types.ts`](../../packages/workspace/workspace/src/types.ts)

## Identity

```ts type-equiv
/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
type WorkspaceId = Branded<'WorkspaceId'>
```

`WorkspaceId` is a [branded id](core.md#branded-ids). Path identity is separate: `realpathNormalize` (`fs.realpath`; trailing slashes, `..`, and symlinks resolved) is the one uniqueness canon — workspace paths are stored canonicalized, uniqueness is string equality of canonical paths (a symlink to an owned directory collides), and attach-time session cwd checks go through the same canon.

## The workspace entity

Consumers see only the `Workspace` interface; the implementation stays package-private.

```ts type-equiv
/**
 * One workspace: a stable id over an existing directory in one execution
 * world, a display title, and an ordered candidate account of sessions.
 * Membership requires both an id in that account and a session header whose
 * canonical execution location equals the workspace location. Consumers only
 * see this interface; the implementation stays private.
 */
interface Workspace {
  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * The execution world this workspace lives in. The local world
   * (`{ providerId: 'local', target: null, root }`) is the default for
   * records created before locations existed.
   */
  readonly location: ExecutionLocation

  /**
   * Canonical directory path in the workspace's execution world: the
   * provider's canonicalization of the path given at create time (trailing
   * slashes, `..`, and symlinks all resolved in-world). Never rewritten
   * afterwards, even when the directory disappears (see {@link status}).
   */
  readonly path: string

  /** Display title. Defaults to `basename(path)` at create; duplicates are allowed. */
  readonly title: string

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation (create counts as one). */
  readonly updatedAt: string

  /**
   * Header-validated sessions in manually owned order: a new session is
   * prepended at attach, explicit reordering goes through
   * `insertSessionBefore`, and activity never reorders. The durable candidate
   * account is filtered synchronously: missing headers, invalid locations,
   * and canonical location mismatches are never returned. A subsequent
   * workspace mutation prunes those filtered candidates durably.
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * Replace the display title durably.
   * @param title - New title; any string, duplicates across workspaces allowed.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /**
   * Prepend a session to this workspace's candidate account. An already
   * accounted id resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs. A new id's
   * live or persisted header location must resolve to an existing directory
   * equal to {@link location}; unknown ids, missing or invalid locations,
   * and mismatches reject without writing.
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * Move an accounted session within the manual order, DOM-insertBefore-like:
   * with an anchor the session lands before it, without one it appends to the
   * end. Only the moved id changes position. A session or anchor absent from
   * the account rejects without writing; a move to the current position
   * resolves without writing, aside from the durable filtered-candidate
   * prune every accepted mutation performs; decided on the domain write
   * chain.
   * @param sessionId - The accounted session to move.
   * @param beforeSessionId - Accounted anchor to insert before; omitted appends.
   * @returns resolution after durability.
   */
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>

  /**
   * Remove a session from this workspace's account. Idempotent: an id not on
   * the account resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs; decided on
   * the domain write chain like attach. Never touches the session's own stored log.
   * @param sessionId - The session to remove.
   * @returns resolution after durability.
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * Live directory check, uncached: whether the workspace's root directory
   * currently exists in its execution world. A missing directory never
   * mutates the record — the directory may only be temporarily moved.
   * @returns `'ok'` when the directory exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}
```

Ownership truth is the record's ordered `sessionIds`, never derived from session cwd — but membership requires both: an id on the account and a header whose canonical cwd equals the workspace path, so one session structurally belongs to at most one workspace. Failed writes reject (`insertSessionBefore` account errors as `WorkspaceMoveInvalidError`, storage failures as plain errors); every accepted mutation stamps `updatedAt` and durably prunes candidates that no longer pass the membership check.

## The registry: `ctx.workspaceRegistry`

`WorkspaceRegistry` ([signatures](#ctxworkspaceregistry--workspaceregistry)) owns registration and resolution. `create(path, title?)` canonicalizes the path, rejects a nonexistent path (the original `ENOENT`) or a non-directory, returns the existing entity unchanged when the canonical path is already owned, and otherwise creates a record with `title ?? basename(path)` prepended to the durable registry order — a new record cannot duplicate an existing display title (`WorkspaceNameConflictError`). `get(id)` and the ordered `list()` are synchronous cache reads; `resolveByPath(path)` applies the same realpath canon without creating. `delete(id)` removes only the registration, order entry, and session account — the directory, user files, live sessions, and persisted logs are never touched, so those sessions become Ungrouped ([decision](../../.agents/notes/implemented/feature/2026-07-27-workspace-registration-deletion.md)); unknown ids return `false`. Create and delete persist a pending-mutation marker before their two writes (record + order) can diverge; startup resolves exactly the marked mutation — by deleting the marked table row, which completes an interrupted delete and rolls back an interrupted create (the registration is re-creatable, so rollback is the safe direction) — and an unmarked order/table mismatch fails loud as corruption.

Sessions get their cwd at create time from whoever creates them, not from this registry — the API gateway resolves a new session's cwd from the chosen workspace's `path` (falling back to an explicit or default cwd), creates the session so the cwd lands in its immutable [`SessionHeader`](persistence.md#sessionheader--metadata-beside-the-log), then calls `attachSession`, which re-validates that stored header cwd against the workspace path. On the first successful start, the registry bootstraps history from persisted headers alone (`id`, `cwd`, `createdAt` — never event bodies), grouping sessions with a valid canonical cwd into per-directory workspaces, newest first; the initialized marker is written last so an interrupted bootstrap resumes safely. The bootstrap is one-time: cwd-less legacy sessions stay Ungrouped, and sessions created afterwards join a workspace only through `attachSession`.

## Consumers

[dsh-host-apiproxy](../../packages/host/apiproxy) is the product consumer: it serves workspace CRUD to GUI clients over `ctx.workspaceRegistry` and performs the create-session-then-attach flow above. [dsh-agent-instructions](../../packages/context/agent-instructions) is **not** a consumer despite the name: it discovers AGENTS.md-style instruction files under an agent's own cwd and never touches `ctx.workspaceRegistry` — the shared word refers to the user's working directory, not to this registry's entities.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdirectorypicker--directorypicker-abstract-seam"></a>

### `ctx.directoryPicker` — `DirectoryPicker` (abstract seam)

Abstract directory-picking service. Subclass, implement `capability()`, and load the subclass as a plugin — it registers as `ctx.directoryPicker` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior). The capability object must be stable for the service lifetime: consumers may capture it across calls.

```ts cordis-catalog
/**
 * The backend's interaction capability.
 * @returns the discriminated capability consumers switch on.
 */
abstract capability(): DirectoryPickerCapability
```

Source: [`packages/host/directory-picker/src/index.ts:131`](../../packages/host/directory-picker/src/index.ts)

<a id="ctxexecutionworlds--executionworldregistry"></a>

### `ctx.executionWorlds` — `ExecutionWorldRegistry`

The execution-world registry: one registered provider per stable id, effect-scoped registration, duplicate-id rejection, and location routing.

```ts cordis-catalog
/**
 * Register one execution-world provider. Registration is effect-scoped: the
 * returned disposer (and the enclosing cordis effect scope) removes the
 * provider and every route to it.
 * @param provider - the provider to register; its id must be unique.
 * @returns the disposer unregistering this provider (idempotent).
 * @throws a plain `Error` when the id is empty or already registered.
 */
register(provider: ExecutionWorldProvider): () => void

/**
 * Look up one registered provider.
 * @param id - provider id.
 * @returns the provider, or `undefined` when unknown.
 */
provider(id: string): ExecutionWorldProvider | undefined

/**
 * The registered providers in registration order — the capability status
 * surface for Host APIs and the UI.
 * @returns a fresh array of providers.
 */
listProviders(): ExecutionWorldProvider[]

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
resolve(location?: ExecutionLocation): ResolvedExecutionWorld

/**
 * Resolve the workspace-provider operations for one location.
 * @param location - the location to resolve; `undefined` routes to local.
 * @returns the workspace operations.
 * @throws {@link ExecutionError} with `execution-provider-not-found` when
 *   the provider is unknown, and `execution-unavailable` when the provider
 *   registers no workspace capability.
 */
workspace(location?: ExecutionLocation): WorkspaceProviderOperations

/**
 * Resolve the workspace-provider operations of one named provider, without
 * a location — the create-input path, where the location does not exist yet.
 * @param providerId - provider id.
 * @returns the workspace operations.
 * @throws {@link ExecutionError} with `execution-provider-not-found` when
 *   the provider is unknown, and `execution-unavailable` when the provider
 *   registers no workspace capability.
 */
workspaceOf(providerId: string): WorkspaceProviderOperations
```

Source: [`packages/execution/execution-world/src/index.ts:68`](../../packages/execution/execution-world/src/index.ts)

<a id="ctxssh--sshruntime"></a>

### `ctx.ssh` — `SshRuntime`

The SSH runtime: connection registry over the `ssh-connections` settings namespace (with legacy migration), read-only ~/.ssh/config aliases, and per-connection transport instances.

```ts cordis-catalog
/**
 * The mounted settings scope, when a settings service exists.
 * @returns the writable scope, or `undefined` without settings.
 */
connectionsScope(): SettingsScope<SshConnectionsSettings> | undefined

/**
 * The resolved connections settings value (mounted scope or memory).
 * @returns the current connection settings.
 */
connectionsSettings(): SshConnectionsSettings

/**
 * Probe for a usable system ssh client. Cached; never throws.
 * @returns true when `ssh` is on PATH and starts.
 */
sshAvailable(): Promise<boolean>

/**
 * All saved connections in save order.
 * @returns the current connection records.
 */
listConnections(): SshConnection[]

/**
 * Hosts discovered from ~/.ssh/config (read-only).
 * @returns discovered aliases and their resolved facts.
 */
listConfigHosts(): Promise<SshConfigHost[]>

/**
 * Resolve a connection by id or label.
 * @param idOrLabel - stable connection id or display label.
 * @returns the matching connection, or `undefined`.
 */
connection(idOrLabel: string): SshConnection | undefined

/**
 * The workspace default connection id for one workspace, when bound.
 * @param workspaceId - stable workspace id.
 * @returns the bound connection id, or `undefined`.
 */
workspaceDefault(workspaceId: string): string | undefined

/**
 * Resolve a target reference into concrete transport facts.
 * @param reference - saved connection or OpenSSH config alias reference.
 * @returns host, port, key, and timeout values for a transport.
 */
resolveReference(reference: SshTargetReference): SshTransportTarget

/**
 * Resolve the SSH target reference carried by one execution location.
 * @param location - SSH execution location to inspect.
 * @param operation - caller name included in a provider mismatch error.
 * @returns the validated saved-connection or config-alias reference.
 */
referenceOf(location: ExecutionLocation, operation: string = 'resolve'): SshTargetReference

/**
 * Display label of one location's reference, when resolvable.
 * @param reference - saved connection or config alias reference.
 * @returns a user-facing label, or `undefined` for a missing connection.
 */
labelOf(reference: SshTargetReference): string | undefined

/**
 * The transport for one execution location (per-reference instances are
 * cached and closed at service disposal).
 * @param location - an ssh execution location.
 * @returns the live transport; lazily connected.
 */
transportFor(location: ExecutionLocation): SshTransport

/**
 * Close and forget one connection's transport after a connection mutation.
 * @param reference - target whose cached transport must be released.
 */
invalidateTransport(reference: SshTargetReference): void

/**
 * Resolve the effective target for ssh_exec-style calls: explicit host →
 * explicit connection → workspace default.
 * @param args - model arguments.
 * @param workspaceDefaultId - the calling workspace's default connection id.
 * @returns the resolved target (host string form for ssh argv).
 */
resolveExecTarget( args: { host?: string; connection?: string }, workspaceDefaultId: string | undefined, ): Promise<SshTarget>
```

Types: [SettingsScope](settings.md)

Source: [`packages/ssh/ssh/src/index.ts:142`](../../packages/ssh/ssh/src/index.ts)

<a id="ctxworkspaceregistry--workspaceregistry"></a>

### `ctx.workspaceRegistry` — `WorkspaceRegistry`

Durable workspace registry. Startup waits for `sessionPersistence`, builds one canonical-location header index, and completes the one-time history bootstrap before the service becomes active. The persistence dependency is mandatory so an unavailable peer can never be mistaken for an empty history and commit the initialized marker.

The registry delegates workspace-provider operations (canonicalize, validate/status, list, create, ensureSessionRoot, location resolution) to the execution-world registry when one is mounted; without it, local create/resolve fall back to this package's original realpath/stat path.

```ts cordis-catalog
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
async create(input: WorkspaceCreateInput, title?: string): Promise<Workspace>

/**
 * Look up a workspace by id.
 * @param id - Workspace id.
 * @returns the workspace, or `undefined` when unknown.
 */
get(id: WorkspaceId): Workspace | undefined

/**
 * Synchronous workspace projection in durable registry order. Every
 * entity's `sessionIds` getter is already filtered by the startup/live
 * canonical-location header index; this method performs no persistence
 * reads.
 * @returns a fresh ordered array of workspace entities.
 */
list(): Workspace[]

/**
 * Delete one workspace registration while retaining its directory and every
 * session log. The durable order is updated before the table deletion; a
 * failed table write restores the prior order and keeps the entity
 * published. Unknown ids are an idempotent no-op for domain callers.
 * @param id - Workspace registration to remove.
 * @returns `true` when a record was deleted, `false` when it was unknown.
 */
delete(id: WorkspaceId): Promise<boolean>

/**
 * Move one workspace within the durable display order, DOM-insertBefore-like.
 * With an anchor it lands before that workspace; without one it appends.
 * @param id - Workspace to move.
 * @param beforeId - Workspace anchor; omitted appends.
 * @returns the complete committed workspace order.
 */
insertBefore(id: WorkspaceId, beforeId?: WorkspaceId): Promise<readonly WorkspaceId[]>

/**
 * Archive one session durably. The session must exist (live or in session
 * persistence); its workspace accounting — or lack of one — is irrelevant.
 * An already archived id resolves without writing.
 * @param sessionId - The session to archive.
 * @returns resolution after durability.
 */
archiveSession(sessionId: SessionId): Promise<void>

/**
 * Resolve by canonical directory path without creating or mutating a
 * workspace. Only local workspaces are addressable by host path: the path
 * is canonicalized through the local provider (or this package's fallback)
 * and matched against local records.
 * @param path - Existing directory path in any spelling.
 * @returns the workspace owning the canonical path, when one exists.
 */
async resolveByPath(path: string): Promise<Workspace | undefined>

/**
 * Resolve by execution location without creating or mutating a workspace.
 * Remote (SSH) workspaces are only addressable this way — their directories
 * are not host paths. The location must match a record canonically.
 * @param location - the execution location to match.
 * @returns the workspace owning the location, when one exists.
 */
resolveByLocation(location: ExecutionLocation): Workspace | undefined
```

Types: [SessionId](core.md)

Source: [`packages/workspace/workspace/src/index.ts:130`](../../packages/workspace/workspace/src/index.ts)

<a id="execution-worlds-events"></a>

### `execution-worlds/*` events

<a id="execution-worldsregistered--emit"></a>

#### `execution-worlds/registered` — emit

A provider registered (or re-registered after disposal). Emitted with the provider object; UI capability status listens for this.

```ts cordis-catalog
/**
 * A provider registered (or re-registered after disposal). Emitted with
 * the provider object; UI capability status listens for this.
 * @param provider - the registered provider.
 * @mode emit
 */
'execution-worlds/registered'(provider: ExecutionWorldProvider): void
```

Source: [`packages/execution/execution-world/src/index.ts:54`](../../packages/execution/execution-world/src/index.ts)

<a id="execution-worldsunregistered--emit"></a>

#### `execution-worlds/unregistered` — emit

A provider was unregistered and its routes disappeared.

```ts cordis-catalog
/**
 * A provider was unregistered and its routes disappeared.
 * @param id - the removed provider id.
 * @mode emit
 */
'execution-worlds/unregistered'(id: string): void
```

Source: [`packages/execution/execution-world/src/index.ts:60`](../../packages/execution/execution-world/src/index.ts)
<!-- END GENERATED cordis-surface -->
