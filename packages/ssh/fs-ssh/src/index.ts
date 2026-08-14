/**
 * SSH provider for the filesystem capability seam. Paths, contents, and
 * atomic staging files remain inside one remote Linux execution world; every
 * primitive travels as a structured frame over the shared transport.
 * @module @deepseek-ai/dsh-fs-ssh
 */

import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ExecutionError } from '@deepseek-ai/dsh-execution-location'
import type { ExecutionLocation } from '@deepseek-ai/dsh-execution-location'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { SshTransport } from '@deepseek-ai/dsh-ssh'

/**
 * A detached context for per-location backends: the FileSystem base registers
 * `ctx.fs` at construction, but a remote backend is an instance, not a
 * service — the local `ctx.fs` keeps its seat. `reflect.provide` is a no-op
 * and no backend method touches the context.
 */
function detachedContext(): Context {
  return { reflect: { provide: () => undefined } } as unknown as Context
}
const BINARY_SAMPLE_BYTES = 8192
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

/** Omit the signal key entirely when undefined (exact optional properties). */
function signalOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

function decodeText(bytes: Uint8Array, displayPath: string): string {
  if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

/** Decode a base64 payload returned by the helper, with strict framing. */
function decodeB64(encoded: string, subject: string): Buffer {
  if (encoded.length === 0) return Buffer.alloc(0)
  if (!BASE64.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error(`fs-ssh: ${subject} returned invalid base64`)
  }
  const framed = Buffer.from(encoded, 'base64')
  if (framed.toString('base64') !== encoded) {
    throw new Error(`fs-ssh: ${subject} returned invalid base64`)
  }
  return framed
}

interface SshStatFacts {
  missing?: boolean
  type?: string
  size?: number
  mode?: number
  mtimeMs?: number
  symlinkTarget?: string
}

/** Remote filesystem backend sharing the transport of one ssh execution location. */
export class SshFileSystem extends FileSystem {
  static inject = ['ssh']

  private readonly locks = new Map<string, Promise<unknown>>()

  /**
   * @param location - the ssh execution location this backend serves.
   * @param transport - the location's transport (owned by the runtime).
   * @param sessionRoot - remote private state root (runtime-provided).
   */
  constructor(
    private readonly location: ExecutionLocation,
    private readonly transport: SshTransport,
    readonly sessionRoot: string,
  ) {
    super(detachedContext())
  }

  private assertLocation(location: ExecutionLocation | undefined, operation: string): void {
    if (location === undefined) return
    if (location.providerId !== 'ssh') {
      throw new ExecutionError(
        `fs-ssh cannot ${operation} for provider '${location.providerId}'`,
        'execution-provider-not-found',
      )
    }
  }

  override async resolve(
    path: string,
    opts?: { cwd?: string; signal?: AbortSignal; world?: ExecutionLocation },
  ): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    this.assertLocation(opts?.world, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.location.root, path)
    try {
      const result = await this.transport.op('realpath', { path: displayPath, lenient: true }, signalOpts(opts?.signal))
      const canonical = String(result.path)
      if (!posix.isAbsolute(canonical)) throw new Error('realpath returned a non-absolute path')
      assertNotAborted(opts?.signal, 'resolve')
      return { targetKey: FsTargetKey(canonical), displayPath }
    } catch (error: unknown) {
      throw mapError(error, 'resolve', displayPath, opts?.signal)
    }
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target)
    if (!posix.isAbsolute(path)) throw new Error(`fs-ssh: expected an absolute process path: ${JSON.stringify(path)}`)
    return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    const facts = await this.probe(String(target.targetKey), target.displayPath, true, signal)
    if (facts === undefined) return undefined
    return {
      version: versionOf(target.displayPath, facts),
      type: facts.type as FsInfo['type'],
      ...facts.type === 'file' && facts.size !== undefined ? { size: facts.size } : {},
    }
  }

  override async lstat(
    path: string,
    opts?: { cwd?: string; world?: ExecutionLocation },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    this.assertLocation(opts?.world, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const displayPath = posix.resolve(opts?.cwd ?? this.location.root, path)
    const facts = await this.probe(displayPath, displayPath, false, signal)
    if (facts === undefined) return undefined
    const type = facts.type === 'symlink'
      ? 'symlink' as const
      : facts.type === 'file'
        ? 'file' as const
        : facts.type === 'directory'
          ? 'directory' as const
          : 'other' as const
    return {
      version: versionOf(displayPath, facts),
      type,
      ...facts.type === 'file' && facts.size !== undefined ? { size: facts.size } : {},
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const info = await this.requireRegular(target, signal)
    try {
      const result = await this.transport.op('read', { path: String(target.targetKey) }, signalOpts(signal))
      assertNotAborted(signal, 'read')
      const bytes = decodeB64(String(result.data), 'read')
      if (info.size !== undefined && bytes.length !== info.size) {
        throw new FsError(`cannot read "${target.displayPath}": file changed while reading`, 'FS_STALE_VERSION')
      }
      return decodeText(bytes, target.displayPath)
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const info = await this.requireRegular(target, signal)
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    try {
      const result = await this.transport.op('read', { path: String(target.targetKey) }, signalOpts(signal))
      assertNotAborted(signal, 'read')
      const bytes = decodeB64(String(result.data), 'read')
      if (bytes.length > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
      }
      return bytes
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // The framed transport returns whole files; stream in ~64 KiB chunks from
    // the decoded text so large-file consumers keep their chunked contract.
    const text = await this.readText(target, signal)
    const CHUNK = 64 * 1024
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        for (let offset = 0; offset < text.length; offset += CHUNK) {
          assertNotAborted(signal, 'read')
          yield text.slice(offset, offset + CHUNK)
        }
      },
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    try {
      const result = await this.transport.op('list', { path: String(target.targetKey) }, signalOpts(signal))
      assertNotAborted(signal, 'list')
      const entries = (result.entries as unknown[]).map((entry) => {
        const raw = entry as { name: string; type: string; size?: number }
        const displayPath = posix.join(target.displayPath, raw.name)
        const targetKey = posix.join(String(target.targetKey), raw.name)
        return {
          name: raw.name,
          type: raw.type as FsDirEntry['type'],
          target: { targetKey: FsTargetKey(targetKey), displayPath },
          ...raw.size !== undefined ? { size: raw.size } : {},
        }
      })
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    } catch (error: unknown) {
      throw mapError(error, 'list', target.displayPath, signal)
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, true, signal)
      if (existing !== undefined && existing.type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target)
      const before = existing === undefined ? null : await this.readForDiff(target, signal)
      const version = await this.writeAtomic(
        target,
        Buffer.from(content, 'utf8'),
        existing,
        expected?.kind === 'createIfAbsent',
        signal,
      )
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const existing = await this.probe(String(target.targetKey), target.displayPath, true, signal)
      if (existing === undefined) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (existing.type !== 'file') {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && versionOf(target.displayPath, existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readForEdit(target, signal)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const storage = restoreLineEndings(after, detectsCrlf(raw))
      const version = await this.writeAtomic(target, Buffer.from(storage, 'utf8'), existing, false, signal)
      return { version, before, after }
    })
  }

  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }

  private async probe(
    path: string,
    displayPath: string,
    follow: boolean,
    signal?: AbortSignal,
  ): Promise<SshStatFacts | undefined> {
    assertNotAborted(signal, 'stat')
    try {
      const result = await this.transport.op('stat', { path, follow }, signalOpts(signal))
      assertNotAborted(signal, 'stat')
      if (result.missing === true) return undefined
      const facts: SshStatFacts = {
        type: String(result.type),
        size: Number(result.size ?? 0),
        mode: Number(result.mode ?? 0),
        mtimeMs: Number(result.mtimeMs ?? 0),
        ...result.symlinkTarget !== undefined && result.symlinkTarget !== '' ? { symlinkTarget: String(result.symlinkTarget) } : {},
      }
      return facts
    } catch (error: unknown) {
      throw mapError(error, 'stat', displayPath, signal)
    }
  }

  private async requireRegular(target: FsTarget, signal?: AbortSignal): Promise<FsInfo> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    return info
  }

  private checkWriteIntent(existing: SshStatFacts | undefined, expected: FsWriteIntent | undefined, target: FsTarget): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || versionOf(target.displayPath, existing) !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    }
  }

  private async readForDiff(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      const result = await this.transport.op('read', { path: String(target.targetKey) }, signalOpts(signal))
      assertNotAborted(signal, 'read')
      const bytes = decodeB64(String(result.data), 'read')
      return normalizeLineEndings(decodeText(bytes, target.displayPath))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  private async readForEdit(target: FsTarget, signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.transport.op('read', { path: String(target.targetKey) }, signalOpts(signal))
      assertNotAborted(signal, 'edit')
      const bytes = decodeB64(String(result.data), 'read')
      return decodeText(bytes, target.displayPath)
    } catch (error: unknown) {
      throw mapError(error, 'edit', target.displayPath, signal)
    }
  }

  private async writeAtomic(
    target: FsTarget,
    bytes: Buffer,
    existing: SshStatFacts | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof FsVersion>> {
    assertNotAborted(signal, 'write')
    try {
      await this.transport.op('write', {
        path: String(target.targetKey),
        data: bytes.toString('base64'),
        ...existing !== undefined ? { mode: (existing.mode ?? 0o600).toString(8) } : {},
        noOverwrite: createIfAbsent,
      }, signalOpts(signal))
      assertNotAborted(signal, 'write')
      const committed = await this.probe(String(target.targetKey), target.displayPath, true, signal)
      if (committed === undefined) throw new Error('write committed but the target cannot be observed')
      return versionOf(target.displayPath, committed)
    } catch (error: unknown) {
      throw mapError(error, 'write', target.displayPath, signal)
    }
  }
}

/** The version token of one remote observation: hashed stat facts. */
function versionOf(displayPath: string, facts: SshStatFacts): ReturnType<typeof FsVersion> {
  const factsJson = JSON.stringify([
    displayPath,
    facts.type,
    facts.size,
    facts.mode,
    facts.mtimeMs,
    facts.symlinkTarget,
  ])
  return FsVersion(`ssh:${createHash('sha256').update(factsJson).digest('hex')}`)
}

function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  let matches = 0
  let offset = 0
  while (true) {
    const found = content.indexOf(oldString, offset)
    if (found < 0) break
    matches += 1
    offset = found + oldString.length
  }
  if (matches === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

function mapError(error: unknown, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true) {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  if (error instanceof ExecutionError) {
    return new FsError(`cannot ${operation} "${displayPath}": ${error.message}`, 'FS_IO_ERROR', { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/permission denied|operation not permitted/i.test(message)) {
    return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  if (/not found|no such file/i.test(message)) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${message}`, 'FS_IO_ERROR', { cause: error })
}
