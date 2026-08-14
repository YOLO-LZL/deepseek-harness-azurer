import { describe, expect, it } from 'vitest'
import { SshTransport } from '../src/transport.ts'
import { SSH_HELPER_PROTOCOL_VERSION, helperFileName } from '../src/helper.ts'
import { FakeRemote, fakeSpawner } from './helpers/fake-ssh.ts'

function transport(remote: FakeRemote, opTimeoutMs = 2000): SshTransport {
  return new SshTransport({
    target: { host: 'fake', port: 22, connectTimeout: 5 },
    remoteStateDir: '.dsh-ssh',
    spawner: fakeSpawner(remote),
    opTimeoutMs,
  })
}

describe('ssh transport', () => {
  it('installs the helper with content verification', async () => {
    const remote = new FakeRemote()
    const t = transport(remote)
    await t.installHelper()
    const fileName = helperFileName()
    expect(remote.helperHashes.has(`.dsh-ssh/${fileName}`)).toBe(true)
    // Idempotent.
    await t.installHelper()
    expect(remote.spawnArgvs.filter(argv => argv.join(' ').includes('sha256sum'))).toHaveLength(1)
  })

  it('rejects a mismatched helper', async () => {
    const remote = new FakeRemote()
    remote.banner = 'dsh-ssh-helper 999'
    const t = transport(remote)
    await expect(t.op('ping', {})).rejects.toThrowError(expect.objectContaining({ code: 'ssh-helper-mismatch' }))
  })

  it('runs framed ops over the persistent channel', async () => {
    const remote = new FakeRemote()
    remote.file('/home/u/w/hello.txt', 'hello world')
    const t = transport(remote)
    const result = await t.op('read', { path: '/home/u/w/hello.txt' })
    expect(Buffer.from(String(result.data), 'base64').toString('utf8')).toBe('hello world')
    // The channel is reused for the second op.
    const spawnCount = remote.spawnArgvs.length
    const stat = await t.op('stat', { path: '/home/u/w/hello.txt', follow: false })
    expect(stat.type).toBe('file')
    expect(remote.spawnArgvs.length).toBe(spawnCount)
    t.close()
  })

  it('round-trips special-character paths without shell interpolation', async () => {
    const remote = new FakeRemote()
    const tricky = "/home/u/w/a'b\"c $d;$(touch /tmp/pwned) \\ e"
    remote.file(tricky, 'tricky content')
    const t = transport(remote)
    const result = await t.op('read', { path: tricky })
    expect(Buffer.from(String(result.data), 'base64').toString('utf8')).toBe('tricky content')
    // The fake only executes literal path keys; no interpolation may have
    // created the payload marker path.
    expect(remote.files.has('/tmp/pwned')).toBe(false)
  })

  it('reports remote op failures with the helper message', async () => {
    const remote = new FakeRemote()
    remote.failOp('read', 'read: not a regular file: /nope')
    const t = transport(remote)
    await expect(t.op('read', { path: '/nope' }))
      .rejects.toThrowError(expect.objectContaining({ code: 'ssh-protocol' }))
  })

  it('times out an op that never answers and reconnects afterwards', async () => {
    const remote = new FakeRemote()
    const t = transport(remote)
    await t.op('ping', {})
    // The fake stops answering: the next op hangs until the per-op timeout fires.
    remote.silent = true
    const deadline = Date.now() + 5000
    const op = t.op('read', { path: '/never' }, { timeoutMs: 100 })
    await expect(op).rejects.toThrowError(expect.objectContaining({ code: 'ssh-timeout' }))
    expect(Date.now()).toBeLessThan(deadline)
    // The next op reconnects and succeeds.
    remote.silent = false
    remote.file('/ok', 'fine')
    const result = await t.op('read', { path: '/ok' })
    expect(Buffer.from(String(result.data), 'base64').toString('utf8')).toBe('fine')
  })

  it('aborts an in-flight op on signal and reconnects', async () => {
    const remote = new FakeRemote()
    const t = transport(remote)
    await t.op('ping', {})
    remote.silent = true
    const controller = new AbortController()
    const op = t.op('read', { path: '/abort' }, { signal: controller.signal, timeoutMs: 10000 })
    controller.abort(new Error('cancelled'))
    await expect(op).rejects.toThrowError(/aborted/)
    remote.silent = false
    remote.file('/ok', 'fine')
    const result = await t.op('read', { path: '/ok' })
    expect(result.ok).toBe(true)
  })

  it('fails loud when the ssh client is unavailable', async () => {
    const remote = new FakeRemote()
    remote.clientAvailable = false
    const t = transport(remote)
    await expect(t.op('ping', {})).rejects.toThrowError(/ssh/)
  })

  it('rejects work after close', async () => {
    const remote = new FakeRemote()
    const t = transport(remote)
    await t.op('ping', {})
    t.close()
    await expect(t.op('ping', {})).rejects.toThrowError(/closed/)
  })

  it('exposes the protocol version', () => {
    expect(SshTransport.protocolVersion).toBe(SSH_HELPER_PROTOCOL_VERSION)
  })
})
