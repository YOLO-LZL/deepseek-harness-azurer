/**
 * Host-side placeholder of the built-in SSH UI package. All functionality
 * lives in the browser half (`./client`); the node entry exists so the
 * package loads as a loader row.
 * @module @deepseek-ai/dsh-client-ui-ssh
 */

export const name = 'ui-ssh'

export const inject: string[] = []

/** No host-side behavior; the browser half registers the settings section and create method. */
export function apply(): void {}
