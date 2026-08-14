/**
 * SshFileSystem tests over the fake SSH transport: resolve/stat/read/write
 * primitives, atomic writes, stale guards, error mapping, and special
 * characters.
 */

import { describe, expect, it } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { SshTransport } from '@deepseek-ai/dsh-ssh'
import { SshFileSystem } from '../src/index.ts'
import { FakeRemote, fakeSpawner } from '../../ssh/tests/helpers/fake-ssh.ts'

function harness(remote: FakeRemote) {
  const transport = new SshTransport({
    target: { host: 'fake', port: 22, connectTimeout: 5 },
    remoteStateDir: '.dsh-ssh',
    spawner: fakeSpawner(remote),
    opTimeoutMs: 2000,
  })
  const location = {
    providerId: 'ssh' as const,
    target: { kind: 'connection' as const, connectionId: 'c1' },
    root: '/home/u/w',
  }
  const fs = new SshFileSystem(location, transport, '.dsh-ssh')
  return { transport, fs, location }
}

describe('ssh filesystem', () => {
  it('resolves, stats, reads, and writes text', async () => {
    const remote = new FakeRemote()
    remote.file('/home/u/w/a.txt', 'hello')
    const { fs, transport } = harness(remote)
    const target = await fs.resolve('a.txt')
    expect(target.displayPath).toBe('/home/u/w/a.txt')
    expect(await fs.readText(target)).toBe('hello')
    const info = await fs.stat(target)
    expect(info?.type).toBe('file')

    const writeTarget = await fs.resolve('b.txt')
    const outcome = await fs.writeText(writeTarget, 'world', { kind: 'createIfAbsent' })
    expect(outcome.operation).toBe('create')
    expect(await fs.readText(await fs.resolve('b.txt'))).toBe('world')

    const edit = await fs.editText(writeTarget, { oldString: 'world', newString: 'earth', replaceAll: false })
    expect(edit.after).toBe('earth')
    expect(await fs.readText(await fs.resolve('b.txt'))).toBe('earth')
    transport.close()
  })

  it('guards writes by observed version', async () => {
    const remote = new FakeRemote()
    remote.file('/home/u/w/g.txt', 'v1')
    const { fs, transport } = harness(remote)
    const target = await fs.resolve('g.txt')
    const info = await fs.stat(target)
    await fs.writeText(target, 'v2', { kind: 'replaceIfVersion', version: info!.version })
    await expect(fs.writeText(target, 'v3', { kind: 'replaceIfVersion', version: info!.version }))
      .rejects.toThrowError(expect.objectContaining({ code: 'FS_STALE_VERSION' }))
    await expect(fs.writeText(target, 'x', { kind: 'createIfAbsent' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'FS_NOT_OBSERVED' }))
    transport.close()
  })

  it('maps missing files and binary content to typed errors', async () => {
    const remote = new FakeRemote()
    remote.file('/home/u/w/bin.dat', Buffer.from([0, 1, 2, 3]).toString())
    const { fs, transport } = harness(remote)
    const missing = await fs.resolve('missing.txt')
    await expect(fs.readText(missing)).rejects.toThrowError(expect.objectContaining({ code: 'FS_NOT_FOUND' }))
    const binary = await fs.resolve('bin.dat')
    await expect(fs.readText(binary)).rejects.toThrowError(expect.objectContaining({ code: 'FS_NOT_TEXT' }))
    transport.close()
  })

  it('lists directories with stable name order', async () => {
    const remote = new FakeRemote()
    remote.dir('/home/u/w')
    remote.file('/home/u/w/b.txt', 'b')
    remote.file('/home/u/w/a.txt', 'a')
    remote.dir('/home/u/w/sub')
    const { fs, transport } = harness(remote)
    const target = await fs.resolve('.')
    const entries = await fs.listDir(target)
    expect(entries.map(entry => entry.name)).toEqual(['a.txt', 'b.txt', 'sub'])
    expect(entries[2]!.type).toBe('directory')
    transport.close()
  })

  it('round-trips special-character paths and atomic-write staging', async () => {
    const remote = new FakeRemote()
    remote.dir('/home/u/w')
    const { fs, transport } = harness(remote)
    const target = await fs.resolve("sub dir/a'b\"c $d.txt")
    const outcome = await fs.writeText(target, 'tricky', { kind: 'createIfAbsent' })
    expect(outcome.operation).toBe('create')
    expect(await fs.readText(await fs.resolve("sub dir/a'b\"c $d.txt"))).toBe('tricky')
    transport.close()
  })

  it('rejects a world from another provider', async () => {
    const remote = new FakeRemote()
    const { fs, transport } = harness(remote)
    await expect(fs.resolve('x', { world: { providerId: 'local', target: null, root: '/' } }))
      .rejects.toThrowError(expect.objectContaining({ code: 'execution-provider-not-found' }))
    transport.close()
  })

  it('classifies remote I/O failures as FS_IO_ERROR', async () => {
    const remote = new FakeRemote()
    remote.failOp('read', 'read failed remotely')
    const { fs, transport } = harness(remote)
    remote.file('/home/u/w/x.txt', 'x')
    const target = await fs.resolve('x.txt')
    await expect(fs.readText(target)).rejects.toThrowError(expect.objectContaining({ code: 'FS_IO_ERROR' }))
    transport.close()
  })

  it('aborts reads on signal', async () => {
    const remote = new FakeRemote()
    remote.file('/home/u/w/x.txt', 'x')
    const { fs, transport } = harness(remote)
    const target = await fs.resolve('x.txt')
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(fs.readText(target, controller.signal))
      .rejects.toThrowError(expect.objectContaining({ code: 'FS_ABORTED' }))
    transport.close()
  })
})

describe('ssh filesystem error surface', () => {
  it('FsError instances carry stable codes', () => {
    const error = new FsError('cannot read: nope', 'FS_NOT_FOUND')
    expect(error.code).toBe('FS_NOT_FOUND')
  })
})
