/**
 * The built-in local execution-world provider. Registers the `local` provider
 * over the host filesystem (`ctx.fs`) and the host subprocess seam
 * (`ctx.subprocess`) when they are mounted, and implements the workspace
 * operations over `node:fs` (realpath/stat/mkdir — the same primitives the
 * workspace registry used directly before providers existed).
 *
 * The local provider is registered by the `apply` plugin entry
 * (`@deepseek-ai/dsh-execution-world/local`), which the base bundle composes
 * by default. Registration is best-effort: a profile without `ctx.fs` or
 * `ctx.subprocess` still gets a local provider whose missing seams throw
 * `execution-unavailable` on use, so harness startup never depends on any
 * particular backend being mounted.
 * @module @deepseek-ai/dsh-execution-world/local
 */

import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ExecutionError, LOCAL_PROVIDER_ID, localLocation } from '@deepseek-ai/dsh-execution-location'
import type {
  ExecutionLocation,
  WorkspaceDirEntry,
  WorkspaceProviderOperations,
} from '@deepseek-ai/dsh-execution-location'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ExecutionWorldProvider, ResolvedExecutionWorld } from './types.ts'

export { localLocation }

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'execution-world-local'

/** Services required before the local provider can register. */
export const inject = ['executionWorlds']

/**
 * Workspace operations over the host filesystem — the local implementation of
 * the registry's workspace provider contract (realpath/stat/mkdir).
 * @returns operations for local workspace locations.
 */
export function createLocalWorkspaceOperations(): WorkspaceProviderOperations {
  return {
    async canonicalize(location, path, opts) {
      opts?.signal?.throwIfAborted()
      const absolute = resolve(location.root, path)
      try {
        return await realpath(absolute)
      } catch (error) {
        throw new ExecutionError(
          `cannot canonicalize '${absolute}': ${String(error)}`,
          'workspace-remote-path-invalid',
          { cause: error },
        )
      }
    },

    async status(location, opts) {
      opts?.signal?.throwIfAborted()
      try {
        const info = await stat(location.root)
        return info.isDirectory()
          ? { kind: 'ok' }
          : { kind: 'missing-dir', message: `'${location.root}' is not a directory` }
      } catch (error) {
        return {
          kind: 'missing-dir',
          message: `'${location.root}' does not resolve: ${String(error)}`,
        }
      }
    },

    async listDirectory(location, path, opts) {
      opts?.signal?.throwIfAborted()
      const absolute = resolve(location.root, path)
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(absolute)
      } catch (error) {
        throw new ExecutionError(
          `cannot list '${absolute}': not found`,
          'workspace-remote-path-invalid',
          { cause: error },
        )
      }
      if (!info.isDirectory()) {
        throw new ExecutionError(`cannot list '${absolute}': not a directory`, 'workspace-remote-path-invalid')
      }
      const { readdir } = await import('node:fs/promises')
      const names = await readdir(absolute)
      const entries: WorkspaceDirEntry[] = []
      for (const name of names) {
        try {
          const child = await stat(resolve(absolute, name))
          entries.push({
            name,
            type: child.isDirectory() ? 'directory' : child.isFile() ? 'file' : 'other',
            ...child.isFile() ? { size: child.size } : {},
          })
        } catch {
          entries.push({ name, type: 'other' })
        }
      }
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    },

    async createDirectory(location, path, opts) {
      opts?.signal?.throwIfAborted()
      await mkdir(resolve(location.root, path), { recursive: true })
    },

    async ensureSessionRoot(location) {
      // Adapter-owned host state lives under the host runtime directory; the
      // local world keeps it out of the user's project tree.
      const root = process.env.DSH_RUNTIME_ROOT ?? resolve(location.root, '.dsh')
      await mkdir(root, { recursive: true })
      return root
    },

    async resolveLocation(input) {
      if (input.providerId !== LOCAL_PROVIDER_ID) {
        throw new ExecutionError(
          `local workspace provider cannot resolve provider '${input.providerId}'`,
          'workspace-provider-invalid-target',
        )
      }
      if (input.target !== null) {
        throw new ExecutionError(
          'local workspace provider expects target null',
          'workspace-provider-invalid-target',
        )
      }
      if (typeof input.path !== 'string' || input.path.trim().length === 0) {
        throw new ExecutionError('workspace path must be a non-empty string', 'workspace-remote-path-invalid')
      }
      let root: string
      try {
        root = await realpath(resolve(input.path))
      } catch (error) {
        throw new ExecutionError(
          `cannot canonicalize '${input.path}': ${String(error)}`,
          'workspace-remote-path-invalid',
          { cause: error },
        )
      }
      if (!(await stat(root)).isDirectory()) {
        throw new ExecutionError(`'${root}' is not a directory`, 'workspace-remote-path-invalid')
      }
      return localLocation(root)
    },
  }
}

/**
 * The local execution-world provider over the mounted host seams.
 * @param fs - the mounted local filesystem backend (`ctx.fs`), when present.
 * @param subprocess - the mounted local subprocess backend (`ctx.subprocess`), when present.
 * @param workspace - local workspace operations; defaults to
 *   {@link createLocalWorkspaceOperations}.
 */
export class LocalExecutionWorldProvider implements ExecutionWorldProvider {
  readonly id = LOCAL_PROVIDER_ID
  readonly label = 'Local'
  readonly workspace: WorkspaceProviderOperations

  constructor(
    private readonly fs: FileSystem | undefined,
    private readonly subprocess: SubprocessRuntime | undefined,
    workspace?: WorkspaceProviderOperations,
  ) {
    this.workspace = workspace ?? createLocalWorkspaceOperations()
  }

  get capabilities(): ExecutionWorldProvider['capabilities'] {
    return {
      filesystem: this.fs !== undefined,
      subprocess: this.subprocess !== undefined,
      workspace: true,
    }
  }

  resolve(location: ExecutionLocation): ResolvedExecutionWorld {
    if (location.providerId !== LOCAL_PROVIDER_ID) {
      throw new ExecutionError(
        `local provider cannot resolve provider '${location.providerId}'`,
        'execution-provider-not-found',
      )
    }
    if (location.target !== null) {
      throw new ExecutionError(
        `local provider expects target null, got ${JSON.stringify(location.target)}`,
        'workspace-provider-invalid-target',
      )
    }
    if (this.fs === undefined) {
      throw new ExecutionError('local filesystem seam is not mounted', 'execution-unavailable')
    }
    if (this.subprocess === undefined) {
      throw new ExecutionError('local subprocess seam is not mounted', 'execution-unavailable')
    }
    return { location, filesystem: this.fs, subprocess: this.subprocess }
  }

  defaultLocation(): ExecutionLocation {
    return localLocation(resolve(process.cwd()))
  }
}

/**
 * Register the local execution-world provider. Best-effort by design: the
 * provider registers even when a seam is missing (that seam then answers
 * `execution-unavailable`), so profiles may mount `ctx.fs`/`ctx.subprocess`
 * in any order and a minimal harness still starts. The optional seams are
 * read with `ctx.get()` rather than injected.
 * @param ctx - host context with the registry mounted.
 */
export function apply(ctx: Context): void {
  const registry = ctx.executionWorlds
  const fs = ctx.get('fs')
  const subprocess = ctx.get('subprocess')
  const provider = new LocalExecutionWorldProvider(fs, subprocess)
  ctx.effect(() => registry.register(provider), 'execution-worlds/local')
}

/**
 * Display title helper shared by workspace records: `basename` of the root.
 * @param root - canonical local workspace root.
 * @returns the root directory name.
 */
export function localTitle(root: string): string {
  return basename(root)
}
