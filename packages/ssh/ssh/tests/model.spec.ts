/**
 * Unit tests for the pure host-side model logic: validation, host resolution
 * priority, command construction, connection mutations (with stable ids), and
 * rendering. Migrated from the external dsh-ssh-plugin.
 */

import { describe, expect, it } from 'vitest'
import {
  applyConnectionsAction,
  buildSshCommand,
  composeConnectionsResult,
  migrateConnectionsSettings,
  renderConnectionsResult,
  renderResult,
  resolveConfig,
  resolveTarget,
  validateExecArgs,
} from '../src/model.ts'
import type { SshConnectionsSettings } from '../src/types.ts'

const EMPTY: SshConnectionsSettings = { connections: [], workspaceDefaults: {} }

const CONNECTION = { id: 'conn-1', label: 'prod', host: '10.0.0.5', port: 2222, user: 'deploy', keyPath: 'C:\\keys\\prod' }

const SETTINGS: SshConnectionsSettings = {
  connections: [
    CONNECTION,
    { id: 'conn-2', label: 'staging', host: 'staging.example.com' },
  ],
  workspaceDefaults: { 'ws-1': 'conn-1' },
}

describe('validateExecArgs', () => {
  it('rejects an empty command', () => {
    expect(() => validateExecArgs({ command: '  ' })).toThrow(/invalid command/)
  })

  it('rejects an out-of-range or non-integer port', () => {
    expect(() => validateExecArgs({ command: 'ls', port: 0 })).toThrow(/invalid port/)
    expect(() => validateExecArgs({ command: 'ls', port: 70000 })).toThrow(/invalid port/)
    expect(() => validateExecArgs({ command: 'ls', port: 22.5 })).toThrow(/invalid port/)
  })

  it('rejects a non-positive timeout', () => {
    expect(() => validateExecArgs({ command: 'ls', timeout_ms: 0 })).toThrow(/invalid timeout_ms/)
  })

  it('rejects a relative key_path', () => {
    expect(() => validateExecArgs({ command: 'ls', key_path: 'keys/prod' })).toThrow(/invalid key_path/)
  })
})

describe('resolveTarget priority (host > connection > workspace default)', () => {
  it('prefers an explicit host', () => {
    const target = resolveTarget({ host: 'root@other', connection: 'prod' }, SETTINGS, 'conn-1')
    expect(target).toMatchObject({ host: 'root@other', source: 'explicit' })
  })

  it('resolves a connection by label or id', () => {
    expect(resolveTarget({ connection: 'staging' }, SETTINGS, 'conn-1'))
      .toMatchObject({ host: 'staging.example.com', source: 'connection' })
    expect(resolveTarget({ connection: 'conn-2' }, SETTINGS, 'conn-1'))
      .toMatchObject({ host: 'staging.example.com', source: 'connection' })
  })

  it('falls back to the workspace default by id', () => {
    expect(resolveTarget({}, SETTINGS, 'conn-1'))
      .toMatchObject({ host: '10.0.0.5', port: 2222, user: 'deploy', keyPath: 'C:\\keys\\prod', source: 'workspace-default' })
  })

  it('rejects an unknown connection with the available labels', () => {
    expect(() => resolveTarget({ connection: 'missing' }, SETTINGS, 'conn-1'))
      .toThrow(/unknown ssh connection "missing".*prod, staging/)
  })

  it('rejects when nothing resolves', () => {
    expect(() => resolveTarget({}, SETTINGS, undefined)).toThrow(/invalid host/)
    expect(() => resolveTarget({}, EMPTY, undefined)).toThrow(/invalid host/)
  })
})

describe('migrateConnectionsSettings', () => {
  it('assigns stable ids and rewrites label-keyed workspace defaults', () => {
    const legacy: SshConnectionsSettings = {
      connections: [
        { label: 'prod', host: '10.0.0.5' } as never,
        { label: 'staging', host: 'staging.example.com' } as never,
      ],
      workspaceDefaults: { 'ws-1': 'prod', 'ws-2': 'gone' },
    }
    const migrated = migrateConnectionsSettings(legacy)
    expect(migrated.connections).toHaveLength(2)
    expect(migrated.connections[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(migrated.workspaceDefaults['ws-1']).toBe(migrated.connections[0]!.id)
    expect(migrated.workspaceDefaults['ws-2']).toBeUndefined()
  })

  it('is idempotent for already-migrated values', () => {
    const migrated = migrateConnectionsSettings(SETTINGS)
    expect(migrated).toEqual(SETTINGS)
  })
})

describe('applyConnectionsAction', () => {
  it('saves with a fresh id and rejects duplicate labels', () => {
    const mutation = applyConnectionsAction(EMPTY, { action: 'save', label: 'new', host: 'h' }, undefined)
    expect(mutation.next.connections[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(() => applyConnectionsAction(SETTINGS, { action: 'save', label: 'prod', host: 'x' }, undefined))
      .toThrow(/already exists/)
  })

  it('deletes by label or id and drops workspace defaults pointing at it', () => {
    const mutation = applyConnectionsAction(SETTINGS, { action: 'delete', label: 'conn-1' }, undefined)
    expect(mutation.next.connections.map(c => c.label)).toEqual(['staging'])
    expect(mutation.next.workspaceDefaults).toEqual({})
  })

  it('binds a workspace default by id', () => {
    const mutation = applyConnectionsAction(SETTINGS, { action: 'use', label: 'staging' }, 'ws-9')
    expect(mutation.next.workspaceDefaults['ws-9']).toBe('conn-2')
  })
})

describe('buildSshCommand', () => {
  it('does not override host-key policy (BatchMode only)', () => {
    const command = buildSshCommand({}, { host: 'h', source: 'explicit' }, { connectTimeout: 15 })
    expect(command).toContain('BatchMode=yes')
    expect(command).not.toContain('StrictHostKeyChecking')
    expect(command).toContain('ConnectTimeout=15')
  })

  it('includes the key path and port when resolved', () => {
    const command = buildSshCommand({}, {
      host: '10.0.0.5', port: 2222, keyPath: 'C:\\keys\\prod', source: 'connection',
    }, { connectTimeout: 15 })
    expect(command).toContain('C:\\keys\\prod')
    expect(command).toContain('2222')
  })
})

describe('renderResult', () => {
  it('renders exit markers and truncated output', () => {
    const text = renderResult({
      exitCode: 2, signal: null, timedOut: false, timeoutMs: 30000,
      stdout: { text: 'out', truncated: true, spillPath: '/tmp/spill' },
      stderr: { text: '', truncated: false },
    })
    expect(text).toContain('[output truncated; full output: /tmp/spill]')
    expect(text).toContain('[exit code: 2]')
  })
})

describe('resolveConfig', () => {
  it('applies defaults', () => {
    expect(resolveConfig()).toEqual({ timeoutMs: 30000, connectTimeout: 15, remoteStateDir: '.dsh-ssh' })
    expect(resolveConfig({ timeoutMs: 0, connectTimeout: -1, remoteStateDir: 'x' }))
      .toEqual({ timeoutMs: 30000, connectTimeout: 15, remoteStateDir: 'x' })
  })
})

describe('composeConnectionsResult', () => {
  it('reports the bound label for use actions', () => {
    const mutation = applyConnectionsAction(SETTINGS, { action: 'use', label: 'staging' }, 'ws-9')
    const result = composeConnectionsResult({ action: 'use', label: 'staging' }, mutation, 'ws-9')
    expect(result.defaultLabel).toBe('staging')
    expect(result.workspaceId).toBe('ws-9')
    expect(renderConnectionsResult(result)).toContain('workspace default: staging')
  })
})
