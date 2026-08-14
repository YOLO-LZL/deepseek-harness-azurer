/**
 * Zod schema for the JSON-persistable execution location at the workspace
 * durable boundary. The shape mirrors `@deepseek-ai/dsh-execution-world`'s
 * `ExecutionLocation`; the schema lives here so the durable boundary validates
 * locations without importing the registry package's runtime.
 * @module @deepseek-ai/dsh-workspace/src/location
 */

import { z } from 'zod'
import type { ExecutionJsonValue, ExecutionLocation } from '@deepseek-ai/dsh-execution-world'

/** Recursive lossless-JSON validator for the location target reference. */
const jsonValueSchema: z.ZodType<ExecutionJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]))

/**
 * Durable shape of one execution location. `target` is opaque JSON — only the
 * named provider interprets it. Old records lacking `location` are interpreted
 * as the local world at `path` by the registry (see `locationOfRecord`).
 */
export const executionLocationSchema: z.ZodType<ExecutionLocation> = z.object({
  providerId: z.string(),
  target: jsonValueSchema,
  root: z.string(),
  display: z.object({
    label: z.string().optional(),
    host: z.string().optional(),
  }).optional(),
})

/**
 * The canonical location of one stored record: the persisted location when
 * present, else the local world at `path` (the pre-location format).
 * @param record - a workspace record snapshot (structural; only `path` and
 *   `location` are read).
 * @returns the record's execution location.
 */
export function locationOfRecord(record: {
  readonly path: string
  readonly location?: ExecutionLocation | undefined
}): ExecutionLocation {
  return record.location ?? { providerId: 'local', target: null, root: record.path }
}
