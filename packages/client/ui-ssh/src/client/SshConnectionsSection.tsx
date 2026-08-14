/**
 * The SSH Connections settings section body: a row editor over the
 * `ssh-connections` namespace (staged drafts, one document write on save,
 * failed saves keep the draft). The section lives under
 * Settings → SSH Connections (the product area), not the plugin page.
 */

import { useState, type CSSProperties, type ChangeEvent } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SshConnection, SshConnectionsSettings } from '../types.ts'
import { NS, type SshConnectionsLocaleKey } from './locales.ts'

/** Registration-side face: the bound scope snapshot plus the save action. */
export interface SshConnectionsSectionFace {
  hooks: {
    sshConnections: SettingsScope<SshConnectionsSettings>
  }
  actions: {
    save(connections: SshConnection[]): Promise<void>
  }
}

/** Composed props of the section (runtime seat + locale seat + injected face). */
export type SshConnectionsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<typeof NS>
  & InjectFace<SshConnectionsSectionFace>

/** String-typed connection fields edited as text inputs. */
type TextField = 'label' | 'host' | 'user' | 'keyPath'

/** One validation problem found in the draft, mapped to a cell. */
interface RowProblem {
  message: string
  row: number
  field?: TextField | 'port'
}

/* ---------------------------------------------------------------------------
 * Design tokens, mirroring the settings page chrome (--dsw-alias-* tokens).
 * ------------------------------------------------------------------------- */

const CARD: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-3)',
}

const HEADER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '14px 16px',
}

const HEAD_TEXT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const NAME: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.4,
  color: 'var(--dsw-alias-label-primary)',
}

const DESCRIPTION: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}

const PENDING: CSSProperties = {
  flex: 'none',
  borderRadius: 999,
  padding: '1px 8px',
  fontSize: 11,
  lineHeight: '17px',
  fontWeight: 500,
  whiteSpace: 'nowrap',
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'var(--dsw-alias-label-secondary)',
}

const BODY: CSSProperties = {
  borderTop: '1px solid var(--dsw-alias-border-l2)',
  margin: '0 16px',
  paddingBottom: 8,
}

const READ_ONLY: CSSProperties = {
  margin: '12px 0 0',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}

const ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) 72px minmax(0, 1fr) minmax(0, 1.4fr) 28px',
  gap: 8,
  alignItems: 'center',
  padding: '12px 0',
  borderTop: '1px solid var(--dsw-alias-border-l2)',
}

const INPUT: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  height: 34,
  padding: '0 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-3)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
}

const INPUT_INVALID: CSSProperties = {
  ...INPUT,
  borderColor: 'var(--dsw-alias-label-error)',
}

const FOOTER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '12px 0 4px',
  borderTop: '1px solid var(--dsw-alias-border-l2)',
}

const FOOTER_TEXT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-error)',
}

const GHOST_BUTTON: CSSProperties = {
  appearance: 'none',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '5px 14px',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  cursor: 'pointer',
  background: 'none',
  color: 'var(--dsw-alias-label-secondary)',
}

const PRIMARY_BUTTON: CSSProperties = {
  appearance: 'none',
  border: '1px solid transparent',
  borderRadius: 8,
  padding: '5px 14px',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  cursor: 'pointer',
  background: 'var(--dsw-alias-label-primary)',
  color: 'var(--dsw-alias-bg-layer-3)',
}

const DISABLED_BUTTON: CSSProperties = { opacity: 0.4, cursor: 'default' }

const REMOVE_BUTTON: CSSProperties = {
  ...GHOST_BUTTON,
  padding: '2px 8px',
  color: 'var(--dsw-alias-label-error)',
}

/** Trim a draft connection into the persisted shape. */
function normalize(connection: SshConnection): SshConnection {
  const user = connection.user?.trim()
  const keyPath = connection.keyPath?.trim()
  return {
    id: connection.id,
    label: connection.label.trim(),
    host: connection.host.trim(),
    ...connection.port !== undefined ? { port: connection.port } : {},
    ...user !== undefined && user.length > 0 ? { user } : {},
    ...keyPath !== undefined && keyPath.length > 0 ? { keyPath } : {},
  }
}

/** Find the first validation problem in the draft, mapped to its cell. */
function findProblem(connections: SshConnection[], t: (key: SshConnectionsLocaleKey) => string): RowProblem | null {
  const seen = new Map<string, number>()
  for (let row = 0; row < connections.length; row += 1) {
    const connection = connections[row]
    if (connection === undefined) continue
    if (connection.label.trim().length === 0) {
      return { message: t('invalidLabel'), row, field: 'label' }
    }
    const first = seen.get(connection.label.trim())
    if (first !== undefined) {
      return { message: t('duplicateLabel'), row, field: 'label' }
    }
    seen.set(connection.label.trim(), row)
    if (connection.host.trim().length === 0) {
      return { message: t('invalidHost'), row, field: 'host' }
    }
    if (connection.port !== undefined
      && (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535)) {
      return { message: t('invalidPort'), row, field: 'port' }
    }
  }
  return null
}

/** Render the settings section. */
export function SshConnectionsSection(props: SshConnectionsSectionProps) {
  const { t } = props
  const snapshot = props.useSshConnections(state => state)
  const [draft, setDraft] = useState<SshConnection[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  if (snapshot.status !== 'ready') return null

  const connections = draft ?? snapshot.value?.connections ?? []

  const writable = snapshot.writable
  const dirty = draft !== null
  const problem = findProblem(connections, t)
  const invalid = problem !== null
  const blocked = !dirty || invalid || saving
  const title = t('title')

  const updateText = (index: number, field: TextField, value: string) => {
    setDraft(connections.map((connection, i) => (
      i === index ? { ...connection, [field]: value } : connection
    )))
    setFailed(false)
  }

  const updatePort = (index: number, raw: string) => {
    const trimmed = raw.trim()
    const port = trimmed === '' ? undefined : Number(trimmed)
    setDraft(connections.map((connection, i) => (
      i === index
        ? port === undefined
          ? {
            id: connection.id,
            label: connection.label,
            host: connection.host,
            ...(connection.user !== undefined ? { user: connection.user } : {}),
            ...(connection.keyPath !== undefined ? { keyPath: connection.keyPath } : {}),
          }
          : { ...connection, port }
        : connection
    )))
    setFailed(false)
  }

  const onSave = async () => {
    if (problem !== null) return
    setSaving(true)
    setFailed(false)
    try {
      await props.actions.save(connections.map(normalize))
      setDraft(null)
    } catch {
      // A save that did not land keeps its drafts so they can be corrected.
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const onDiscard = () => {
    if (draft === null && !failed) return
    setDraft(null)
    setFailed(false)
  }

  const cellStyle = (row: number, field: TextField | 'port') =>
    problem !== null && problem.row === row && problem.field === field ? INPUT_INVALID : INPUT

  return (
    <section style={CARD} aria-label={title}>
      <div style={HEADER}>
        <span style={HEAD_TEXT}>
          <span style={NAME}>{title}</span>
          <span style={DESCRIPTION}>{t('description')}</span>
        </span>
        {dirty ? <span style={PENDING}>{t('unsaved')}</span> : null}
      </div>
      <div style={BODY}>
        {!writable ? <p style={READ_ONLY} role="status">{t('readOnly')}</p> : null}
        {connections.length === 0 && (
          <p style={{ ...READ_ONLY, marginTop: 12 }}>{t('empty')}</p>
        )}
        {connections.map((connection, index) => (
          <div key={connection.id} style={ROW}>
            <input
              style={cellStyle(index, 'label')}
              value={connection.label}
              placeholder={t('connectionLabel')}
              disabled={!writable}
              onChange={(event: ChangeEvent<HTMLInputElement>) => updateText(index, 'label', event.target.value)}
            />
            <input
              style={cellStyle(index, 'host')}
              value={connection.host}
              placeholder={t('host')}
              disabled={!writable}
              onChange={(event: ChangeEvent<HTMLInputElement>) => updateText(index, 'host', event.target.value)}
            />
            <input
              style={cellStyle(index, 'port')}
              value={connection.port === undefined ? '' : String(connection.port)}
              placeholder={t('port')}
              inputMode="numeric"
              disabled={!writable}
              onChange={(event: ChangeEvent<HTMLInputElement>) => updatePort(index, event.target.value)}
            />
            <input
              style={cellStyle(index, 'user')}
              value={connection.user ?? ''}
              placeholder={t('user')}
              disabled={!writable}
              onChange={(event: ChangeEvent<HTMLInputElement>) => updateText(index, 'user', event.target.value)}
            />
            <input
              style={cellStyle(index, 'keyPath')}
              value={connection.keyPath ?? ''}
              placeholder={t('keyPath')}
              disabled={!writable}
              onChange={(event: ChangeEvent<HTMLInputElement>) => updateText(index, 'keyPath', event.target.value)}
            />
            <button
              type="button"
              style={REMOVE_BUTTON}
              disabled={!writable}
              aria-label={t('remove')}
              onClick={() => {
                setDraft(connections.filter((_, i) => i !== index))
                setFailed(false)
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <div style={{ padding: '4px 0 8px' }}>
          <button
            type="button"
            style={{ ...GHOST_BUTTON, ...(!writable ? DISABLED_BUTTON : {}) }}
            disabled={!writable}
            onClick={() => {
              setDraft([...connections, { id: crypto.randomUUID(), label: '', host: '' }])
              setFailed(false)
            }}
          >
            {t('add')}
          </button>
        </div>
        <div style={FOOTER}>
          {failed || invalid
            ? <p style={FOOTER_TEXT} role="status">{failed ? t('saveFailed') : problem?.message}</p>
            : null}
          <button
            type="button"
            style={{ ...GHOST_BUTTON, ...(draft === null || saving ? DISABLED_BUTTON : {}) }}
            disabled={draft === null || saving}
            onClick={onDiscard}
          >
            {t('discard')}
          </button>
          <button
            type="button"
            style={{ ...PRIMARY_BUTTON, ...(blocked ? DISABLED_BUTTON : {}) }}
            disabled={blocked}
            onClick={() => { void onSave() }}
          >
            {t(saving ? 'saving' : 'save')}
          </button>
        </div>
      </div>
    </section>
  )
}
