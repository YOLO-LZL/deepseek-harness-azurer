/**
 * Built-in SSH UI: registers the SSH Connections settings section (a product
 * section, not a plugin card) and the SSH workspace create method behind the
 * workspace picker's "本地 / SSH" segmented control.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ctx.locale / ctx.settingsScope / settings-slot merges.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceCreateMethodSlotName } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { SshConnectionsSection } from './SshConnectionsSection.tsx'
import type { SshConnectionsSectionFace } from './SshConnectionsSection.tsx'
import { SshCreateMethod } from './SshCreateMethod.tsx'
import type { SshCreateMethodFace } from './SshCreateMethod.tsx'
import { en, zh, NS } from './locales.ts'
import type { SshConnection, SshConnectionsSettings } from '../types.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'settingsScope', 'connection', 'remote']

/**
 * Mount the settings section and the SSH create method.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-ssh: dictionaries')

  const scope = ctx.settingsScope.bind<SshConnectionsSettings>({ namespace: 'ssh-connections' })
  const save = async (connections: SshConnection[]): Promise<void> => {
    // Whole-field write: never touches workspaceDefaults.
    await scope.set('connections', connections)
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'ssh-connections',
    order: 12,
    locale: NS,
    label: () => ctx.locale.bind(NS)('nav'),
    inject: (): SshConnectionsSectionFace => ({
      hooks: { sshConnections: scope },
      actions: { save },
    }),
  }, SshConnectionsSection))

  const registerCreateMethod = (name: WorkspaceCreateMethodSlotName) => ctx.slots.register({
    name,
    id: 'ssh',
    order: 10,
    locale: NS,
    label: () => ctx.locale.bind(NS)('method.ssh'),
    inject: (): SshCreateMethodFace => {
      const connection = (ctx.get as unknown as (service: string) => ConnectionHandle | undefined)('connection')
      if (connection === undefined) {
        throw new Error('ui-ssh: the connection service is required for the SSH create method')
      }
      return {
        hooks: { sshConnections: scope },
        api: connection.api,
      }
    },
  }, SshCreateMethod)
  // The two surfaces own different child keys. Install the pair together so
  // one surface never advertises SSH while the other lacks its renderer.
  ctx.slots.inject('conversation.hero.workspace.createMethod', () =>
    ctx.slots.inject('sidebar.workspaces.createMethod', function* () {
      yield registerCreateMethod('conversation.hero.workspace.createMethod')
      yield registerCreateMethod('sidebar.workspaces.createMethod')
    }))
}
