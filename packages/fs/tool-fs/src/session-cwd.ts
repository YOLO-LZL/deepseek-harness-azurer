/**
 * Derive the working directory AND execution world a filesystem tool resolves
 * against: the calling agent's per-session workspace
 * (`exec.agent.session.header.cwd` + its persisted execution location), so
 * each session's `read`/`write`/`edit` act on ITS workspace — local or remote
 * — not the server's launch dir; mirroring how `dsh-tool-bash` defaults a
 * bash `workdir` to the session cwd. Non-agent calls return `undefined`,
 * leaving the fallback in the provider rather than reading `process.cwd()` at
 * the tool boundary.
 * @module @deepseek-ai/dsh-tool-fs/session-cwd
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { headerLocation, sessionFileSystem } from '@deepseek-ai/dsh-execution-world/consumer'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'

const PARENT_PATH_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/

/**
 * The session workspace cwd for this call, or `undefined` when none applies.
 * For a remote session the cwd is the canonical absolute directory inside the
 * remote execution world (the header's `cwd`).
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @param requestedPath - the path the provider will resolve; parent traversal
 *   makes a symlinked cwd's filesystem identity observable.
 * @returns the calling agent's session cwd, or undefined for a non-agent caller (the backend then applies its own default).
 */
export function sessionCwd(exec: ToolExecution, requestedPath: string): string | undefined {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined || (!PARENT_PATH_SEGMENT.test(cwd) && !PARENT_PATH_SEGMENT.test(requestedPath))) return cwd
  return canonicalPath(cwd)
}

/**
 * The filesystem backend of the calling session's execution world, when it
 * differs from the local default. Remote (SSH) sessions resolve their backend
 * through the execution-world registry; local sessions keep `ctx.fs`.
 * @param ctx - the host context.
 * @param exec - the tool-execution context.
 * @returns the world's filesystem backend, or undefined to keep `ctx.fs`.
 */
export function sessionFs(ctx: Context, exec: ToolExecution): FileSystem | undefined {
  return sessionFileSystem(ctx, exec.agent?.session.header)
}

/**
 * The session's persisted execution location, when the calling agent has one.
 * @param exec - the tool-execution context.
 * @returns the execution location, or undefined for a non-agent caller.
 */
export function sessionLocation(exec: ToolExecution): ReturnType<typeof headerLocation> {
  return headerLocation(exec.agent?.session.header)
}

/**
 * Resolution options shared by all model-facing filesystem tools.
 * @param exec - the tool-execution context supplying session cwd and cancellation.
 * @param requestedPath - the path the provider will resolve.
 * @param policyWorkspaceRoot - resolved per-call root, when a mutation carries sandbox policy.
 * @returns provider resolution options for the current tool call.
 */
export function sessionResolveOptions(
  exec: ToolExecution,
  requestedPath: string,
  policyWorkspaceRoot?: string,
): { cwd?: string; signal?: AbortSignal } {
  const cwd = policyWorkspaceRoot ?? sessionCwd(exec, requestedPath)
  return {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
  }
}
