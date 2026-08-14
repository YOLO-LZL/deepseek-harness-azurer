/**
 * Remote-world bash runner: when the calling session's execution world is
 * remote (SSH), the bash tool must run `bash -c` inside that world instead of
 * the host shell executor. This module produces the same result shape as
 * `ctx.shell.run` so the tool's rendering stays identical.
 *
 * Policy: remote arbitrary shells cannot be confined by the host sandbox, so
 * the first version only runs under `danger-full-access`; read-only /
 * workspace-write reject with `execution-policy-unsupported` before anything
 * executes.
 * @module @deepseek-ai/dsh-tool-bash/remote-run
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ExecutionError } from '@deepseek-ai/dsh-execution-location'
import { sessionWorld } from '@deepseek-ai/dsh-execution-world/consumer'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ShellProcess, ShellProcessRead, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

/** The remote runner's request face (a subset of ShellExecRequest). */
export interface RemoteBashRequest {
  command: string
  workdir?: string
  timeoutMs?: number
  env: Record<string, string>
  sandboxPolicy?: SandboxExecutionPolicy
}

/** Output caps for the remote runner (mirrors the host executor's tail shape). */
export interface RemoteBashCaps {
  stdoutMaxBytes: number
  stderrMaxBytes: number
}

/**
 * Run one bash command in the session's remote execution world.
 * @param ctx - the host context (registry routing).
 * @param exec - the tool execution (session header + cancellation).
 * @param request - the bash request.
 * @param caps - bounded-output caps.
 * @returns the shell-shaped result.
 * @throws {@link ExecutionError} with `execution-policy-unsupported` when the
 *   effective policy is not danger-full-access, and `execution-unavailable`
 *   when the world cannot serve right now.
 */
export async function runRemoteBash(
  ctx: Context,
  exec: ToolExecution,
  request: RemoteBashRequest,
  caps: RemoteBashCaps,
): Promise<ShellRunResult> {
  const world = sessionWorld(ctx, exec.agent?.session.header)
  if (world === undefined || world.subprocess === undefined || world.location.providerId === 'local') {
    throw new Error('runRemoteBash: the session has no remote execution world')
  }
  const mode = request.sandboxPolicy?.mode
  if (mode !== undefined && mode !== 'danger-full-access') {
    throw new ExecutionError(
      'remote bash requires danger-full-access: the host sandbox cannot confine an arbitrary remote shell under '
      + `'${mode}' — switch the session policy or run the command locally`,
      'execution-policy-unsupported',
    )
  }
  const cwd = request.workdir ?? world.location.root
  const timeoutMs = request.timeoutMs ?? 30000
  const handle = world.subprocess.spawn({
    argv: ['bash', '-c', request.command],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: caps.stdoutMaxBytes },
      stderr: { maxBytes: caps.stderrMaxBytes },
    },
    graceMs: 2000,
    signal: exec.signal,
    env: request.env,
    world: world.location,
  })
  return await awaitRemoteOutcome(handle, timeoutMs, exec.signal)
}

/**
 * Await a remote handle with the tool's timeout and cancellation semantics.
 * @param handle - the spawned remote process.
 * @param timeoutMs - foreground deadline.
 * @param signal - the tool-call signal.
 * @returns the shell-shaped result (never rejects for process outcomes).
 */
export async function awaitRemoteOutcome(
  handle: SubprocessHandle,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ShellRunResult> {
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    handle.terminate()
  }, timeoutMs)
  timer.unref()
  const onAbort = (): void => { handle.terminate() }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    return {
      aborted: signal.aborted,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut,
      timeoutMs,
      stdout: {
        text: stdout?.text ?? '',
        truncated: stdout?.lossy ?? false,
        ...stdout?.spillPath !== undefined ? { spillPath: stdout.spillPath } : {},
      },
      stderr: {
        text: stderr?.text ?? '',
        truncated: stderr?.lossy ?? false,
        ...stderr?.spillPath !== undefined ? { spillPath: stderr.spillPath } : {},
      },
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Start one remote bash command as a background process, projected onto the
 * shell process face so the existing jobs wiring works unchanged.
 * @param ctx - the host context (registry routing).
 * @param exec - the tool execution (session header).
 * @param request - the bash request.
 * @param caps - bounded-output caps.
 * @returns a ShellProcess-shaped handle over the remote process group.
 */
export function startRemoteBash(
  ctx: Context,
  exec: ToolExecution,
  request: RemoteBashRequest,
  caps: RemoteBashCaps,
): ShellProcess {
  const world = sessionWorld(ctx, exec.agent?.session.header)
  if (world === undefined || world.subprocess === undefined || world.location.providerId === 'local') {
    throw new Error('startRemoteBash: the session has no remote execution world')
  }
  const mode = request.sandboxPolicy?.mode
  if (mode !== undefined && mode !== 'danger-full-access') {
    throw new ExecutionError(
      'remote bash requires danger-full-access: the host sandbox cannot confine an arbitrary remote shell under '
      + `'${mode}' — switch the session policy or run the command locally`,
      'execution-policy-unsupported',
    )
  }
  const handle = world.subprocess.spawn({
    argv: ['bash', '-c', request.command],
    cwd: request.workdir ?? world.location.root,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: caps.stdoutMaxBytes },
      stderr: { maxBytes: caps.stderrMaxBytes },
    },
    graceMs: 2000,
    env: request.env,
    world: world.location,
  })
  return new RemoteShellProcess(handle)
}

/** A ShellProcess-shaped adapter over a remote subprocess handle. */
class RemoteShellProcess implements ShellProcess {
  status: ShellProcess['status'] = 'running'
  exitCode: number | null = null
  signal: NodeJS.Signals | null = null
  private lastStdout = 0
  private lastStderr = 0
  readonly done: Promise<void>

  constructor(private readonly handle: SubprocessHandle) {
    this.done = handle.done.then((outcome) => {
      this.exitCode = outcome.exitCode
      this.signal = outcome.signal
      this.status = outcome.signal !== null ? 'killed' : 'completed'
    }, () => {
      this.status = 'killed'
    })
    void this.done
  }

  readOutput(): ShellProcessRead {
    const stdout = this.handle.collected.stdout?.readFrom(this.lastStdout)
    const stderr = this.handle.collected.stderr?.readFrom(this.lastStderr)
    if (stdout !== undefined) this.lastStdout = stdout.nextOffset
    if (stderr !== undefined) this.lastStderr = stderr.nextOffset
    const out = stdout?.text ?? ''
    const err = stderr?.text ?? ''
    return {
      delta: err.length > 0 ? `${out}\n[stderr]\n${err}` : out,
      lossy: stdout?.lossy === true || stderr?.lossy === true,
      ...stdout?.spillPath !== undefined ? { stdoutSpillPath: stdout.spillPath } : {},
      ...stderr?.spillPath !== undefined ? { stderrSpillPath: stderr.spillPath } : {},
    }
  }

  kill(): boolean {
    if (this.status !== 'running') return false
    this.handle.terminate()
    return true
  }
}
