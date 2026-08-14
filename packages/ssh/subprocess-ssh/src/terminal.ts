/**
 * One remote PTY terminal process over `ssh -tt`, projected onto the terminal
 * subprocess primitive: text I/O, foreground-group inspection/signalling, and
 * session-tree termination.
 * @module @deepseek-ai/dsh-subprocess-ssh/terminal
 */

import { PassThrough } from 'node:stream'
import { posix } from 'node:path'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { SshTransport } from '@deepseek-ai/dsh-ssh'

/** One live SSH terminal and its owned remote PTY session. */
export class SshTerminalHandle implements SubprocessTerminalHandle {
  readonly output: PassThrough
  readonly done: Promise<SubprocessOutcome>

  private readonly channel: ReturnType<SshTransport['openPtyChannel']>
  private readonly pidFile: string
  private readonly graceMs: number
  private readonly terminationController = new AbortController()
  private terminated = false
  private readonly outcome: Promise<SubprocessOutcome>

  private constructor(
    private readonly transport: SshTransport,
    readonly pid: number,
    channel: ReturnType<SshTransport['openPtyChannel']>,
    pidFile: string,
    spec: SubprocessTerminalSpawnSpec,
  ) {
    this.channel = channel
    this.pidFile = pidFile
    this.graceMs = spec.graceMs
    this.output = new PassThrough()
    channel.stdout.on('data', (chunk: Buffer) => {
      if (!this.output.destroyed) this.output.write(chunk)
    })
    channel.stderr.on('data', () => {})
    this.outcome = new Promise<SubprocessOutcome>((resolve) => {
      void channel.exit.then(({ code, signal }) => {
        this.output.end()
        if (this.terminationController.signal.aborted) {
          resolve({ exitCode: null, signal: (signal ?? 'SIGTERM') as NodeJS.Signals })
        } else {
          resolve({ exitCode: code, signal: signal as NodeJS.Signals | null })
        }
      })
    })
    this.done = this.outcome
  }

  /**
   * Allocate the remote PTY and publish the top-level pid.
   * @param transport - SSH transport serving the terminal location.
   * @param spec - complete terminal spawn request.
   * @param stateDir - remote directory for terminal state files.
   * @returns the live terminal handle.
   */
  static async create(
    transport: SshTransport,
    spec: SubprocessTerminalSpawnSpec,
    stateDir: string,
  ): Promise<SshTerminalHandle> {
    await transport.installHelper()
    await transport.op('mkdir', { path: stateDir })
    const pidFile = posix.join(stateDir, 'pid')
    const channel = transport.openPtyChannel(spec.argv, pidFile)
    const pid = await SshTerminalHandle.waitForPid(transport, pidFile, spec.signal)
    if (pid === undefined) {
      channel.close()
      throw new Error('subprocess-ssh: remote terminal exited before publishing its pid')
    }
    return new SshTerminalHandle(transport, pid, channel, pidFile, spec)
  }

  private static async waitForPid(
    transport: SshTransport,
    pidFile: string,
    signal: AbortSignal | undefined,
  ): Promise<number | undefined> {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      try {
        const result = await transport.op('exec', {
          cwd: '/',
          argv: ['sh', '-c', `cat "${pidFile}" 2>/dev/null`],
          env: [],
          stdin: '',
          stdoutMax: 64,
          stderrMax: 64,
          stateDir: `${pidFile}.probe`,
        }, { timeoutMs: 5000 })
        const raw = String(result.stdout ?? '').trim()
        const pid = Number(raw)
        if (/^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(pid)) return pid
      } catch {
        signal?.throwIfAborted()
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, 100).unref() })
    }
    return undefined
  }

  /** @inheritdoc */
  async write(data: string): Promise<void> {
    if (this.terminationController.signal.aborted) throw new Error('terminal is terminating')
    await new Promise<void>((resolve, reject) => {
      this.channel.stdin.write(Buffer.from(data, 'utf8'), (error) => {
        if (error !== undefined && error !== null) reject(error)
        else resolve()
      })
    })
  }

  /** @inheritdoc */
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    try {
      const result = await this.transport.op('exec', {
        cwd: '/',
        argv: ['sh', '-c', `ps -o tpgid= -p "${this.pid}" 2>/dev/null`],
        env: [],
        stdin: '',
        stdoutMax: 64,
        stderrMax: 64,
        stateDir: `${this.pidFile}.fg`,
      }, { timeoutMs: 10000 })
      const raw = String(result.stdout ?? '').trim()
      const processGroupId = Number(raw)
      if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(processGroupId)) return undefined
      return { processGroupId, inputWaiting: false }
    } catch {
      return undefined
    }
  }

  /** @inheritdoc */
  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    const foreground = await this.inspectForeground()
    const group = foreground?.processGroupId ?? this.pid
    await this.transport.op('exec', {
      cwd: '/',
      argv: ['sh', '-c', `kill -s ${signal} -- "-${group}" 2>/dev/null; true`],
      env: [],
      stdin: '',
      stdoutMax: 64,
      stderrMax: 64,
      stateDir: `${this.pidFile}.sig`,
    }, { timeoutMs: 10000 })
    return group
  }

  /** @inheritdoc */
  async terminate(): Promise<void> {
    if (this.terminated) return
    this.terminated = true
    this.terminationController.abort(new Error('terminal terminated'))
    this.channel.close()
    try {
      await this.transport.op('exec', {
        cwd: '/',
        argv: ['sh', '-c',
          `pgid=$(ps -o pgid= -p "${this.pid}" 2>/dev/null | tr -d ' '); if [ -n "$pgid" ]; then kill -s TERM -- "-$pgid" 2>/dev/null; fi; true`],
        env: [],
        stdin: '',
        stdoutMax: 64,
        stderrMax: 64,
        stateDir: `${this.pidFile}.term`,
      }, { timeoutMs: this.graceMs })
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.graceMs)
        timer.unref()
      })
      await this.transport.op('exec', {
        cwd: '/',
        argv: ['sh', '-c',
          `pgid=$(ps -o pgid= -p "${this.pid}" 2>/dev/null | tr -d ' '); if [ -n "$pgid" ]; then kill -s KILL -- "-$pgid" 2>/dev/null; fi; true`],
        env: [],
        stdin: '',
        stdoutMax: 64,
        stderrMax: 64,
        stateDir: `${this.pidFile}.kill`,
      }, { timeoutMs: 10000 })
    } catch {
      // The remote session is gone or unreachable; the outcome owns the result.
    }
    this.output.end()
    await this.outcome.catch(() => undefined)
  }
}

export default SshTerminalHandle
