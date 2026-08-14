/**
 * Consumer-side routing helpers: resolve a session header's execution world
 * and its live backends in one call. Consumers (tools, shell, terminal, LSP,
 * instructions, skills) call these instead of reaching for `ctx.fs` /
 * `ctx.subprocess` directly, so a session's files and processes always belong
 * to the same world. Non-session callers keep using the plain services: every
 * helper returns `undefined` and the caller falls back to `ctx.fs` /
 * `ctx.subprocess` (the local default).
 * @module @deepseek-ai/dsh-execution-world/consumer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ExecutionLocation } from '@deepseek-ai/dsh-execution-location'
import type { ResolvedExecutionWorld } from './types.ts'

/** Structural face of a session header — no core/session import (dependency cycle). */
export interface SessionHeaderLike {
  readonly executionLocation?: ExecutionLocation | undefined
  readonly cwd?: string | undefined
}

/**
 * The execution location a header names: its persisted location, else the
 * local world at cwd.
 * @param header - session header, when one is available.
 * @returns the persisted or synthesized local location, or `undefined`.
 */
export function headerLocation(header: SessionHeaderLike | undefined): ExecutionLocation | undefined {
  if (header === undefined) return undefined
  if (header.executionLocation !== undefined) return header.executionLocation
  if (header.cwd === undefined) return undefined
  return { providerId: 'local', target: null, root: header.cwd }
}

/**
 * Resolve the session's execution world (the live backends). Returns
 * `undefined` when the header names no world or the registry is not mounted —
 * callers then fall back to the local services.
 * @param ctx - the host context.
 * @param header - the session header (or its storage face).
 * @returns the resolved world, or `undefined` for the local default.
 */
export function sessionWorld(ctx: Context, header: SessionHeaderLike | undefined): ResolvedExecutionWorld | undefined {
  const location = headerLocation(header)
  if (location === undefined) return undefined
  const registry = (ctx.get as unknown as (service: string) => unknown)('executionWorlds') as
    | { resolve(location: ExecutionLocation): ResolvedExecutionWorld }
    | undefined
  if (registry === undefined) return undefined
  try {
    return registry.resolve(location)
  } catch {
    return undefined
  }
}

/**
 * The filesystem backend of the session's world, when it differs from the
 * local default.
 * @param ctx - the host context.
 * @param header - the session header.
 * @returns the world's filesystem backend, or `undefined` to keep `ctx.fs`.
 */
export function sessionFileSystem(ctx: Context, header: SessionHeaderLike | undefined): FileSystem | undefined {
  return sessionWorld(ctx, header)?.filesystem
}

/**
 * The subprocess backend of the session's world, when it differs from the
 * local default.
 * @param ctx - the host context.
 * @param header - the session header.
 * @returns the world's subprocess backend, or `undefined` to keep `ctx.subprocess`.
 */
export function sessionSubprocess(ctx: Context, header: SessionHeaderLike | undefined): SubprocessRuntime | undefined {
  return sessionWorld(ctx, header)?.subprocess
}
