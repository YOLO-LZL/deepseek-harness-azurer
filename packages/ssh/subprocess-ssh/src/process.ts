/**
 * One asynchronously-started remote SSH process projected onto the subprocess
 * seam: process-group identity, bounded tail-keep output readers, batch/pipe
 * stdin, TERM→KILL escalation, and quiescence polling.
 * @module @deepseek-ai/dsh-subprocess-ssh/process
 */

import { Buffer } from 'node:buffer'
import { PassThrough, Writable } from 'node:stream'
import { posix } from 'node:path'
import { ExecutionError } from '@deepseek-ai/dsh-execution-location'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputRead,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { SshTransport } from '@deepseek-ai/dsh-ssh'
import { SshStdinWriter } from './index.ts'

function isCollect(mode: SubprocessOutputMode): mode is Exclude<SubprocessOutputMode, 'pipe' | 'inherit'> {
  return mode !== 'pipe' && mode !== 'inherit'
}

/**
 * Bounded tail-keep reader over a remote output file, fed by background
 * polling. `readFrom` is synchronous (the seam contract): the poll loop keeps
 * the in-memory window fresh while the process runs, so reads after
 * settlement see the final tail.
 */
class SshOutputReader implements SubprocessOutputReader {
  private windowStart = 0
  private window = Buffer.alloc(0)
  private totalBytes = 0

  constructor(
    private readonly transport: SshTransport,
    private readonly path: string,
    private readonly maxBytes: number,
    private readonly spillMaxBytes: number | undefined,
  ) {}

  /** Fetch one remote delta into the window (called by the handle's poll loop). */
  async poll(): Promise<void> {
    try {
      const result = await this.transport.op('read-range', {
        path: this.path,
        offset: this.windowStart + this.window.length,
        maxBytes: 64 * 1024,
      }, { timeoutMs: 10000 })
      const total = Number(result.total ?? 0)
      this.totalBytes = total
      const data = Buffer.from(String(result.data ?? ''), 'base64')
      if (data.length > 0) {
        this.window = Buffer.concat([this.window, data]).subarray(-this.maxBytes)
        this.windowStart = Math.max(0, this.windowStart + data.length - this.maxBytes)
      }
    } catch {
      // Best-effort; the outcome stays authoritative.
    }
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    const windowEnd = this.windowStart + this.window.length
    const lossy = fromByte < this.windowStart
    const start = Math.max(fromByte, this.windowStart) - this.windowStart
    const text = this.window.subarray(start).toString('utf8')
    const spillPath = this.spillMaxBytes !== undefined && this.totalBytes > this.spillMaxBytes
      ? this.path
      : undefined
    return {
      text,
      nextOffset: windowEnd,
      lossy,
      ...spillPath !== undefined ? { spillPath } : {},
    }
  }
}

/** One SSH-backed subprocess handle with deferred remote group acquisition. */
export class SshSubprocessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>

  private readonly stdoutReader: SshOutputReader | undefined
  private readonly stderrReader: SshOutputReader | undefined
  private remotePgid = -1
  private readonly stateDir: string
  private readonly paths: { out: string; err: string; status: string; pgid: string }
  private readonly terminationController = new AbortController()
  private readonly pollMs: number
  private quiescent = false
  private terminationSignal: NodeJS.Signals | null = null
  private readonly started = Promise.withResolvers<void>()

  constructor(
    private readonly transport: SshTransport,
    private readonly spec: SubprocessSpawnSpec,
    stateDir: string,
    pollMs: number,
  ) {
    this.stateDir = stateDir
    this.pollMs = pollMs
    this.paths = {
      out: posix.join(stateDir, 'out'),
      err: posix.join(stateDir, 'err'),
      status: posix.join(stateDir, 'status'),
      pgid: posix.join(stateDir, 'pgid'),
    }
    const outMode = spec.stdio.stdout
    const errMode = spec.stdio.stderr
    this.stdout = outMode === 'pipe' ? new PassThrough() : undefined
    this.stderr = errMode === 'pipe' ? new PassThrough() : undefined
    this.stdoutReader = isCollect(outMode)
      ? new SshOutputReader(
        transport,
        this.paths.out,
        outMode.maxBytes,
        outMode.spill?.maxBytes,
      )
      : undefined
    this.stderrReader = isCollect(errMode)
      ? new SshOutputReader(
        transport,
        this.paths.err,
        errMode.maxBytes,
        errMode.spill?.maxBytes,
      )
      : undefined
    this.collected = {
      ...(this.stdoutReader !== undefined ? { stdout: this.stdoutReader } : {}),
      ...(this.stderrReader !== undefined ? { stderr: this.stderrReader } : {}),
    }
    this.stdin = spec.stdio.stdin === 'pipe'
      ? new SshStdinWriter(transport, posix.join(stateDir, 'stdin.pipe'))
      : undefined
    spec.signal?.addEventListener('abort', this.onAbort, { once: true })
    this.done = this.run()
    void this.done.catch(() => {})
    if (spec.signal?.aborted === true) this.terminate()
  }

  /** Remote process-group id after start; `-1` while startup is pending or after it fails. */
  get pid(): number {
    return this.remotePgid
  }

  /** @inheritdoc */
  terminate(): void {
    if (this.quiescent) return
    this.terminationController.abort(new Error('subprocess-ssh: command terminated'))
    this.stdout?.destroy()
    this.stderr?.destroy()
    void this.terminateRemote('TERM')
  }

  /** @inheritdoc */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.quiescent) return true
    if (this.remotePgid <= 0) {
      const observed = await this.waitForStart(signal)
      if (observed === false) return false
    }
    while (await this.groupAlive()) {
      if (signal?.aborted === true || this.terminationController.signal.aborted) return false
      await this.tick()
    }
    this.quiescent = true
    return true
  }

  private readonly onAbort = (): void => { this.terminate() }

  private waitForStart(signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (value: boolean): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const onAbort = (): void => { settle(false) }
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort)
        this.terminationController.signal.removeEventListener('abort', onAbort)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.terminationController.signal.addEventListener('abort', onAbort, { once: true })
      void this.started.promise.then(() => { settle(true) })
    })
  }

  private async run(): Promise<SubprocessOutcome> {
    try {
      await this.transport.installHelper()
      await this.transport.op('mkdir', { path: this.stateDir })
      await this.transport.op('chmod', { path: this.stateDir, mode: '700' })
      const stdinPipe = this.spec.stdio.stdin === 'pipe'
      await this.transport.op('spawn', {
        cwd: this.spec.cwd,
        argv: [...this.spec.argv],
        env: this.serializeEnv(),
        stdin: typeof this.spec.stdio.stdin === 'object' ? this.spec.stdio.stdin.data : '',
        stdinPipe,
        stateDir: this.stateDir,
      })
      const pgidRaw = String((await this.transport.op('exec', {
        cwd: '/',
        argv: ['sh', '-c', `cat "${this.paths.pgid}"`],
        env: [],
        stdin: '',
        stdoutMax: 64,
        stderrMax: 64,
        stateDir: `${this.stateDir}.pgid`,
      }, { timeoutMs: 10000 })).stdout ?? '').trim()
      const pgid = Number(pgidRaw)
      if (!/^[1-9][0-9]*$/.test(pgidRaw) || !Number.isSafeInteger(pgid) || pgid <= 1) {
        throw new Error(`subprocess-ssh: unsafe published process-group id ${JSON.stringify(pgidRaw)}`)
      }
      this.remotePgid = pgid
      this.started.resolve()
      // Batch stdin is already embedded in the spawn op; pipe stdin is fed by
      // the consumer through the fifo.
      if (this.spec.stdio.stdin === 'pipe') {
        void this.forwardPipeOutput()
      }
      const outcome = await this.waitForCommand()
      if (outcome.signal !== null || this.terminationController.signal.aborted) {
        this.terminationSignal = outcome.signal
      }
      // Final output poll so the sync readers see the completed tail.
      await this.pollOutputs()
      this.stdout?.end()
      this.stderr?.end()
      return outcome
    } catch (error: unknown) {
      this.started.resolve()
      this.quiescent = true
      this.stdout?.end()
      this.stderr?.end()
      if (this.terminationController.signal.aborted) {
        return { exitCode: null, signal: 'SIGTERM' }
      }
      if (error instanceof ExecutionError) throw error
      throw error
    }
  }

  private serializeEnv(): string[] {
    const entries: string[] = []
    const scrubbed = new Set<string>()
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key) || key.toUpperCase().startsWith('DSH_')) {
        scrubbed.add(key)
        continue
      }
      entries.push(`${key}=${value}`)
    }
    // Explicit env entries layer after the scrub; undefined is a tombstone.
    for (const [key, value] of Object.entries(this.spec.env ?? {})) {
      if (value === undefined) {
        const index = entries.findIndex(entry => entry.startsWith(`${key}=`))
        if (index >= 0) entries.splice(index, 1)
        continue
      }
      const index = entries.findIndex(entry => entry.startsWith(`${key}=`))
      if (index >= 0) entries[index] = `${key}=${value}`
      else entries.push(`${key}=${value}`)
    }
    void scrubbed
    return entries
  }

  /** Poll the collect-mode readers once (keeps their sync windows fresh). */
  private async pollOutputs(): Promise<void> {
    await Promise.all([
      this.stdoutReader?.poll(),
      this.stderrReader?.poll(),
    ])
  }

  private async forwardPipeOutput(): Promise<void> {
    let stdoutOffset = 0
    let stderrOffset = 0
    while (true) {
      if (this.terminationController.signal.aborted || this.quiescent) {
        this.stdout?.end()
        this.stderr?.end()
        return
      }
      let progress = false
      try {
        if (this.stdout !== undefined) {
          const result = await this.transport.op('read-range', {
            path: this.paths.out, offset: stdoutOffset, maxBytes: 64 * 1024,
          })
          const data = Buffer.from(String(result.data ?? ''), 'base64')
          if (data.length > 0) {
            stdoutOffset += data.length
            progress = true
            if (!this.stdout.destroyed) this.stdout.write(data)
          }
        }
        if (this.stderr !== undefined) {
          const result = await this.transport.op('read-range', {
            path: this.paths.err, offset: stderrOffset, maxBytes: 64 * 1024,
          })
          const data = Buffer.from(String(result.data ?? ''), 'base64')
          if (data.length > 0) {
            stderrOffset += data.length
            progress = true
            if (!this.stderr.destroyed) this.stderr.write(data)
          }
        }
      } catch {
        // Pipe forwarding is best-effort; the outcome stays authoritative.
      }
      if (!progress) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.pollMs)
          timer.unref()
        })
      }
    }
  }

  private async waitForCommand(): Promise<SubprocessOutcome> {
    while (await this.groupAlive()) {
      if (this.terminationController.signal.aborted) return { exitCode: null, signal: this.terminationSignal ?? 'SIGTERM' }
      await this.pollOutputs()
      await this.tick()
    }
    // Read the published exit code; a missing file means the wrapper died
    // before publication (signal path).
    try {
      const result = await this.transport.op('stat-file', { path: this.paths.status })
      if (result.missing !== true) {
        const raw = String((await this.transport.op('read-range', {
          path: this.paths.status, offset: 0, maxBytes: 16,
        })).data ?? '').trim()
        const exitCode = Number(raw)
        if (/^[0-9]+$/.test(raw) && Number.isSafeInteger(exitCode) && exitCode <= 255) {
          return { exitCode, signal: null }
        }
      }
    } catch {
      // Fall through to the signal classification.
    }
    return { exitCode: null, signal: this.terminationSignal ?? 'SIGTERM' }
  }

  private async terminateRemote(signal: 'TERM' | 'KILL'): Promise<void> {
    if (this.remotePgid <= 0 || this.quiescent) return
    this.terminationSignal = signal === 'TERM' ? 'SIGTERM' : 'SIGKILL'
    try {
      await this.transport.op('kill', { pgid: this.remotePgid, signal })
      const deadline = Date.now() + this.spec.graceMs
      while (await this.groupAlive()) {
        if (Date.now() >= deadline) {
          if (signal === 'KILL') {
            this.quiescent = true
            return
          }
          await this.transport.op('kill', { pgid: this.remotePgid, signal: 'KILL' })
          this.terminationSignal = 'SIGKILL'
          break
        }
        await this.tick()
      }
      this.quiescent = true
    } catch {
      // The group is gone or unreachable; the outcome classifies via the
      // termination signal.
      this.quiescent = true
    }
  }

  private async groupAlive(): Promise<boolean> {
    if (this.remotePgid <= 0) return true
    try {
      const result = await this.transport.op('alive', { pgid: this.remotePgid }, { timeoutMs: 10000 })
      return result.alive === true
    } catch {
      // A transport failure cannot prove death; treat as alive until the
      // channel recovers or the owner aborts.
      return !this.terminationController.signal.aborted
    }
  }

  private tick(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.pollMs)
      timer.unref()
    })
  }
}
