/**
 * schemastery schema for the `ssh-connections` namespace. Field presence follows
 * schemastery semantics: object fields are optional unless `.required()`; arrays
 * and dicts default to `[]` / `{}`.
 * @module @deepseek-ai/dsh-ssh/schema
 */

import Schema from '@deepseek-ai/schemastery'
import type { SshConnection, SshConnectionsSettings } from './types.ts'

/** One connection row. `id` is stable; a record written before ids existed has none (migrated on read). */
export const SshConnectionSchema: Schema<SshConnection> = Schema.object({
  id: Schema.string().required(),
  label: Schema.string().required(),
  host: Schema.string().required(),
  port: Schema.natural().min(1).max(65535),
  user: Schema.string(),
  keyPath: Schema.string(),
})

/**
 * Compatibility reader for records written before connection ids existed.
 * The callback deliberately uses only Web-standard globals: this schema is
 * serialized to settings clients and rehydrated there for draft validation.
 */
const MigratingSshConnectionSchema = Schema.transform(
  Schema.object({
    id: Schema.string(),
    label: Schema.string().required(),
    host: Schema.string().required(),
    port: Schema.natural().min(1).max(65535),
    user: Schema.string(),
    keyPath: Schema.string(),
  }),
  connection => ({
    ...connection,
    id: typeof connection.id === 'string' && connection.id.length > 0
      ? connection.id
      : globalThis.crypto.randomUUID(),
  }) as SshConnection,
  true,
)

/** The full namespace value. */
export const SshConnectionsSettingsSchema: Schema<SshConnectionsSettings> = Schema.object({
  connections: Schema.array(MigratingSshConnectionSchema),
  workspaceDefaults: Schema.dict(Schema.string()),
})

/**
 * Cross-field constraint the schema cannot express: connection labels must be
 * unique. Registered as the namespace's `validate` hook, so a write that would
 * create a duplicate is refused at the settings layer too.
 * @param value - the schema-resolved section.
 */
export function validateConnections(value: SshConnectionsSettings): void {
  const seen = new Set<string>()
  for (const connection of value.connections) {
    if (seen.has(connection.label)) {
      throw new Error(`duplicate ssh connection label "${connection.label}"`)
    }
    seen.add(connection.label)
  }
}

export type { SshConnection, SshConnectionsSettings }
