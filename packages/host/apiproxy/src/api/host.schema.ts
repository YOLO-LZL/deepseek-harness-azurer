/**
 * host domain zod schemas (names derived from map keys).
 */

import { z } from 'zod'
import type { DirectoryEntry } from './host.ts'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

/** host.describe request payload (empty object literal). */
export const hostDescribeRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.describe'>>>

/** host.describe response value. */
export const hostDescribeValueSchema = z.object({
  version: z.string(),
  cwd: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  attachedSessions: z.number().int().nonnegative(),
  canOpenPath: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.describe'>>>

/** host.pickDirectory request payload (empty object literal). */
export const hostPickDirectoryRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.pickDirectory'>>>

/** host.pickDirectory response value; null means the user cancelled. */
export const hostPickDirectoryValueSchema = z.object({
  path: z.string().nullable(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.pickDirectory'>>>

/** Directory row shared by listing entries and breadcrumb crumbs. */
export const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  hidden: z.boolean(),
}) satisfies z.ZodType<Wire<DirectoryEntry>>

/** host.listDirectory request payload; an absent path lists the home directory. */
export const hostListDirectoryRequestSchema = z.object({
  path: z.string().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.listDirectory'>>>

/** host.listDirectory response value. */
export const hostListDirectoryValueSchema = z.object({
  path: z.string(),
  home: z.string(),
  crumbs: z.array(directoryEntrySchema),
  entries: z.array(directoryEntrySchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.listDirectory'>>>

/** host.createDirectory request payload: name must be one plain path segment. */
export const hostCreateDirectoryRequestSchema = z.object({
  path: z.string(),
  name: z.string(),
}).refine(
  payload => payload.name.trim() !== '' && payload.name !== '.' && payload.name !== '..'
    && !/[/\\]/.test(payload.name),
  { message: 'host.createDirectory requires a single non-blank path segment name' },
) satisfies z.ZodType<Wire<RequestPayload<'host.createDirectory'>>>

/** host.createDirectory response value: the created directory's absolute path. */
export const hostCreateDirectoryValueSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.createDirectory'>>>
/** host.openPath request payload. */
export const hostOpenPathRequestSchema = z.object({
  path: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'host.openPath'>>>

/** host.openPath response value. */
export const hostOpenPathValueSchema = z.object({
  opened: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'host.openPath'>>>

/** host.sshStatus request payload (empty object literal). */
export const hostSshStatusRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'host.sshStatus'>>>

/** One read-only ~/.ssh/config alias row. */
const sshConfigHostSchema = z.object({
  alias: z.string(),
  hostName: z.string(),
  user: z.string().optional(),
  port: z.number().optional(),
  identityFile: z.string().optional(),
})

/** host.sshStatus response value. */
export const hostSshStatusValueSchema = z.object({
  available: z.boolean(),
  configHosts: z.array(sshConfigHostSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'host.sshStatus'>>>

/** One ssh directory RPC's target: a saved connection id or a config alias (exactly one). */
const sshDirectoryTargetSchema = z.object({
  connectionId: z.string().optional(),
  alias: z.string().optional(),
}).refine(
  payload => (payload.connectionId === undefined) !== (payload.alias === undefined),
  { message: 'host.ssh* requires exactly one of connectionId or alias' },
)

/** host.sshListDirectory request payload. */
export const hostSshListDirectoryRequestSchema = sshDirectoryTargetSchema.extend({
  path: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.sshListDirectory'>>>

/** host.sshListDirectory response value. */
export const hostSshListDirectoryValueSchema = z.object({
  entries: z.array(z.object({
    name: z.string(),
    type: z.enum(['file', 'directory', 'other']),
    size: z.number().optional(),
  })),
}) satisfies z.ZodType<Wire<ResponseValue<'host.sshListDirectory'>>>

/** host.sshCreateDirectory request payload. */
export const hostSshCreateDirectoryRequestSchema = sshDirectoryTargetSchema.extend({
  path: z.string(),
  name: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'host.sshCreateDirectory'>>>

/** host.sshCreateDirectory response value. */
export const hostSshCreateDirectoryValueSchema = z.object({
  path: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.sshCreateDirectory'>>>

/** host.sshProbe request payload. */
export const hostSshProbeRequestSchema = sshDirectoryTargetSchema.extend({
  path: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'host.sshProbe'>>>

/** host.sshProbe response value. */
export const hostSshProbeValueSchema = z.object({
  kind: z.enum(['ok', 'missing-dir', 'unreachable', 'invalid']),
  message: z.string().optional(),
}) satisfies z.ZodType<Wire<ResponseValue<'host.sshProbe'>>>
