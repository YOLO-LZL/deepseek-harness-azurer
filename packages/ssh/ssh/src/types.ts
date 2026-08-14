/**
 * Shared types for the in-repo SSH family. Pure data contracts — no runtime
 * code, no framework imports — so host packages (transport, fs, subprocess,
 * workspace, tools) and the client half can all consume them.
 * @module @deepseek-ai/dsh-ssh/types
 */

/** One persisted SSH connection. */
export interface SshConnection {
  /**
   * Stable connection id (generated uuid). Records written before ids existed
   * are migrated on load with the label as a fallback reference; labels stay
   * display names and may be renamed.
   */
  id: string
  /** Display name; unique across the namespace. */
  label: string
  /** Remote host as [user@]host, e.g. "root@10.0.0.5", or a ~/.ssh/config alias. */
  host: string
  /** SSH port; defaults to 22. */
  port?: number
  /** Optional user override; prepended to `host` when host has no user part. */
  user?: string
  /** Absolute path to the private key; omit for ~/.ssh defaults and ssh-agent. */
  keyPath?: string
}

/** The `ssh-connections` settings namespace value (persisted via ctx.settings). */
export interface SshConnectionsSettings {
  connections: SshConnection[]
  /** workspaceId → connection id (not label — labels may be renamed). */
  workspaceDefaults: Record<string, string>
}

/** Model-facing arguments of the extended ssh_exec tool. */
export interface SshExecArgs {
  /**
   * Remote host. Required in the schema; at execute time the effective host
   * resolves as explicit host → explicit `connection` → workspace default.
   */
  host?: string
  /** Bash command(s) run on the remote host via `bash -s`. */
  command: string
  /** SSH port. Default 22. */
  port?: number
  /** Absolute path to the private key. Omit for ~/.ssh defaults and ssh-agent. */
  key_path?: string
  /** Foreground timeout in milliseconds. Default 30000. */
  timeout_ms?: number
  /** Label or id of a saved connection; its host/port/user/keyPath fill in the gaps. */
  connection?: string
}

/** Model-facing arguments of the ssh_connections tool. */
export interface SshConnectionsArgs {
  /** Which operation to run. */
  action: 'save' | 'list' | 'delete' | 'use'
  /** Connection label; required by save/delete, optional by use (omitting clears). */
  label?: string
  /** Host for save. */
  host?: string
  /** Port for save. */
  port?: number
  /** User for save. */
  user?: string
  /** Key path for save. */
  keyPath?: string
}

/**
 * One host discovered from the local `~/.ssh/config` file. Read-only: the
 * harness never persists these — ssh itself resolves the alias at run time, so
 * no manual `ssh_connections save` is needed to use them.
 */
export interface SshConfigHost {
  /** The `Host` alias as written in the config (e.g. `prod`). */
  alias: string
  /** Resolved `HostName`, or the alias itself when the block omits one. */
  hostName: string
  /** Resolved `User` from matching blocks, when set. */
  user?: string
  /** Resolved `Port` from matching blocks, when set and valid. */
  port?: number
  /** First `IdentityFile` from matching blocks, when set (path kept raw). */
  identityFile?: string
}

/** Row-level SSH family config (later patch layer overrides the defaults). */
export interface SshConfig {
  /** Foreground command timeout in milliseconds (default 30000). */
  timeoutMs?: number
  /** ssh ConnectTimeout in seconds (default 15). */
  connectTimeout?: number
  /**
   * Absolute path to the ssh client config to discover hosts from; defaults to
   * `~/.ssh/config` (resolved through os.homedir()).
   */
  sshConfigPath?: string
  /**
   * Remote directory for the installed helper script (DSH-managed state).
   * Defaults to `~/.dsh-ssh` on the remote host.
   */
  remoteStateDir?: string
}

/** The settings namespace id. */
export const SSH_CONNECTIONS_NS = 'ssh-connections'

/**
 * Stable reference form of a connection target inside an execution location.
 * `{ kind: 'connection', connectionId }` names a persisted connection;
 * `{ kind: 'config', alias }` names a read-only ~/.ssh/config alias.
 */
export type SshTargetReference =
  | { readonly kind: 'connection'; readonly connectionId: string }
  | { readonly kind: 'config'; readonly alias: string }
