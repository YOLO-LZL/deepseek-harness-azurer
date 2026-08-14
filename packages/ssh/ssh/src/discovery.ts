/**
 * Host-side ssh config discovery: reads the local OpenSSH client config
 * (`~/.ssh/config`) and parses it into discoverable host aliases. Best-effort
 * by design — a missing or unreadable config yields an empty discovery, never
 * a harness failure. The harness process reads the file directly (no shell
 * round-trip, no sandbox policy involved).
 * @module @deepseek-ai/dsh-ssh/discovery
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseSshConfig } from './config.ts'
import type { SshConfigHost } from './types.ts'

/**
 * Resolve the config path: an explicit override, else `~/.ssh/config` through
 * os.homedir() (covers `%USERPROFILE%\.ssh\config` on Windows OpenSSH too).
 * @param override - config `sshConfigPath`, when set.
 * @returns the absolute path to read.
 */
export function resolveSshConfigPath(override?: string): string {
  return override ?? join(homedir(), '.ssh', 'config')
}

/**
 * Read the ssh client config content, or `undefined` when it is absent or
 * unreadable. Discovery is non-critical: every read error is treated as
 * "no config", so a broken override cannot take the harness down.
 * @param override - config `sshConfigPath`, when set.
 * @returns the file content, or `undefined`.
 */
export async function readSshConfig(override?: string): Promise<string | undefined> {
  try {
    return await readFile(resolveSshConfigPath(override), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Discover host aliases from the local ssh config.
 * @param override - config `sshConfigPath`, when set.
 * @returns sorted discovered hosts; empty when the config is absent/unreadable
 *   or contains no concrete `Host` aliases.
 */
export async function discoverSshConfigHosts(override?: string): Promise<SshConfigHost[]> {
  const text = await readSshConfig(override)
  return text === undefined ? [] : parseSshConfig(text)
}
