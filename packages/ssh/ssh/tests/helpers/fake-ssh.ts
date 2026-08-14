/**
 * In-memory fake of the remote SSH helper wire: implements the frame protocol,
 * the install one-shot, the pty/stdin-fifo modes, and every helper op against
 * a fake remote filesystem/process world. Tests drive `SshTransport` through
 * `fakeSpawner(remote)` exactly as they would drive the real ssh client.
 */

import { PassThrough } from 'node:stream'
import { posix } from 'node:path'
import type { SshChannel, SshSpawner } from '../../src/transport.ts'
import { HELPER_BANNER, helperFileName, renderHelperSource, SSH_HELPER_PROTOCOL_VERSION } from '../../src/helper.ts'
import { createHash } from 'node:crypto'

/** One fake remote file node. */
export interface FakeRemoteNode {
  data: Buffer
  mode: string
}

/** One fake remote process group. */
export interface FakeRemoteProcess {
  argv: readonly string[]
  cwd: string
  out: string
  err: string
  status: string | null
  alive: boolean
}

/** The fake remote world. */
export class FakeRemote {
  files = new Map<string, FakeRemoteNode>()
  dirs = new Set<string>()
  symlinks = new Map<string, string>()
  processes = new Map<string, FakeRemoteProcess>()
  nextPid = 1000
  /** Op → injected failure message (op fails with this text). */
  failures = new Map<string, string>()
  /** When true, the persistent channel reads requests but never answers (timeout tests). */
  silent = false
  /** Installed helper hashes by filename. */
  helperHashes = new Map<string, string>()
  /** Recorded argv vectors (for install/pty/fifo assertions). */
  spawnArgvs: string[][] = []
  /** Per-file mutation counters driving mtimeMs (version tokens differ across writes). */
  mtimes = new Map<string, number>()
  /** Whether the ssh client "exists" (spawn fails when false). */
  clientAvailable = true
  banner = HELPER_BANNER

  file(path: string, data = ''): FakeRemoteNode {
    const node = { data: Buffer.from(data, 'utf8'), mode: '644' }
    this.files.set(path, node)
    this.touch(path)
    return node
  }

  /** Bump one path's mutation counter. */
  touch(path: string): void {
    this.mtimes.set(path, (this.mtimes.get(path) ?? 1000) + 1)
  }

  dir(path: string): void {
    this.dirs.add(path)
  }

  /** All ancestor dirs of a path count as existing dirs. */
  ensureParents(path: string): void {
    let current = posix.dirname(path)
    while (current !== '/' && current !== '.' && !this.dirs.has(current)) {
      this.dirs.add(current)
      current = posix.dirname(current)
    }
  }

  failOp(op: string, message: string): void {
    this.failures.set(op, message)
  }
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function decodeB64(text: string): Buffer {
  return Buffer.from(text, 'base64')
}

function probeType(remote: FakeRemote, path: string): { type: string; link?: string; size: number } {
  if (remote.symlinks.has(path)) return { type: 'symlink', link: remote.symlinks.get(path) ?? '', size: 0 }
  if (remote.files.has(path)) return { type: 'file', size: remote.files.get(path)!.data.length }
  if (remote.dirs.has(path)) return { type: 'directory', size: 0 }
  return { type: 'other', size: 0 }
}

/** Dispatch one op request against the fake world. */
export function dispatchOp(remote: FakeRemote, req: Record<string, unknown>): Record<string, unknown> {
  const op = String(req.op)
  const failure = remote.failures.get(op)
  if (failure !== undefined) {
    return { ok: false, error: { message: failure, code: 'remote-io' } }
  }
  switch (op) {
    case 'ping':
      return { ok: true, version: SSH_HELPER_PROTOCOL_VERSION, banner: HELPER_BANNER }
    case 'realpath': {
      const path = String(req.path)
      const lenient = req.lenient === true
      const existing = probeType(remote, path).type !== 'other'
        || remote.dirs.has(path)
      if (!existing && !lenient) return { ok: false, error: { message: `realpath: ${path}: No such file or directory`, code: 'remote-io' } }
      return { ok: true, path: posix.normalize(path) }
    }
    case 'exists': {
      const path = String(req.path)
      return { ok: true, exists: probeType(remote, path).type !== 'other' || remote.symlinks.has(path) }
    }
    case 'isdir':
      return { ok: true, isDir: remote.dirs.has(String(req.path)) }
    case 'readlink': {
      const target = remote.symlinks.get(String(req.path))
      return target === undefined
        ? { ok: false, error: { message: 'readlink failed', code: 'remote-io' } }
        : { ok: true, target }
    }
    case 'stat': {
      const path = String(req.path)
      const info = probeType(remote, path)
      if (info.type === 'other' && !remote.dirs.has(path)) return { ok: true, missing: true }
      return {
        ok: true,
        type: info.type,
        size: info.size,
        mode: info.type === 'file' ? Number.parseInt(remote.files.get(path)!.mode, 8) : 0o755,
        mtimeMs: remote.mtimes.get(path) ?? 1000,
        symlinkTarget: info.link ?? '',
      }
    }
    case 'list': {
      const path = String(req.path)
      if (!remote.dirs.has(path)) return { ok: false, error: { message: `list: not a directory: ${path}`, code: 'remote-io' } }
      const entries: { name: string; type: string; size: number }[] = []
      const seen = new Set<string>()
      for (const key of [...remote.files.keys(), ...remote.dirs, ...remote.symlinks.keys()]) {
        if (!key.startsWith(`${path.replace(/\/+$/, '')}/`)) continue
        const name = key.slice(path.replace(/\/+$/, '').length + 1).split('/')[0] ?? ''
        if (name === '' || seen.has(name)) continue
        seen.add(name)
        const child = `${path.replace(/\/+$/, '')}/${name}`
        const info = probeType(remote, child)
        entries.push({ name, type: info.type, size: info.size })
      }
      return { ok: true, entries }
    }
    case 'read': {
      const path = String(req.path)
      const node = remote.files.get(path)
      if (node === undefined) return { ok: false, error: { message: `read: not a regular file: ${path}`, code: 'remote-io' } }
      return { ok: true, data: node.data.toString('base64'), size: node.data.length }
    }
    case 'write': {
      const path = String(req.path)
      remote.ensureParents(path)
      const data = decodeB64(String(req.data))
      remote.files.set(path, { data, mode: String(req.mode ?? '600') })
      remote.touch(path)
      return { ok: true }
    }
    case 'mkdir': {
      remote.dirs.add(String(req.path))
      remote.ensureParents(String(req.path))
      return { ok: true }
    }
    case 'rm': {
      const path = String(req.path)
      remote.files.delete(path)
      remote.dirs.delete(path)
      remote.symlinks.delete(path)
      return { ok: true }
    }
    case 'chmod': {
      const path = String(req.path)
      const node = remote.files.get(path)
      if (node !== undefined) node.mode = String(req.mode)
      return { ok: true }
    }
    case 'which': {
      const command = String(req.command)
      if (command === 'bash' || command === 'rg' || command === 'node') {
        return { ok: true, path: `/usr/bin/${command}` }
      }
      return { ok: true, path: '' }
    }
    case 'spawn': {
      const stateDir = String(req.stateDir)
      const pid = remote.nextPid++
      remote.processes.set(stateDir, {
        argv: req.argv as string[],
        cwd: String(req.cwd),
        out: `${stateDir}/out`,
        err: `${stateDir}/err`,
        status: null,
        alive: true,
      })
      remote.ensureParents(`${stateDir}/out`)
      remote.files.set(`${stateDir}/out`, { data: Buffer.alloc(0), mode: '600' })
      remote.files.set(`${stateDir}/err`, { data: Buffer.alloc(0), mode: '600' })
      remote.files.set(`${stateDir}/pgid`, { data: Buffer.from(String(pid), 'utf8'), mode: '600' })
      remote.files.set(`${stateDir}/status`, { data: Buffer.alloc(0), mode: '600' })
      return { ok: true }
    }
    case 'alive': {
      const pgid = Number(req.pgid)
      const process = [...remote.processes.values()].find(candidate => Number(candidate.out.match(/\d+$/)![0]) === pgid)
      return { ok: true, alive: process?.alive ?? false }
    }
    case 'kill': {
      const pgid = Number(req.pgid)
      for (const [key, process] of remote.processes) {
        if (Number(key.match(/\d+$/)![0]) === pgid) {
          process.alive = false
          process.status = '143'
          remote.files.set(`${key}/status`, { data: Buffer.from('143', 'utf8'), mode: '600' })
        }
      }
      return { ok: true, killed: true }
    }
    case 'exec': {
      // Foreground exec: run the argv against the fake world (only sh -c probes
      // are used by the transport itself).
      const argv = req.argv as string[]
      const command = argv[argv.length - 1] ?? ''
      if (argv.includes('cat')) {
        const match = command.match(/cat "([^"]+)"/)
        if (match !== null) {
          const path = match[1]!
          const node = remote.files.get(path)
          return { ok: true, exitCode: node === undefined ? 1 : 0, stdout: base64(node?.data.toString('utf8') ?? ''), stderr: '' }
        }
      }
      return { ok: true, exitCode: 0, stdout: '', stderr: '', pgid: '0' }
    }
    case 'read-range': {
      const path = String(req.path)
      const node = remote.files.get(path)
      if (node === undefined) return { ok: false, error: { message: `read-range: not a regular file: ${path}`, code: 'remote-io' } }
      const offset = Number(req.offset ?? 0)
      const maxBytes = Number(req.maxBytes ?? 65536)
      const slice = node.data.subarray(offset, offset + maxBytes)
      return { ok: true, data: slice.toString('base64'), total: node.data.length }
    }
    case 'stat-file': {
      const node = remote.files.get(String(req.path))
      return node === undefined ? { ok: true, missing: true } : { ok: true, size: node.data.length }
    }
    default:
      return { ok: false, error: { message: `unknown op: ${op}`, code: 'remote-io' } }
  }
}

/** Frame-encode one payload (mirror of the transport's encodeFrame). */
function frame(payload: string): Buffer {
  return Buffer.from(`${payload.length.toString(16).padStart(16, '0')}\n${payload}\n`, 'utf8')
}

/**
 * Build a fake spawner speaking the helper wire protocol against `remote`.
 * @param remote - the fake remote world.
 * @returns an SshSpawner usable by `SshTransport`.
 */
export function fakeSpawner(remote: FakeRemote): SshSpawner {
  return (argv) => {
    remote.spawnArgvs.push([...argv])
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      // 'finish' fires when the writable side ends (the transport closes the
      // channel or a one-shot ends its stdin); 'end' additionally requires the
      // readable side to be consumed, which never happens for a one-shot.
      stdin.on('finish', () => { resolve({ code: 0, signal: null }) })
    })
    const channel: SshChannel = {
      stdin,
      stdout,
      stderr,
      exit,
      close: () => {
        stdin.end()
        stdout.end()
      },
    }
    if (!remote.clientAvailable) {
      stderr.write('ssh: command not found\n')
      stderr.end()
      return channel
    }
    const command = argv.join(' ')
    // One-shot install command: `bash -c '...install...sha256sum...'`.
    if (command.includes('sha256sum')) {
      const fileName = helperFileName()
      const dirMatch = command.match(/mkdir -p -- "([^"]+)"/)
      const dir = dirMatch?.[1] ?? '.dsh-ssh'
      const b64Match = command.match(/printf '%s' "([^"]+)" \| base64 -d/)
      const content = b64Match !== null ? decodeB64(b64Match[1] ?? '') : Buffer.alloc(0)
      const hash = createHash('sha256').update(content).digest('hex')
      remote.helperHashes.set(`${dir}/${fileName}`, hash)
      stdout.write(`${hash}  ${dir}/${fileName}\n`)
      stdout.end()
      stdin.end()
      return channel
    }
    // PTY mode.
    if (command.includes('--pty')) {
      const pidFileMatch = command.match(/--pty ([^ ]+)/)
      const pidFile = pidFileMatch?.[1] ?? '/tmp/pid'
      remote.ensureParents(pidFile)
      remote.files.set(pidFile, { data: Buffer.from(String(remote.nextPid++), 'utf8'), mode: '600' })
      stdout.write('fake-pty-output\n')
      stdout.end()
      return channel
    }
    // Stdin-fifo mode: consume frames, append decoded bytes to the fifo path.
    if (command.includes('--stdin-fifo')) {
      const fifoMatch = command.match(/--stdin-fifo ("[^"]+"|[^ ]+)/)
      const fifo = (fifoMatch?.[1] ?? '').replaceAll('"', '')
      let buffered = ''
      stdin.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8')
        while (true) {
          const newline = buffered.indexOf('\n')
          if (newline < 0) return
          const head = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          if (!/^[0-9a-f]{16}$/.test(head)) continue
          const length = Number.parseInt(head, 16)
          if (buffered.length < length + 1) return
          const payload = buffered.slice(0, length)
          buffered = buffered.slice(length + 1)
          const parsed = JSON.parse(payload) as { data?: string }
          if (parsed.data === undefined || parsed.data === '') return
          remote.ensureParents(fifo)
          const node = remote.files.get(fifo) ?? { data: Buffer.alloc(0), mode: '600' }
          node.data = Buffer.concat([node.data, decodeB64(parsed.data)])
          remote.files.set(fifo, node)
        }
      })
      return channel
    }
    // Persistent frame channel.
    const fileName = helperFileName()
    const helperInstalled = remote.helperHashes.has(`${remoteDirOf(command)}/${fileName}`)
    if (!helperInstalled) {
      // Simulate an uninstalled helper: install lazily at first channel open.
      const source = renderHelperSource()
      remote.helperHashes.set(`${remoteDirOf(command)}/${fileName}`, createHash('sha256').update(source).digest('hex'))
    }
    stdout.write(`${remote.banner}\n`)
    let buffered = ''
    const handle = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8')
      while (true) {
        const newline = buffered.indexOf('\n')
        if (newline < 0) return
        const head = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (!/^[0-9a-f]{16}$/.test(head)) continue
        const length = Number.parseInt(head, 16)
        if (buffered.length < length + 1) return
        const payload = buffered.slice(0, length)
        buffered = buffered.slice(length + 1)
        const request = JSON.parse(payload) as Record<string, unknown>
        if (remote.silent) continue
        const response = { id: request.id, ...dispatchOp(remote, request) }
        stdout.write(frame(JSON.stringify(response)))
      }
    }
    stdin.on('data', handle)
    return channel
  }
}

function remoteDirOf(command: string): string {
  const match = command.match(/bash ([^ ]+)/)
  const helper = match?.[1] ?? '.dsh-ssh/dsh-ssh-helper.v1.sh'
  return helper.replace(/\/[^/]+$/, '')
}
