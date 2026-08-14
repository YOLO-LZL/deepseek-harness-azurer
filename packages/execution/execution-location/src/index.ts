/**
 * Execution-location vocabulary: the JSON-persistable execution location,
 * capability descriptors, the workspace-provider operations, and the typed
 * error taxonomy. This is a leaf package — no harness seam imports — so the
 * session store, the filesystem/subprocess seams, and the workspace registry
 * can all speak the contract without forming dependency cycles.
 * @module @deepseek-ai/dsh-execution-location
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * A value that round-trips losslessly through JSON. Structurally identical to
 * `@deepseek-ai/dsh-session`'s `JsonValue`; defined here so the execution-world
 * contract stays dependency-light (type-only, no runtime import).
 */
export type ExecutionJsonValue =
  | null
  | boolean
  | number
  | string
  | ExecutionJsonValue[]
  | { [key: string]: ExecutionJsonValue }

/**
 * Stable provider id of the built-in local execution world. Every harness ships
 * this provider; `resolve(undefined)` routes to it.
 */
export const LOCAL_PROVIDER_ID = 'local'

/** Provider id of the E2B sandbox execution world (one sandbox per deployment). */
export const E2B_PROVIDER_ID = 'e2b'

/** Provider id of the SSH remote execution world (one world per connection). */
export const SSH_PROVIDER_ID = 'ssh'

/**
 * A JSON-persistable description of where execution happens. The pair
 * `providerId` + `target` names one stable execution world (for SSH: a
 * connection id or `config:<alias>` reference); `root` is the canonical
 * absolute root directory inside that world; `display` carries presentation
 * facts for titles and the UI.
 *
 * The local location is `{ providerId: 'local', target: null, root: <absolute path> }`.
 * Providers are never guessed from a path string: a location always names its
 * provider explicitly, and a provider interprets its own `target` and path
 * syntax.
 */
export interface ExecutionLocation {
  /** Provider id that interprets `target` and owns the world's backends. */
  readonly providerId: string
  /**
   * Stable provider-specific target reference (e.g. a connection id, a
   * `config:<alias>` reference, or `null` for the local world). Opaque to
   * every consumer outside the provider.
   */
  readonly target: ExecutionJsonValue
  /** Canonical absolute root directory in this world (provider-interpreted syntax). */
  readonly root: string
  /** Presentation facts for titles, search, and the UI. */
  readonly display?: {
    /** Human-readable world label (e.g. the SSH connection label). */
    readonly label?: string | undefined
    /** Optional host/endpoint fact for display. */
    readonly host?: string | undefined
  } | undefined
}

/**
 * The built-in local location for one absolute root directory.
 * @param root - the canonical absolute host directory.
 * @returns the local execution location.
 */
export function localLocation(root: string): ExecutionLocation {
  return { providerId: LOCAL_PROVIDER_ID, target: null, root }
}

/**
 * Structural equality over two locations: same provider, same JSON target, and
 * same root. This is the membership canon for remote workspaces — a session
 * belongs to a workspace when their locations compare equal (for local
 * workspaces, equivalent to the canonical realpath comparison).
 * @param left - one location.
 * @param right - the other location.
 * @returns true when both name the same execution world and root.
 */
export function executionLocationEquals(
  left: ExecutionLocation,
  right: ExecutionLocation,
): boolean {
  return left.providerId === right.providerId
    && JSON.stringify(left.target) === JSON.stringify(right.target)
    && left.root === right.root
}

/**
 * Stable, machine-routable codes for execution-world failures. Carried on
 * {@link ExecutionError}; consumers branch on `code`, never by parsing
 * messages.
 */
export type ExecutionErrorCode =
  /** A location named a provider that is not registered (or the local default is missing). */
  | 'execution-provider-not-found'
  /** A registered provider cannot serve right now (no ssh client, connection refused, sandbox gone). */
  | 'execution-unavailable'
  /** A workspace create input named a target the provider refuses (unknown connection, bad reference). */
  | 'workspace-provider-invalid-target'
  /** A workspace path failed the provider's remote-path validation. */
  | 'workspace-remote-path-invalid'
  /** An operation needs a sandbox/execution policy the provider cannot enforce (e.g. remote bash under read-only). */
  | 'execution-policy-unsupported'

/**
 * Typed execution-world error. Extends {@link HarnessError} so it carries a
 * stable {@link ExecutionErrorCode} and chains `cause`.
 */
export class ExecutionError extends HarnessError {
  override readonly code: ExecutionErrorCode

  constructor(message: string, code: ExecutionErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

/** Which capability seams one execution world can serve. */
export interface ExecutionCapabilities {
  /** The provider can resolve a filesystem backend for its locations. */
  readonly filesystem: boolean
  /** The provider can resolve a subprocess backend for its locations. */
  readonly subprocess: boolean
  /** The provider can canonicalize/validate/list/create remote workspace directories. */
  readonly workspace: boolean
}

/** One direct child entry in a remote directory listing. */
export interface WorkspaceDirEntry {
  /** Basename of the child inside the listed directory. */
  readonly name: string
  /** Whether the child is a regular file, a directory, or something else. */
  readonly type: 'file' | 'directory' | 'other'
  /** Byte size of a regular file, when the provider can report it. */
  readonly size?: number
}

/** Live state of one workspace directory in its execution world. */
export type WorkspaceStatus =
  | { readonly kind: 'ok' }
  | { readonly kind: 'missing-dir'; readonly message?: string }
  | { readonly kind: 'unreachable'; readonly message?: string }
  | { readonly kind: 'invalid'; readonly message?: string }

/**
 * The workspace-provider operations a registry delegates to. The local
 * provider implements these over the host filesystem (realpath/stat/mkdir);
 * remote providers implement them over their transport. Paths are always
 * interpreted in the provider's own world syntax.
 */
export interface WorkspaceProviderOperations {
  /**
   * Canonicalize a workspace path in this provider's world. Like realpath:
   * relative paths resolve against `location.root`, symlinks and `..` resolve,
   * and the result is the canonical absolute path used for record identity.
   * A missing path must reject (create validates before writing).
   * @param location - the world the path belongs to.
   * @param path - the path to canonicalize (any spelling).
   * @param opts - cancellation.
   * @returns the canonical absolute path in world syntax.
   */
  canonicalize(
    location: ExecutionLocation,
    path: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string>

  /**
   * Live state of the workspace root directory, uncached.
   * @param location - the world whose root to probe.
   * @param opts - cancellation.
   * @returns `ok` when the root exists as a directory; a classified reason otherwise.
   */
  status(
    location: ExecutionLocation,
    opts?: { signal?: AbortSignal },
  ): Promise<WorkspaceStatus>

  /**
   * List direct children of a directory in stable name order.
   * @param location - the world the path belongs to.
   * @param path - absolute or root-relative directory path.
   * @param opts - cancellation.
   * @returns one entry per direct child, sorted by name.
   */
  listDirectory(
    location: ExecutionLocation,
    path: string,
    opts?: { signal?: AbortSignal },
  ): Promise<WorkspaceDirEntry[]>

  /**
   * Create one directory (and missing ancestors) in this provider's world.
   * @param location - the world the path belongs to.
   * @param path - absolute or root-relative directory path to create.
   * @param opts - cancellation.
   */
  createDirectory(
    location: ExecutionLocation,
    path: string,
    opts?: { signal?: AbortSignal },
  ): Promise<void>

  /**
   * Ensure the private per-session root directory of this world exists and
   * return it. Adapter-owned state (spills, terminal state, process identity)
   * lives here, never inside user project directories.
   * @param location - the world whose session root is required.
   * @returns the absolute session-root path, guaranteed to exist.
   */
  ensureSessionRoot(location: ExecutionLocation): Promise<string>

  /**
   * Validate and resolve a workspace create input into a canonical location.
   * The provider performs strict business validation on its own target and
   * path shape; a refusal raises {@link ExecutionError} with
   * `workspace-provider-invalid-target` or `workspace-remote-path-invalid`.
   * @param input - the discriminated create input (`{ kind: 'provider', providerId, target, path }`).
   * @returns the canonical location to persist.
   */
  resolveLocation(input: {
    readonly providerId: string
    readonly target: ExecutionJsonValue
    readonly path: string
  }): Promise<ExecutionLocation>
}
