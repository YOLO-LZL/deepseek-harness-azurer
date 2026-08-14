/**
 * Pure parser for the OpenSSH client configuration format (`~/.ssh/config`),
 * scoped to what the SSH family needs: enumerate concrete `Host` aliases with
 * their resolved `HostName`/`User`/`Port`/`IdentityFile`. No fs or node
 * imports — unit-testable in isolation.
 *
 * Faithfulness notes:
 * - Blocks are applied in file order; per ssh semantics the first obtained
 *   value of each keyword wins, so later blocks cannot override an earlier one.
 * - Global directives (before any `Host`/`Match`) and `Host *` blocks apply to
 *   every alias; negated (`!`) patterns exclude an alias from a block.
 * - `Match` blocks are skipped entirely: they are conditional at connect time
 *   and cannot be resolved statically here.
 * - `Include` directives are ignored by this enumerator; hosts must live in
 *   the file itself.
 */

import type { SshConfigHost } from './types.ts'

/** One parsed directive block (global, Host, or Match). */
interface DirectiveBlock {
  /** `Host` patterns; undefined for the global block and Match blocks. */
  patterns?: string[]
  /** Match blocks are never applied by the enumerator. */
  match: boolean
  /** First-wins keyword → value map (keywords lowercased). */
  values: Map<string, string>
}

/** Keywords the enumerator resolves. */
const KEYWORDS = ['hostname', 'user', 'port', 'identityfile'] as const

/**
 * Join physical lines into logical lines: a line whose content ends with `\`
 * continues on the next line (the backslash and its newline are removed).
 * @param text - the raw config file content.
 * @returns logical lines with trailing whitespace trimmed.
 */
export function logicalLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let current = ''
  for (const line of lines) {
    const joined = current === '' ? line : `${current} ${line}`
    const trimmed = joined.replace(/\s+$/, '')
    if (trimmed.endsWith('\\')) {
      current = trimmed.slice(0, -1)
      continue
    }
    out.push(trimmed)
    current = ''
  }
  if (current !== '') out.push(current)
  return out
}

/**
 * Split one logical line into tokens, honoring single/double quotes and `#`
 * comments (a comment starts at the first `#` that begins a token or follows
 * whitespace; quoted `#` stays literal).
 * @param line - one logical line.
 * @returns the tokens.
 */
export function tokenizeLine(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined
      } else {
        current += ch
      }
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < line.length) {
      current += line[i + 1]
      i += 2
      continue
    }
    if (ch === '#' && (current.length === 0 || /\s/.test(line[i - 1] ?? ''))) break
    if (ch !== undefined && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

/**
 * Whether one ssh `Host` pattern matches a host or alias using `*` and `?`
 * wildcards, case-insensitively.
 * @param pattern - one OpenSSH host pattern.
 * @param host - alias or host name to test.
 * @returns whether the pattern applies to the host.
 */
export function sshPatternMatches(pattern: string, host: string): boolean {
  if (pattern === '') return false
  let regex = ''
  for (const ch of pattern) {
    if (ch === '*') regex += '.*'
    else if (ch === '?') regex += '.'
    else regex += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  try {
    return new RegExp(`^${regex}$`, 'i').test(host)
  } catch {
    return false
  }
}

/** Whether a block applies to an alias: global always; Host blocks by first matching pattern. */
function blockApplies(block: DirectiveBlock, alias: string): boolean {
  if (block.match) return false
  if (block.patterns === undefined) return true
  for (const pattern of block.patterns) {
    if (pattern.startsWith('!')) {
      if (sshPatternMatches(pattern.slice(1), alias)) return false
    } else if (sshPatternMatches(pattern, alias)) {
      return true
    }
  }
  return false
}

/**
 * Parse ssh client config text into discoverable host aliases.
 * @param text - the config file content.
 * @returns concrete aliases with their resolved values, sorted by alias.
 */
export function parseSshConfig(text: string): SshConfigHost[] {
  const blocks: DirectiveBlock[] = []
  let current: DirectiveBlock = { match: false, values: new Map() }
  blocks.push(current)

  for (const line of logicalLines(text)) {
    const tokens = tokenizeLine(line)
    const [first, ...args] = tokens
    if (first === undefined) continue
    const keyword = first.toLowerCase()
    if (keyword === 'host') {
      current = { patterns: args, match: false, values: new Map() }
      blocks.push(current)
    } else if (keyword === 'match') {
      // Conditional at connect time; never applied by the enumerator.
      current = { match: true, values: new Map() }
      blocks.push(current)
    } else if ((KEYWORDS as readonly string[]).includes(keyword)) {
      const value = args[0]
      if (value !== undefined && !current.values.has(keyword)) {
        current.values.set(keyword, value)
      }
    }
    // `include` and anything else are ignored by the enumerator.
  }

  // Enumerate concrete aliases: Host patterns without wildcards or negation.
  const aliases: string[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    if (block.match || block.patterns === undefined) continue
    for (const pattern of block.patterns) {
      const alias = pattern.trim()
      if (alias === '' || alias.startsWith('!') || /[*?[\]]/.test(alias)) continue
      if (!seen.has(alias)) {
        seen.add(alias)
        aliases.push(alias)
      }
    }
  }

  const hosts: SshConfigHost[] = []
  for (const alias of aliases) {
    const resolved: Record<string, string> = {}
    for (const block of blocks) {
      if (!blockApplies(block, alias)) continue
      for (const [key, value] of block.values) {
        if (!(key in resolved)) resolved[key] = value
      }
    }
    const hostName = resolved.hostname ?? alias
    const port = resolved.port !== undefined ? Number.parseInt(resolved.port, 10) : undefined
    hosts.push({
      alias,
      hostName,
      ...resolved.user !== undefined ? { user: resolved.user } : {},
      ...port !== undefined && Number.isInteger(port) && port >= 1 && port <= 65535 ? { port } : {},
      ...resolved.identityfile !== undefined ? { identityFile: resolved.identityfile } : {},
    })
  }
  return hosts.sort((a, b) => a.alias.localeCompare(b.alias))
}
