/**
 * Workspace pick/add flow. WorkspacePickFlow is the reusable core (menu +
 * method segmented control + path error dialog) consumed directly by
 * WorkspaceBrowser (same package) and wrapped by WorkspacePicker for the
 * conversation empty-state slot registration. Directory picking itself lives
 * in the composed flow package's slot occupant (see the contract module doc):
 * this core only opens the flow, adopts the picked input, and owns the error
 * surface. Adding a workspace has one route — pick a location, new or
 * existing — with the built-in LOCAL method rendering the directory-flow
 * occupant and every registered surface-local create-method entry (the SSH
 * method) rendered behind a segmented control.
 */
import type { ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useState } from 'react'
import {
  Button, IconFolderClose16, IconPlusOutline16, Menu, Modal, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceCreateInput, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps, WorkspaceCreateMethodOwnerProps, WorkspacePickerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'

const ADD_WORKSPACE = '::add-workspace'

/** Core flow props: the owner supplies popover control and pick semantics. */
export interface WorkspacePickFlowProps {
  /** The standard locale seat, forwarded by whichever slot entry hosts the flow. */
  t: WorkspacePickerProps['t']
  /** Popover visibility (anchor button toggle state, owner-local). */
  open: boolean
  /** The anchor button element — the popover's placement anchor. */
  anchorRef?: RefObject<HTMLElement | null> | undefined
  /** Selector hook over the workspace list (framework standard hook). */
  useWorkspaces: <S>(selector: (state: WorkspaceListState) => S) => S
  /** Adopt a picked location (local path or provider target) as a real Workspace. */
  createWorkspace: (input: WorkspaceCreateInput) => Promise<WorkspaceView>
  /** Bound occupancy selector hook for this surface's directory-flow hole (empty leaves the surface with no add action). */
  useDirectoryFlow: SnapshotSelectorHook<boolean>
  /** Render this surface's directory-flow hole with the owner conversation (the entry's narrowed renderSlot). */
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
  /** Bound occupancy selector hook for the registered create methods (beyond the built-in local flow). */
  useCreateMethods: SnapshotSelectorHook<readonly { id: string; label: string }[]>
  /** Render one registered create method with the owner conversation. */
  renderCreateMethod: (id: string, owner: WorkspaceCreateMethodOwnerProps) => ReactNode
  /** A real Workspace was picked or created. */
  onPick: (workspaceId: WorkspaceId) => void
  /** Close the popover (outside click / Escape / post-pick). */
  onClose: () => void
  /** Only offer the add action, hide existing workspaces. */
  addOnly?: boolean
  /** Menu opening direction relative to the anchor. */
  side?: 'bottom' | 'top' | 'right'
  /** Currently active workspace (trailing check in the picker list). */
  selectedId?: WorkspaceId | undefined
}

/**
 * Render the pick menu plus the method segmented control and the adoption
 * error dialog.
 * @param props - owner-controlled flow props.
 * @returns menu + dialog elements.
 */
export function WorkspacePickFlow({
  t,
  open,
  anchorRef,
  useWorkspaces,
  createWorkspace,
  useDirectoryFlow,
  renderDirectoryFlow,
  useCreateMethods,
  renderCreateMethod,
  onPick,
  onClose,
  addOnly = false,
  side = 'bottom',
  selectedId,
}: WorkspacePickFlowProps) {
  const workspaceSnapshot = useWorkspaces(state => state)
  const workspaces = workspaceSnapshot.items
  const getAnchorRect = useCallback(
    () => anchorRef?.current?.getBoundingClientRect() ?? null,
    [anchorRef],
  )
  const [errorOpen, setErrorOpen] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const [flowOpen, setFlowOpen] = useState(false)
  const [pickingFolder, setPickingFolder] = useState(false)
  const [method, setMethod] = useState<'local' | string>('local')
  // One picking interaction at a time: while the flow is open (native chooser
  // pending, browse dialog up) or its pick is being adopted, every other
  // menu action stays disabled — a late outcome must not race a concurrent
  // selection or adoption.
  const flowBusy = flowOpen || pickingFolder

  // The occupied hole gates the picking affordance: with no composed flow the
  // entry simply is not there (the seam's documented no-flow default). The
  // framework-bound hook keeps occupancy live: flow plugins activate (and
  // HMR-reload) independently of this menu's renders.
  const flowAvailable = useDirectoryFlow(occupied => occupied)
  // Extra create methods (SSH) ride the same occupancy currency.
  const createMethodEntries = useCreateMethods(entries => entries)
  // An unloaded selected method cannot answer or cancel the outstanding
  // request. Switch to another available method, or withdraw the flow.
  useEffect(() => {
    if (!flowOpen) return
    const selectedAvailable = method === 'local'
      ? flowAvailable
      : createMethodEntries.some(entry => entry.id === method)
    if (selectedAvailable) return
    const next = flowAvailable ? 'local' : createMethodEntries[0]?.id
    if (next === undefined) setFlowOpen(false)
    else setMethod(next)
  }, [flowOpen, flowAvailable, createMethodEntries, method])
  const addEntries: MenuEntry[] = flowAvailable || createMethodEntries.length > 0
    ? [{ id: ADD_WORKSPACE, label: t('menu.addWorkspace'), icon: <IconPlusOutline16 size={16} />, disabled: flowBusy }]
    : []
  // With workspaces listed, the add action pins below the scroll region
  // (divider + always visible); otherwise it IS the menu.
  const pinAdd = !addOnly && workspaces.length > 0
  const items: MenuEntry[] = pinAdd
    ? workspaces.map(workspace => ({
      id: workspace.workspaceId,
      label: workspace.title,
      icon: <IconFolderClose16 size={16} />,
      disabled: flowBusy,
    }))
    : addEntries
  // Nothing listed and nothing to add with (a composition that mounts this
  // package without any directory-picker or create method): an empty popover
  // would claim a choice that does not exist, so the anchor gesture shows
  // nothing at all.
  const menuIsEmpty = items.length === 0

  const closeModal = (): void => {
    setErrorOpen(false)
    setModalError(null)
  }

  /** Adopt a picked input; failures land in the folder-error dialog (Choose again reopens the flow). */
  const adoptInput = (input: WorkspaceCreateInput): Promise<void> =>
    createWorkspace(input).then((workspace) => {
      setFlowOpen(false)
      onPick(workspace.workspaceId)
    }).catch((reason: unknown) => {
      setModalError(reason instanceof Error ? reason.message : String(reason))
      setFlowOpen(false)
      setErrorOpen(true)
    })

  const openDirectoryFlow = useCallback((): void => {
    onClose()
    setErrorOpen(false)
    setModalError(null)
    setMethod(flowAvailable ? 'local' : createMethodEntries[0]?.id ?? 'local')
    setFlowOpen(true)
  }, [onClose, flowAvailable, createMethodEntries])

  // A menu exists to disambiguate between targets. With no workspaces listed
  // and the add action the only entry left, the anchor gesture IS that action:
  // a one-row popover would cost a click and offer nothing to choose between.
  // The owner's open request is consumed the same way selecting the entry
  // would consume it (close the popover, raise the flow). An empty list is
  // only final once the baseline lands — until then the menu stays up with its
  // loading status instead of jumping into a flow the arriving list would have
  // made unnecessary; the add-only surface lists nothing and never waits.
  const listSettled = addOnly || workspaceSnapshot.phase === 'ready'
  const addIsTheOnlyEntry = !pinAdd && listSettled && addEntries.length === 1
  // `flowBusy` gates this exactly as it disables the equivalent menu entry: a
  // pick still being adopted owns the surface until it settles.
  useEffect(() => {
    if (open && addIsTheOnlyEntry && !flowBusy) openDirectoryFlow()
  }, [open, addIsTheOnlyEntry, flowBusy, openDirectoryFlow])

  /** Owner side of the flow conversation: adopt keeps the flow open (busy) until the Host answers. */
  const flowOwner: DirectoryFlowOwnerProps = {
    open: flowOpen && method === 'local',
    busy: pickingFolder,
    onPicked: (path) => {
      setPickingFolder(true)
      void adoptInput({ kind: 'local', path }).finally(() => { setPickingFolder(false) })
    },
    onCancel: () => { setFlowOpen(false) },
    onError: (message) => {
      setFlowOpen(false)
      setModalError(message)
      setErrorOpen(true)
    },
  }

  /** Owner side of one registered create-method conversation (e.g. SSH). */
  const methodOwner = (id: string): WorkspaceCreateMethodOwnerProps => ({
    open: flowOpen && method === id,
    busy: pickingFolder,
    onPicked: (input) => {
      setPickingFolder(true)
      void adoptInput(input).finally(() => { setPickingFolder(false) })
    },
    onCancel: () => { setFlowOpen(false) },
    onError: (message) => {
      setFlowOpen(false)
      setModalError(message)
      setErrorOpen(true)
    },
  })

  const handleSelect = (id: string): void => {
    if (id === ADD_WORKSPACE) {
      openDirectoryFlow()
      return
    }
    onPick(id as WorkspaceId)
  }

  return (
    <>
      <Menu
        open={open && !addIsTheOnlyEntry && !menuIsEmpty}
        anchor={null}
        items={items}
        {...pinAdd ? { footer: addEntries } : {}}
        selectedId={selectedId}
        onSelect={handleSelect}
        onClose={onClose}
        side={side}
        portal
        getAnchorRect={getAnchorRect}
      />
      {open && !addIsTheOnlyEntry && !menuIsEmpty && workspaceSnapshot.phase === 'pending' && <div className={css.menuStatus} role="status">{t('picker.loading')}</div>}
      {flowOpen && (flowAvailable ? 1 : 0) + createMethodEntries.length > 1 && (
        <div className={css.methods} role="tablist" aria-label={t('method.choose')}>
          {flowAvailable && (
            <button
              type="button"
              role="tab"
              aria-selected={method === 'local'}
              className={method === 'local' ? css.methodActive : css.method}
              onClick={() => { setMethod('local') }}
            >
              {t('method.local')}
            </button>
          )}
          {createMethodEntries.map(entry => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={method === entry.id}
              className={method === entry.id ? css.methodActive : css.method}
              onClick={() => { setMethod(entry.id) }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
      {renderDirectoryFlow(flowOwner)}
      {method !== 'local' && renderCreateMethod(method, methodOwner(method))}
      <Modal
        open={errorOpen}
        onClose={closeModal}
        closeLabel={t('close')}
        title={t('folderError.title')}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} onClick={closeModal}>{t('cancel')}</Button>
            {/* Retrying needs an occupant to serve the flow; without one the
              * button would open a flow nobody can answer or cancel. */}
            <Button variant="primary" className={css.modalAction} disabled={!flowAvailable && createMethodEntries.length === 0} onClick={openDirectoryFlow}>{t('folderError.retry')}</Button>
          </>
        )}
      >
        <div className={css.modalError} role="alert">{modalError}</div>
      </Modal>
    </>
  )
}

/**
 * The conversation empty-state registration: adapts the owner share to the
 * core flow (all state and semantics live in the flow / the owner).
 * @param props - empty-state slot props (owner share + injected creation callback).
 * @returns the flow element.
 */
export function WorkspacePicker({
  open,
  anchorRef,
  useWorkspaces,
  selectedId,
  onPick,
  onClose,
  createWorkspace,
  useDirectoryFlow,
  useCreateMethods,
  renderSlot,
  t,
}: WorkspacePickerProps) {
  return (
    <WorkspacePickFlow
      t={t}
      open={open}
      anchorRef={anchorRef}
      useWorkspaces={useWorkspaces}
      createWorkspace={createWorkspace}
      useDirectoryFlow={useDirectoryFlow}
      renderDirectoryFlow={owner => renderSlot('conversation.hero.workspace.directoryFlow', owner)}
      useCreateMethods={useCreateMethods}
      renderCreateMethod={(id, owner) => renderSlot('conversation.hero.workspace.createMethod', owner, { only: id })}
      selectedId={selectedId}
      onPick={onPick}
      onClose={onClose}
    />
  )
}
