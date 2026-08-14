/**
 * The SSH transport: spawns the system `ssh` client (BatchMode=yes, host-key
 * policy left to the user's OpenSSH configuration), installs the versioned
 * remote helper into the DSH-managed remote directory with content
 * verification, and runs one framed op per request over a persistent channel.
 * Paths, argv, environment, and file content travel as structured frames —
 * never concatenated into remote command text.
 * @module @deepseek-ai/dsh-ssh/transport
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { encodeFrame, FrameReader } from './frames.ts'
import { HELPER_BANNER, helperFileName, renderHelperSource, SSH_HELPER_PROTOCOL_VERSION } from './helper.ts'

/** One resolved connection the transport dials. */
export interface SshTransportTarget {
  /** `[user@]host` or a ~/.ssh/config alias; ssh resolves it. */
  host: string
  /** SSH port. */
  port: number
  /** Private key path, when one is configured. */
  keyPath?: string
  /** ssh ConnectTimeout in seconds. */
  connectTimeout: number
}

/** One live ssh child process face — abstracted so tests can fake the wire. */
export interface SshChannel {
  readonly stdin: NodeJS.WritableStream
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  /** Settles with the child's exit facts. */
  readonly exit: Promise<{ code: number | null; signal: string | null }>
  /** Destroy the child (used to abort in-flight ops). */
  close(): void
}

/** Spawner abstraction: the real implementation spawns the system ssh client. */
export type SshSpawner = (argv: readonly string[]) => SshChannel

/**
 * Quote one token for a remote shell word.
 * @param value - unquoted token value.
 * @returns a POSIX-shell-safe single-quoted word.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, '\'\\\'\'')}'`
}

/**
 * Create the system SSH client spawner with no host-key override.
 * @returns a spawner for OpenSSH child processes.
 */
export function createSystemSshSpawner(): SshSpawner {
  return (argv) => {
    const [command, ...args] = argv
    if (command === undefined) throw new Error('ssh spawner requires a command')
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('exit', (code, signal) => { resolve({ code, signal }) })
      child.on('error', (error) => { resolve({ code: null, signal: null }); void error })
    })
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exit,
      close: () => {
        child.stdin.end()
        child.kill()
      },
    }
  }
}

/** One op response (either arm carries the op's own result fields). */
export type SshOpResponse =
  | ({ readonly ok: true } & Record<string, unknown>)
  | { readonly ok: false; readonly error: { readonly message: string; readonly code: string } }

/** A failed transport round-trip. */
export class SshTransportError extends Error {
  /** Machine-readable transport failure category. */
  readonly code: 'ssh-unavailable' | 'ssh-helper-mismatch' | 'ssh-protocol' | 'ssh-timeout'

  constructor(message: string, code: SshTransportError['code'], options?: ErrorOptions) {
    super(message, options)
    this.name = 'SshTransportError'
    this.code = code
  }
}

/** Configuration of one transport instance. */
export interface SshTransportOptions {
  target: SshTransportTarget
  /** Remote DSH-managed state directory (relative to the login home). */
  remoteStateDir: string
  /** Spawner for the ssh client (tests inject a fake). */
  spawner?: SshSpawner
  /** Per-op timeout in milliseconds; default 30000. */
  opTimeoutMs?: number
  /** Diagnostics sink for stderr lines. */
  onDiagnostics?: (line: string) => void
}

interface PendingOp {
  resolve(response: SshOpResponse): void
  reject(error: unknown): void
}

/**
 * One persistent frame channel plus the pending-op table. A failed op or an
 * aborted signal destroys the channel; the next op reconnects.
 */
export class SshTransport {
  private readonly spawner: SshSpawner
  private readonly opTimeoutMs: number
  private channel: SshChannel | undefined
  private reader: FrameReader | undefined
  private pending = new Map<string, PendingOp>()
  private readonly diagnostics: (line: string) => void
  private installed: boolean | undefined
  private closed = false

  constructor(readonly options: SshTransportOptions) {
    this.spawner = options.spawner ?? createSystemSshSpawner()
    this.opTimeoutMs = options.opTimeoutMs ?? 30000
    this.diagnostics = options.onDiagnostics ?? (() => {})
  }

  /** The effective ssh argv for one remote command. */
  private sshArgv(remoteArgs: readonly string[], pty = false): string[] {
    const { target } = this.options
    const argv = [
      'ssh',
      ...(pty ? ['-tt'] : []),
      '-p', String(target.port),
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${target.connectTimeout}`,
    ]
    if (target.keyPath !== undefined) argv.push('-i', target.keyPath)
    argv.push(target.host, ...remoteArgs)
    return argv
  }

  /**
   * Open a stdin-fifo forwarding channel for one spawned process. The helper
   * reads `{ data: base64 }` frames and appends the decoded bytes to the fifo;
   * an empty `data` closes it (child stdin EOF). The channel is dedicated to
   * that process and must be closed by the owner.
   * @param fifoPath - remote fifo path the spawned child reads.
   * @returns the live channel.
   */
  openStdinFifoChannel(fifoPath: string): SshChannel {
    const fileName = helperFileName()
    return this.spawner(this.sshArgv([
      'bash', `${this.options.remoteStateDir}/${fileName}`, '--stdin-fifo', fifoPath,
    ]))
  }

  /**
   * Open a PTY channel for one terminal process: `ssh -tt` allocates the
   * remote PTY, the helper writes its own pid to `pidFile` and execs the
   * requested argv. The owner writes terminal input to the channel's stdin and
   * reads terminal output from its stdout.
   * @param argv - the terminal's argv (e.g. `bash --noprofile --norc -i`).
   * @param pidFile - remote file receiving the top-level process pid.
   * @returns the live PTY channel.
   */
  openPtyChannel(argv: readonly string[], pidFile: string): SshChannel {
    const fileName = helperFileName()
    return this.spawner(this.sshArgv([
      'bash', `${this.options.remoteStateDir}/${fileName}`, '--pty', pidFile,
      ...argv.map(shellQuote),
    ], true))
  }

  /**
   * Install (or verify) the remote helper. One-shot: writes the helper
   * atomically and verifies its sha256; removes stale protocol versions.
   * Idempotent per transport instance.
   */
  async installHelper(): Promise<void> {
    if (this.installed !== undefined) {
      if (!this.installed) throw new SshTransportError('ssh helper install failed', 'ssh-unavailable')
      return
    }
    const source = renderHelperSource()
    const expectedHash = createHash('sha256').update(source, 'utf8').digest('hex')
    const fileName = helperFileName()
    const b64 = Buffer.from(source, 'utf8').toString('base64')
    const dir = this.options.remoteStateDir
    const command = [
      `mkdir -p -- "${dir}" && chmod 700 -- "${dir}"`,
      `printf '%s' "${b64}" | base64 -d > "${dir}/.helper.tmp.$$"`,
      `chmod 700 -- "${dir}/.helper.tmp.$$"`,
      `mv -f -- "${dir}/.helper.tmp.$$" "${dir}/${fileName}"`,
      `rm -f -- "${dir}"/dsh-ssh-helper.v[0-9]*.sh`,
      `rm -f -- "${dir}"/.helper.tmp.*`,
      `sha256sum -- "${dir}/${fileName}"`,
    ].join(' && ')
    const result = await this.runOneShot(command, this.opTimeoutMs)
    const hashLine = result.stdout.split('\n')[0] ?? ''
    const actualHash = hashLine.split(/\s+/)[0]
    if (result.exitCode !== 0 || actualHash !== expectedHash) {
      this.installed = false
      throw new SshTransportError(
        `ssh helper install verification failed (expected ${expectedHash}, got ${actualHash ?? '(none)'})`,
        'ssh-helper-mismatch',
      )
    }
    this.installed = true
  }

  /** Run one non-framed remote command (install/verify path). */
  private async runOneShot(command: string, timeoutMs: number): Promise<{ stdout: string; exitCode: number }> {
    const channel = this.spawner(this.sshArgv(['bash', '-c', command]))
    return await new Promise<{ stdout: string; exitCode: number }>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        channel.close()
        reject(new SshTransportError(`ssh one-shot timed out after ${timeoutMs}ms`, 'ssh-timeout'))
      }, timeoutMs)
      channel.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      channel.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      void channel.exit.then(({ code }) => {
        clearTimeout(timer)
        if (code === null && stderr.length === 0) {
          reject(new SshTransportError('ssh client could not be started — is the system ssh installed?', 'ssh-unavailable'))
          return
        }
        resolve({ stdout, exitCode: code ?? 1 })
      })
    })
  }

  /** Dial the persistent channel and verify the helper banner. */
  private async openChannel(): Promise<SshChannel> {
    const fileName = helperFileName()
    const channel = this.spawner(this.sshArgv(['bash', `${this.options.remoteStateDir}/${fileName}`]))
    const banner = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        channel.close()
        reject(new SshTransportError('ssh helper banner timed out', 'ssh-timeout'))
      }, this.opTimeoutMs)
      let buffered = ''
      const onData = (chunk: Buffer): void => {
        buffered += chunk.toString('utf8')
        const newline = buffered.indexOf('\n')
        if (newline >= 0) {
          clearTimeout(timer)
          channel.stdout.off('data', onData)
          resolve(buffered.slice(0, newline))
        }
      }
      channel.stdout.on('data', onData)
      channel.stderr.on('data', (chunk: Buffer) => {
        this.diagnostics(chunk.toString('utf8'))
      })
    })
    if (banner.trim() !== HELPER_BANNER) {
      channel.close()
      throw new SshTransportError(
        `ssh helper banner mismatch: got ${JSON.stringify(banner.trim())}`,
        'ssh-helper-mismatch',
      )
    }
    this.reader = new FrameReader()
    channel.stdout.on('data', (chunk: Buffer) => { this.dispatch(chunk) })
    channel.stdout.on('end', () => {
      this.failPending(new SshTransportError('ssh helper channel closed', 'ssh-unavailable'))
    })
    return channel
  }

  private dispatch(chunk: Buffer): void {
    let frames: string[]
    try {
      frames = this.reader?.push(chunk) ?? []
    } catch (error) {
      this.failPending(error)
      this.destroyChannel()
      return
    }
    for (const frame of frames) {
      let parsed: unknown
      try {
        parsed = JSON.parse(frame)
      } catch {
        this.failPending(new SshTransportError('ssh helper returned invalid JSON', 'ssh-protocol'))
        this.destroyChannel()
        return
      }
      const response = parsed as { id?: unknown } & SshOpResponse
      if (typeof response.id !== 'string') {
        this.failPending(new SshTransportError('ssh helper response missing id', 'ssh-protocol'))
        this.destroyChannel()
        return
      }
      const pending = this.pending.get(response.id)
      if (pending === undefined) continue
      this.pending.delete(response.id)
      pending.resolve(response)
    }
  }

  private failPending(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private destroyChannel(): void {
    this.channel?.close()
    this.channel = undefined
    this.reader = undefined
  }

  /**
   * Run one framed op. Reconnects the channel when needed; rejects on abort,
   * timeout, or transport failure. A timed-out/aborted `exec` op leaves a
   * remote process group behind — its state dir is recorded so a later
   * `killInterrupted` can reap it.
   * @param op - op name.
   * @param params - op parameters (JSON-safe).
   * @param opts - cancellation and timeout.
   * @returns the response object (`ok: true` arm).
   */
  async op(
    op: string,
    params: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    opts?.signal?.throwIfAborted()
    if (this.closed) throw new SshTransportError('ssh transport is closed', 'ssh-unavailable')
    await this.installHelper()
    const id = randomUUID()
    const frame = encodeFrame(JSON.stringify({ id, op, ...params }))
    const timeoutMs = opts?.timeoutMs ?? this.opTimeoutMs
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        cleanup()
        fn()
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        opts?.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        this.pending.delete(id)
        this.destroyChannel()
        settle(() => reject(new SshTransportError(`ssh op ${op} aborted`, 'ssh-timeout')))
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.destroyChannel()
        settle(() => reject(new SshTransportError(`ssh op ${op} timed out after ${timeoutMs}ms`, 'ssh-timeout')))
      }, timeoutMs)
      opts?.signal?.addEventListener('abort', onAbort, { once: true })
      // The signal may have aborted before the listener attached (abort fires
      // synchronously while this op crossed the installHelper await).
      if (opts?.signal?.aborted === true) onAbort()
      void this.ensureChannel().then((channel) => {
        if (settled || this.channel !== channel) return
        this.pending.set(id, {
          resolve: response => settle(() => {
            if (!response.ok) {
              reject(new SshTransportError(
                `ssh op ${op} failed: ${response.error.message}`,
                'ssh-protocol',
              ))
              return
            }
            resolve(response)
          }),
          reject: (error) => {
            this.destroyChannel()
            settle(() => reject(error))
          },
        })
        channel.stdin.write(frame, (error) => {
          if (error !== undefined && error !== null) {
            this.pending.delete(id)
            this.destroyChannel()
            settle(() => reject(error))
          }
        })
      }, (error) => {
        settle(() => reject(error))
      })
    })
  }

  private async ensureChannel(): Promise<SshChannel> {
    if (this.channel !== undefined) return this.channel
    const channel = await this.openChannel()
    this.channel = channel
    return channel
  }

  /**
   * Kill a remote process group recorded for an interrupted exec.
   * @param stateDir - remote state dir whose `pgid` file names the group.
   * @param signal - 'TERM' or 'KILL'.
   */
  async killInterrupted(stateDir: string, signal: 'TERM' | 'KILL'): Promise<void> {
    try {
      await this.op('exec', {
        cwd: '/',
        argv: ['sh', '-c',
          `pgid=$(cat "${stateDir}/pgid" 2>/dev/null || true); if [ -n "$pgid" ]; then kill -s ${signal} -- "-$pgid" 2>/dev/null || true; fi; true`],
        env: [],
        stdin: '',
        stdoutMax: 1024,
        stderrMax: 1024,
        stateDir: `${stateDir}.kill`,
      }, { timeoutMs: 10000 })
    } catch {
      // Best-effort reaping; the interrupted group's state is bounded by the
      // remote state policy.
    }
  }

  /** Close the transport: destroys the channel and rejects in-flight ops. */
  close(): void {
    this.closed = true
    this.destroyChannel()
    this.failPending(new SshTransportError('ssh transport closed', 'ssh-unavailable'))
  }

  /** Protocol version this transport speaks. */
  static readonly protocolVersion = SSH_HELPER_PROTOCOL_VERSION
}
