// @vitest-environment jsdom
/** SSH Connections settings section lifecycle coverage. */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import {
  createSnapshotStore, type SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SshConnectionsSettings } from '../src/types.ts'
import { SshConnectionsSection } from '../src/client/SshConnectionsSection.tsx'
import type { SshConnectionsSectionProps } from '../src/client/SshConnectionsSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const LOADING: SettingsScopeSnapshot<SshConnectionsSettings> = {
  status: 'loading',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'host',
}

/** Build the Host snapshot after the SSH namespace has loaded. */
function ready(connections: SshConnectionsSettings['connections'] = []): SettingsScopeSnapshot<SshConnectionsSettings> {
  return {
    status: 'ready',
    value: { connections, workspaceDefaults: {} },
    base: { connections: [], workspaceDefaults: {} },
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
  }
}

/** Mount over a live settings scope, as the slot renderer does. */
function mount(snapshot = LOADING) {
  const scope = createSnapshotStore(snapshot)
  const props = {
    useSshConnections: bindSnapshotSelector(scope),
    actions: { save: vi.fn(async () => {}) },
    t: (key: keyof typeof en) => en[key],
  } as unknown as SshConnectionsSectionProps
  render(<SshConnectionsSection {...props} />)
  return { scope }
}

describe('SshConnectionsSection', () => {
  it('renders the empty-state editor when the settings scope becomes ready', () => {
    const { scope } = mount()
    expect(screen.queryByRole('region', { name: en.title })).toBeNull()

    act(() => { scope.set(ready()) })

    expect(screen.getByRole('region', { name: en.title })).toBeTruthy()
    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByText(en.unsaved)).toBeNull()
  })
})
