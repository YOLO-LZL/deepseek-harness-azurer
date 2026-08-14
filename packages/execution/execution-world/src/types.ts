/**
 * Registry-facing vocabulary of the execution-world Service Definition: the
 * provider shape and the resolved-world view. The JSON-persistable location
 * vocabulary, error codes, and workspace-provider operations live in the leaf
 * package `@deepseek-ai/dsh-execution-location` and are re-exported here so
 * consumers can import the whole contract from one entry.
 * @module @deepseek-ai/dsh-execution-world/types
 */

import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  ExecutionCapabilities,
  ExecutionLocation,
  WorkspaceProviderOperations,
} from '@deepseek-ai/dsh-execution-location'

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

/** The live backends of one resolved execution world. */
export interface ResolvedExecutionWorld {
  /** The resolved location (the provider's default when none was given). */
  readonly location: ExecutionLocation
  /** Filesystem backend of this world; absent when the provider lacks the capability. */
  readonly filesystem?: FileSystem
  /** Subprocess backend of this world; absent when the provider lacks the capability. */
  readonly subprocess?: SubprocessRuntime
}

/**
 * One registered execution-world provider. Registration is effect-scoped and
 * ids must be unique; unregistering removes every route to the provider.
 */
export interface ExecutionWorldProvider {
  /** Stable provider id; unique among registered providers. */
  readonly id: string
  /** Short human/UI-facing provider label (e.g. 'SSH'). */
  readonly label: string
  /** Which capability seams this provider can serve. */
  readonly capabilities: ExecutionCapabilities
  /**
   * Resolve the live backends for one of this provider's locations. Must
   * throw {@link ExecutionError} with `execution-provider-not-found` when the
   * location was not created by this provider and `execution-unavailable`
   * when the world cannot serve right now. The returned backends may lazily
   * connect; resolution itself stays synchronous.
   * @param location - a location naming this provider.
   * @returns the world's live backends.
   */
  resolve(location: ExecutionLocation): ResolvedExecutionWorld
  /**
   * The provider's default location — the world operations address when no
   * explicit location is given (for the local provider: the host working
   * directory).
   */
  defaultLocation(): ExecutionLocation
  /** Workspace-provider operations; present iff `capabilities.workspace`. */
  readonly workspace?: WorkspaceProviderOperations
}
