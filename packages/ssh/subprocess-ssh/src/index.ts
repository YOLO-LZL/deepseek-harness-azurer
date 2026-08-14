/**
 * SSH subprocess Service Provider: one per execution location, over the
 * framed SSH transport. Managed remote process groups with bounded
 * spill-backed output, TERM→KILL escalation, pipe/batch stdin, and PTY
 * terminals with foreground-group signalling.
 * @module @deepseek-ai/dsh-subprocess-ssh
 */

import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ExecutionError } from '@deepseek-ai/dsh-execution-location'
import type { ExecutionLocation } from '@deepseek-ai/dsh-execution-location'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { SshTransport } from '@deepseek-ai/dsh-ssh'
import type { SshChannel } from '@deepseek-ai/dsh-ssh'
import { SshSubprocessHandle } from './process.ts'
import { SshTerminalHandle } from './terminal.ts'

/**
 * A detached context for per-location backends: the SubprocessRuntime base
 * registers `ctx.subprocess` at construction, but a remote backend is an
 * instance, not a service. `reflect.provide` is a no-op.
 */
function detachedContext(): Context {
  return { reflect: { provide: () => undefined } } as unknown as Context
}

/** Enforce the seam's documented grace bound, matching subprocess-local. */
function requireRepresentableGrace(graceMs: number): void {
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** Configuration of one SSH subprocess backend instance. */
export interface SshSubprocessConfig {
  /** Remote liveness/status poll cadence in milliseconds; default 50. */
  pollMs?: number
}

/** Omit the signal key entirely when undefined (exact optional properties). */
function signalOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

/** SSH subprocess backend for one execution location. */
export class SshSubprocessRuntime extends SubprocessRuntime {
  private readonly live = new Set<SshSubprocessHandle>()
  private readonly terminals = new Set<SshTerminalHandle>()
  private readonly pollMs: number
  private disposing = false

  constructor(
    private readonly location: ExecutionLocation,
    private readonly transport: SshTransport,
    readonly sessionRoot: string,
    config: SshSubprocessConfig = {},
  ) {
    super(detachedContext())
    this.pollMs = config.pollMs ?? 50
  }

  /** @inheritdoc */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
    world?: ExecutionLocation,
  ): Promise<string> {
    this.assertSshWorld(world, 'resolveExecutable')
    if (command.length === 0) throw new Error('subprocess-ssh: executable name must be non-empty')
    signal?.throwIfAborted()
    if (posix.isAbsolute(command)) {
      const facts = await this.transport.op('stat', { path: command, follow: true }, signalOpts(signal))
      if (facts.missing === true || facts.type !== 'file') {
        throw new Error(`subprocess-ssh: command ${JSON.stringify(command)} is not an executable file`)
      }
      signal?.throwIfAborted()
      return command
    }
    if (command.includes('/')) {
      throw new Error(
        `subprocess-ssh: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const result = await this.transport.op('which', {
      command,
      ...env?.PATH !== undefined ? { path: env.PATH } : {},
    }, signalOpts(signal))
    signal?.throwIfAborted()
    const executable = String(result.path ?? '').trim()
    if (executable.length === 0) {
      throw new Error(`subprocess-ssh: command ${JSON.stringify(command)} was not found on PATH`)
    }
    if (executable.includes('\n') || (!posix.isAbsolute(executable) && !executable.includes('/'))) {
      throw new Error(`subprocess-ssh: executable ${JSON.stringify(command)} did not resolve to one absolute path`)
    }
    return posix.resolve(this.location.root, executable)
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposing) throw new Error('subprocess-ssh: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('invalid argv: expected a non-empty program name at argv[0]')
    }
    requireRepresentableGrace(spec.graceMs)
    if (spec.signal?.aborted === true) {
      throw new Error(`aborted before spawn: ${String(spec.signal.reason)}`)
    }
    const stateDir = posix.join(this.sessionRoot, 'processes', randomUUID())
    const handle = new SshSubprocessHandle(this.transport, spec, stateDir, this.pollMs)
    this.live.add(handle)
    const release = async (): Promise<void> => {
      await handle.waitForExit()
      this.live.delete(handle)
    }
    void handle.done.then(release, release).catch((_automaticReleaseFailure: unknown) => {
      // Retain the handle so disposal can retry its cleanup transaction.
    })
    return handle
  }

  /** @inheritdoc */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposing) throw new Error('subprocess-ssh: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('subprocess-ssh: terminal argv must contain a program')
    }
    requireRepresentableGrace(spec.graceMs)
    spec.signal?.throwIfAborted()
    const stateDir = posix.join(this.sessionRoot, 'terminals', randomUUID())
    const terminal = await SshTerminalHandle.create(
      this.transport,
      spec,
      stateDir,
    )
    this.terminals.add(terminal)
    if (this.disposing) {
      await terminal.terminate()
      this.terminals.delete(terminal)
      throw new Error('subprocess-ssh: service disposed during terminal setup')
    }
    const release = async (): Promise<void> => {
      await terminal.terminate()
      this.terminals.delete(terminal)
    }
    void terminal.done.then(release, release).catch((_automaticReleaseFailure: unknown) => {
      // Retain the terminal so disposal can retry its cleanup transaction.
    })
    return terminal
  }

  /** Terminate every live process and terminal, awaiting quiescence. */
  async dispose(): Promise<void> {
    this.disposing = true
    const pending: Promise<unknown>[] = []
    for (const handle of [...this.live]) {
      handle.terminate()
      pending.push(handle.waitForExit().then(async () => {
        await handle.done.catch(() => undefined)
        this.live.delete(handle)
      }))
    }
    for (const terminal of [...this.terminals]) {
      pending.push(terminal.terminate().then(() => { this.terminals.delete(terminal) }))
    }
    const outcomes = await Promise.allSettled(pending)
    const failures = outcomes.flatMap<unknown>(outcome => outcome.status === 'rejected'
      ? [outcome.reason as unknown]
      : [])
    if (failures.length === 1) throw failures[0] as Error
    if (failures.length > 1) throw new AggregateError(failures, 'subprocess-ssh: teardown failed')
  }

  private assertSshWorld(world: ExecutionLocation | undefined, operation: string): void {
    if (world === undefined) return
    if (world.providerId !== 'ssh') {
      throw new ExecutionError(
        `subprocess-ssh cannot ${operation} for provider '${world.providerId}'`,
        'execution-provider-not-found',
      )
    }
  }
}

/** One deferred remote-stdin writer bound to a spawned process's fifo. */
export class SshStdinWriter extends Writable {
  private channel: SshChannel | undefined
  private channelClosed = false

  constructor(
    private readonly transport: SshTransport,
    private readonly fifoPath: string,
  ) {
    super({ decodeStrings: false })
  }

  override _write(chunk: string | Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.ensureChannel().then(async () => {
      try {
        await this.sendFrame(String(chunk).length > 0
          ? { data: Buffer.from(chunk).toString('base64') }
          : { data: '' })
        callback()
      } catch (error: unknown) {
        callback(error as Error)
      }
    }, (error: unknown) => { callback(error as Error) })
  }

  override _final(callback: (error?: Error | null) => void): void {    void this.ensureChannel().then(async () => {
    try {
      await this.sendFrame({ data: '' })
      this.closeChannel()
      callback()
    } catch (error: unknown) {
      this.closeChannel()
      callback(error as Error)
    }
  }, (error: unknown) => { callback(error as Error) })
  }

  private async ensureChannel(): Promise<void> {
    if (this.channel === undefined) {
      this.channel = this.transport.openStdinFifoChannel(this.fifoPath)
      this.channel.stderr.on('data', () => {})
    }
  }

  private sendFrame(payload: Record<string, unknown>): Promise<void> {
    const channel = this.channel
    if (channel === undefined) return Promise.reject(new Error('stdin channel is not open'))
    return new Promise<void>((resolve, reject) => {
      channel.stdin.write(`${JSON.stringify(payload).length.toString(16).padStart(16, '0')}\n${JSON.stringify(payload)}\n`, (error) => {
        if (error !== undefined && error !== null) reject(error)
        else resolve()
      })
    })
  }

  private closeChannel(): void {
    if (this.channelClosed) return
    this.channelClosed = true
    this.channel?.close()
    this.channel = undefined
  }
}
