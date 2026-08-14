/**
 * Derive the workspace root an `lsp` call resolves against: the calling agent's per-session
 * workspace (`exec.agent.session.header.cwd`), mirroring how the filesystem tools resolve paths.
 * Unlike those tools, LSP has NO provider fallback — a missing cwd fails the call as
 * `LSP_WORKSPACE_REQUIRED`, because the local provider must canonicalize a real workspace before it
 * can start a server.
 * @module @deepseek-ai/dsh-tool-lsp/session-cwd
 */

import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ExecutionLocation } from '@deepseek-ai/dsh-execution-location'
import { headerLocation } from '@deepseek-ai/dsh-execution-world/consumer'

/**
 * The session workspace cwd for this call, or `undefined` when none applies.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the calling agent's session cwd, or undefined for a non-agent caller.
 */
export function sessionCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

/**
 * The calling session's persisted execution location, when it has one (the
 * local world at `cwd` is implicit and need not be sent).
 * @param exec - the tool-execution context.
 * @returns the remote execution location, or undefined for local/non-agent callers.
 */
export function executionLocationOf(exec: ToolExecution): ExecutionLocation | undefined {
  const location = headerLocation(exec.agent?.session.header)
  return location !== undefined && location.providerId !== 'local' ? location : undefined
}
