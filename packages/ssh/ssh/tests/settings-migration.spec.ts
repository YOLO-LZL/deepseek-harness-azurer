/** SSH connection settings migration coverage across the Host and wire schema. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SshRuntime from '../src/index.ts'
import { SshConnectionsSettingsSchema } from '../src/schema.ts'
import type { SshConnectionsSettings } from '../src/types.ts'

/** Minimal durable settings provider used to observe the SSH migration write. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options: { doc: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(options.doc)
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** A pre-id `ssh-connections` section from an existing user settings file. */
function legacySettings(): Record<string, unknown> {
  return {
    connections: [{ label: 'txpc', host: '115.159.113.54', port: 22, user: 'root' }],
    workspaceDefaults: { 'workspace-1': 'txpc' },
  }
}

describe('SSH settings migration', () => {
  it('accepts legacy records in both Host and rehydrated wire schemas', () => {
    const hostValue = SshConnectionsSettingsSchema(structuredClone(legacySettings()) as unknown as SshConnectionsSettings)
    const wire = JSON.parse(JSON.stringify(SshConnectionsSettingsSchema.toJSON())) as Schema
    const clientSchema = new Schema(wire)
    const clientValue = clientSchema(structuredClone(legacySettings())) as SshConnectionsSettings

    for (const value of [hostValue, clientValue]) {
      expect(value.connections[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(value.connections[0]).toMatchObject({ label: 'txpc', host: '115.159.113.54' })
    }
  })

  it('persists generated ids and rewrites label-keyed defaults after registration', async () => {
    ctx = new Context()
    await ctx.plugin(MemorySettings, { doc: { 'ssh-connections': legacySettings() } })
    const settings = ctx.get('settings') as MemorySettings

    await ctx.plugin(SshRuntime)

    await vi.waitFor(() => {
      const section = settings.doc['ssh-connections'] as SshConnectionsSettings
      const id = section.connections[0]?.id
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
      expect(section.workspaceDefaults['workspace-1']).toBe(id)
    })
  })
})
