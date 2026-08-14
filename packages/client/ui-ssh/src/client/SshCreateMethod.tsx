/**
 * The SSH workspace create method: connection / config-alias selection,
 * remote path input with in-app directory browsing (breadcrumbs + new
 * folder), live probing, and submit. Rendered by the workspace picker behind
 * the "本地 / SSH" segmented control.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceCreateInput } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceCreateMethodSlotName } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type { SshConnection, SshConnectionsSettings } from '../types.ts'
import { NS } from './locales.ts'

/** One ssh directory RPC target: a saved connection id or a config alias. */
type SshTarget = { connectionId: string } | { alias: string }

/** Registration-side face of the create method. */
export interface SshCreateMethodFace {
  hooks: {
    sshConnections: SettingsScope<SshConnectionsSettings>
  }
  /** The wire client (Host RPCs for status/browse/probe/create). */
  api: IApiClient
}

/** Composed props of the create method. */
export type SshCreateMethodProps =
  PropsRuntime<WorkspaceCreateMethodSlotName>
  & PropsLocale<typeof NS>
  & InjectFace<SshCreateMethodFace>

interface SshStatus {
  available: boolean
  configAliases: { alias: string; hostName: string }[]
}

const ROW: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 12px',
  minWidth: 320,
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-layer-3)',
}

const LABEL: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary)',
}

const INPUT: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  height: 32,
  padding: '0 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-3)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
}

const SELECT: CSSProperties = { ...INPUT, cursor: 'pointer' }

const BUTTON: CSSProperties = {
  appearance: 'none',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '4px 10px',
  font: 'inherit',
  fontSize: 12,
  lineHeight: 1.5,
  cursor: 'pointer',
  background: 'none',
  color: 'var(--dsw-alias-label-secondary)',
}

const PRIMARY: CSSProperties = {
  ...BUTTON,
  borderColor: 'transparent',
  background: 'var(--dsw-alias-label-primary)',
  color: 'var(--dsw-alias-bg-layer-3)',
}

const DISABLED: CSSProperties = { opacity: 0.4, cursor: 'default' }

const STATUS: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}

const CRUMBS: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 4,
  fontSize: 12,
}

const CRUMB: CSSProperties = {
  appearance: 'none',
  border: 0,
  background: 'none',
  font: 'inherit',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
  padding: 0,
}

const ENTRIES: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  maxHeight: 180,
  overflowY: 'auto',
  gap: 2,
}

const ENTRY: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 8px',
  borderRadius: 6,
  border: 0,
  background: 'none',
  font: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-primary)',
  textAlign: 'left',
}

const NEW_FOLDER_ROW: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center' }

/** Render the SSH create method. */
export function SshCreateMethod(props: SshCreateMethodProps) {
  const { t, open, busy, onPicked, onCancel, api } = props
  const snapshot = props.useSshConnections(state => state)
  const [status, setStatus] = useState<SshStatus>({ available: true, configAliases: [] })
  const [target, setTarget] = useState<SshTarget | undefined>(undefined)
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<{ name: string; type: string }[] | undefined>(undefined)
  const [crumbs, setCrumbs] = useState<string[]>([])
  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<string | null>(null)
  const [folderName, setFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [listedPath, setListedPath] = useState<string | null>(null)
  const listingRef = useRef(0)

  const connections = snapshot.status === 'ready' ? snapshot.value?.connections ?? [] : []
  const ready = snapshot.status === 'ready'

  // Capability probe + alias discovery, once per open.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void api.host.sshStatus({}).then((response) => {
      if (cancelled || !response.result.ok) return
      setStatus({
        available: response.result.value.available,
        configAliases: response.result.value.configHosts.map(host => ({
          alias: host.alias,
          hostName: host.hostName,
        })),
      })
    })
    return () => { cancelled = true }
  }, [open, api])

  const selectTarget = (value: string): void => {
    setTarget(value.startsWith('config:')
      ? { alias: value.slice('config:'.length) }
      : { connectionId: value })
    setProbe(null)
    setEntries(undefined)
    setCrumbs([])
    setListedPath(null)
  }

  const listPath = useCallback((remotePath: string): void => {
    if (target === undefined) return
    const requestId = ++listingRef.current
    setError(null)
    void api.host.sshListDirectory({ ...target, path: remotePath }).then((response) => {
      if (requestId !== listingRef.current) return
      if (!response.result.ok) {
        setError(response.result.error.message)
        setEntries(undefined)
        return
      }
      setEntries(response.result.value.entries)
      setListedPath(remotePath)
    })
  }, [target, api])

  const openPath = (remotePath: string): void => {
    setPath(remotePath)
    setCrumbs(remotePath.split('/').filter(Boolean))
    listPath(remotePath)
  }

  const jumpCrumb = (index: number): void => {
    const parts = path.split('/').filter(Boolean)
    const remotePath = `/${parts.slice(0, index + 1).join('/')}`
    openPath(remotePath)
  }

  const createFolder = (): void => {
    if (target === undefined || listedPath === null || folderName.trim() === '') return
    setCreatingFolder(true)
    setError(null)
    void api.host.sshCreateDirectory({ ...target, path: listedPath, name: folderName.trim() }).then((response) => {
      setCreatingFolder(false)
      if (!response.result.ok) {
        setError(response.result.error.message)
        return
      }
      setFolderName('')
      listPath(listedPath)
    })
  }

  const runProbe = (): void => {
    if (target === undefined || path.trim() === '') return
    setProbing(true)
    setProbe(null)
    void api.host.sshProbe({ ...target, path: path.trim() }).then((response) => {
      setProbing(false)
      if (!response.result.ok) {
        setProbe(response.result.error.message)
        return
      }
      const value = response.result.value
      setProbe(value.kind === 'ok'
        ? t('method.probeOk')
        : value.message ?? value.kind)
    })
  }

  const submit = (): void => {
    if (target === undefined) {
      setError(t('method.connectionRequired'))
      return
    }
    const remotePath = path.trim()
    if (remotePath === '') {
      setError(t('method.pathRequired'))
      return
    }
    setError(null)
    const input: WorkspaceCreateInput = {
      kind: 'provider',
      providerId: 'ssh',
      target,
      path: remotePath,
    }
    onPicked(input)
  }

  if (!open) return null

  const targetLabel = (connection: SshConnection): string => connection.label
  const configLabel = (alias: string, hostName: string): string => `${alias} (${hostName})`

  return (
    <div style={ROW} role="tabpanel">
      <label style={LABEL}>
        {t('method.connection')}
        <select
          style={SELECT}
          value={target === undefined
            ? ''
            : 'alias' in target
              ? `config:${target.alias}`
              : target.connectionId}
          disabled={!ready || busy}
          onChange={(event) => { selectTarget(event.target.value) }}
        >
          <option value="">{t('method.connectionPlaceholder')}</option>
          {connections.map(connection => (
            <option key={connection.id} value={connection.id}>{targetLabel(connection)}</option>
          ))}
          {status.configAliases.map(host => (
            <option key={`config:${host.alias}`} value={`config:${host.alias}`}>{configLabel(host.alias, host.hostName)}</option>
          ))}
        </select>
      </label>

      {ready && connections.length === 0 && status.configAliases.length === 0 && !busy && (
        <p style={STATUS} role="status">{t('method.noConnections')}</p>
      )}
      {!status.available && (
        <p style={STATUS} role="status">{t('method.sshUnavailable')}</p>
      )}

      <label style={LABEL}>
        {t('method.path')}
        <div style={NEW_FOLDER_ROW}>
          <input
            style={INPUT}
            value={path}
            placeholder={t('method.pathPlaceholder')}
            disabled={target === undefined || busy}
            onChange={(event) => { setPath(event.target.value); setProbe(null) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') runProbe()
            }}
          />
          <button
            type="button"
            style={BUTTON}
            disabled={target === undefined || busy}
            onClick={runProbe}
          >
            {probing ? t('method.probing') : t('method.probe')}
          </button>
        </div>
      </label>

      {probe !== null && <p style={STATUS} role="status">{probe}</p>}

      {target !== undefined && (
        <div>
          {crumbs.length > 0 && (
            <div style={CRUMBS}>
              <button type="button" style={CRUMB} onClick={() => { openPath('/') }}>{t('method.breadcrumbHome')}</button>
              {crumbs.map((crumb, index) => (
                <span key={`${crumb}-${index}`}>
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>/</span>
                  <button type="button" style={CRUMB} onClick={() => { jumpCrumb(index) }}>{crumb}</button>
                </span>
              ))}
            </div>
          )}
          <div style={NEW_FOLDER_ROW}>
            <input
              style={INPUT}
              value={folderName}
              placeholder={t('method.newFolderPlaceholder')}
              disabled={busy || creatingFolder || listedPath === null}
              onChange={(event) => { setFolderName(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') createFolder()
              }}
            />
            <button
              type="button"
              style={BUTTON}
              disabled={busy || creatingFolder || listedPath === null || folderName.trim() === ''}
              onClick={createFolder}
            >
              {t('method.newFolder')}
            </button>
          </div>
          <div style={ENTRIES} role="list">
            {entries === undefined
              ? <p style={STATUS}>{t('method.emptyDir')}</p>
              : entries.length === 0
                ? <p style={STATUS}>{t('method.emptyDir')}</p>
                : entries.map(entry => (
                  <button
                    key={entry.name}
                    type="button"
                    style={ENTRY}
                    role="listitem"
                    disabled={entry.type !== 'directory'}
                    onClick={() => {
                      const base = listedPath === null ? path : listedPath
                      openPath(`${base.replace(/\/+$/, '')}/${entry.name}`)
                    }}
                  >
                    {entry.type === 'directory' ? '📁' : '📄'} {entry.name}
                  </button>
                ))}
          </div>
        </div>
      )}

      {error !== null && <p style={{ ...STATUS, color: 'var(--dsw-alias-label-error)' }} role="alert">{error}</p>}

      <div style={NEW_FOLDER_ROW}>
        <button type="button" style={BUTTON} onClick={onCancel} disabled={busy}>
          {t('method.cancel')}
        </button>
        <button
          type="button"
          style={{ ...PRIMARY, ...(busy || target === undefined || path.trim() === '' ? DISABLED : {}) }}
          disabled={busy || target === undefined || path.trim() === ''}
          onClick={submit}
        >
          {busy ? t('method.creating') : t('method.create')}
        </button>
      </div>
    </div>
  )
}
