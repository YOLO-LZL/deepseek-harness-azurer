/**
 * Shared wire/entity types for the built-in SSH UI. Mirror of the host-side
 * connection record (stable id + renameable label) kept client-importable
 * without host-package dependencies.
 */

/** One persisted SSH connection (wire projection of the settings namespace row). */
export interface SshConnection {
  /** Stable connection id (labels may be renamed). */
  id: string
  /** Display name; unique across the namespace. */
  label: string
  /** Remote host as [user@]host, or a ~/.ssh/config alias. */
  host: string
  /** SSH port; defaults to 22. */
  port?: number
  /** Optional user override. */
  user?: string
  /** Absolute path to the private key. */
  keyPath?: string
}

/** The `ssh-connections` settings namespace value. */
export interface SshConnectionsSettings {
  connections: SshConnection[]
  /** workspaceId → connection id. */
  workspaceDefaults: Record<string, string>
}
