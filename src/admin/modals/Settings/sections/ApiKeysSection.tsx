/**
 * ApiKeysSection — personal API key management.
 *
 * Lists the current user's API keys, lets them create new keys with a subset
 * of their capabilities, and delete old ones. The raw token is shown exactly
 * once after creation in a popup dialog; the server only stores its SHA-256 hash.
 */
import { useEffect, useRef, useState } from 'react'
import { apiRequest, ApiError } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { Input } from '@ui/components/Input'
import { Button } from '@ui/components/Button'
import { Switch } from '@ui/components/Switch'
import { Dialog } from '@ui/components/Dialog'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { MoreHorizontalSolidIcon } from 'pixel-art-icons/icons/more-horizontal-solid'
import { capabilityLabel } from '@admin/shared/CapabilityPicker/capabilityMeta'
import s from '../SettingsModal.module.css'

const ApiKeyListSchema = Type.Object({
  keys: Type.Array(Type.Object({
    id: Type.String(),
    label: Type.String(),
    capabilities: Type.Unknown(),
    createdAt: Type.Union([Type.String(), Type.Null()]),
    lastUsedAt: Type.Union([Type.String(), Type.Null()]),
    revokedAt: Type.Union([Type.String(), Type.Null()]),
  })),
})

type ApiKeyList = Static<typeof ApiKeyListSchema>

const ApiKeyCreateSchema = Type.Object({
  key: Type.Object({
    id: Type.String(),
    token: Type.String(),
    label: Type.String(),
    capabilities: Type.Unknown(),
  }),
})

type ApiKeyCreateResponse = Static<typeof ApiKeyCreateSchema>

const API_KEY_CAPABILITIES = [
  'pages.import',
  'pages.export',
  'site.structure.edit',
  'site.content.edit',
] as const

export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyList['keys']>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [selectedCaps, setSelectedCaps] = useState<Set<string>>(new Set())
  const [newKey, setNewKey] = useState<ApiKeyCreateResponse['key'] | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [detailsKey, setDetailsKey] = useState<ApiKeyList['keys'][number] | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<ApiKeyList['keys'][number] | null>(null)

  const loadKeys = async () => {
    try {
      const data = await apiRequest('/admin/api/cms/api-keys', { schema: ApiKeyListSchema })
      setKeys(data.keys)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load API keys')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadKeys()
  }, [])

  const handleCreate = async () => {
    if (!label.trim()) return
    const capabilities = Array.from(selectedCaps)
    if (capabilities.length === 0) return

    setSubmitting(true)
    try {
      const data = await apiRequest('/admin/api/cms/api-keys', {
        schema: ApiKeyCreateSchema,
        method: 'POST',
        body: { label: label.trim(), capabilities },
      })
      setNewKey(data.key)
      setLabel('')
      setSelectedCaps(new Set())
      await loadKeys()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create API key')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await apiRequest(`/admin/api/cms/api-keys/${id}`, {
        schema: Type.Object({ ok: Type.Boolean() }),
        method: 'DELETE',
      })
      if (detailsKey?.id === id) setDetailsKey(null)
      setDeleteConfirm(null)
      await loadKeys()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete API key')
    }
  }

  const copyToken = (token: string) => {
    void navigator.clipboard.writeText(token)
  }

  if (loading) {
    return <p className={s.sectionDescription}>Loading API keys…</p>
  }

  if (error) {
    return <p className={s.sectionDescription} role="alert">{error}</p>
  }

  return (
    <div>
      <p className={s.sectionDescription}>
        Create API keys for AI tools and scripts. Each key is scoped to the
        selected capabilities and can only do what your role allows.
      </p>

      {/* ── New key form ───────────────────────────────────────────────────── */}
      <div className={s.apiKeyForm}>
        <div className={s.apiKeyLabelRow}>
          <label htmlFor="api-key-label" className={s.label}>
            New key label
          </label>
          <Input
            id="api-key-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Windsurf / Cursor agent"
            disabled={submitting}
          />
        </div>

        <div className={s.apiKeyCaps}>
          <span className={s.label}>Capabilities</span>
          <div className={s.apiKeyCapGrid}>
            {API_KEY_CAPABILITIES.map((cap) => {
              const id = `api-key-cap-${cap}`
              return (
                <div key={cap} className={cn(s.toggleRow, s.apiKeyCapRow)}>
                  <div className={s.toggleRowContent}>
                    <label htmlFor={id} className={s.toggleRowLabel}>
                      {capabilityLabel(cap)}
                    </label>
                  </div>
                  <Switch
                    id={id}
                    checked={selectedCaps.has(cap)}
                    onCheckedChange={(checked) => {
                      const next = new Set(selectedCaps)
                      if (checked) next.add(cap)
                      else next.delete(cap)
                      setSelectedCaps(next)
                    }}
                    switchSize="sm"
                  />
                </div>
              )
            })}
          </div>
        </div>

        <Button
          type="button"
          variant="primary"
          size="md"
          onClick={handleCreate}
          disabled={submitting || !label.trim() || selectedCaps.size === 0}
        >
          Generate key
        </Button>
      </div>

      {/* ── Key list ───────────────────────────────────────────────────────── */}
      <div className={s.sectionBlock}>
        <h4 className={s.subHeading}>Active keys</h4>
        {keys.length === 0 ? (
          <p className={s.sectionDescription}>No API keys yet.</p>
        ) : (
          <ul className={s.apiKeyList}>
            {keys.map((key) => (
              <li key={key.id} className={s.apiKeyListItem}>
                <div className={s.apiKeyListItemMain}>
                  <span className={s.apiKeyListItemLabel}>{key.label}</span>
                  <span className={s.apiKeyListItemMeta}>
                    {Array.isArray(key.capabilities)
                      ? key.capabilities.map(capabilityLabel).join(', ')
                      : ''}
                  </span>
                </div>
                <KeyActionMenu
                  keyData={key}
                  onDelete={() => setDeleteConfirm(key)}
                  onDetails={() => setDetailsKey(key)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Token reveal dialog ────────────────────────────────────────────── */}
      <Dialog
        open={newKey !== null}
        onClose={() => setNewKey(null)}
        title="Your new API key"
        size="md"
        backdropClassName={s.apiKeyDialogBackdrop}
      >
        {newKey && (
          <div className={s.apiKeyTokenDialog}>
            <p className={s.apiKeyTokenWarning}>
              Copy it now — this is the only time the token is shown.
            </p>
            <div className={s.apiKeyTokenRow}>
              <code className={s.apiKeyToken}>{newKey.token}</code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => copyToken(newKey.token)}
                aria-label="Copy token"
              >
                <CopySolidIcon size={14} aria-hidden="true" />
              </Button>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={() => setNewKey(null)}
            >
              Done
            </Button>
          </div>
        )}
      </Dialog>

      {/* ── Key details dialog ─────────────────────────────────────────────── */}
      <Dialog
        open={detailsKey !== null}
        onClose={() => setDetailsKey(null)}
        title={detailsKey?.label ?? 'Key details'}
        size="sm"
        backdropClassName={s.apiKeyDialogBackdrop}
      >
        {detailsKey && (
          <div className={s.apiKeyDetailsDialog}>
            <p className={s.apiKeyTokenWarning}>
              The token is only shown once at creation. Store it in a safe place.
            </p>
            <div className={s.apiKeyDetailsGrid}>
              <span>Capabilities</span>
              <span>
                {Array.isArray(detailsKey.capabilities)
                  ? detailsKey.capabilities.map(capabilityLabel).join(', ')
                  : '—'}
              </span>
              <span>Created</span>
              <span>{detailsKey.createdAt ? new Date(detailsKey.createdAt).toLocaleString() : '—'}</span>
              {detailsKey.lastUsedAt && (
                <>
                  <span>Last used</span>
                  <span>{new Date(detailsKey.lastUsedAt).toLocaleString()}</span>
                </>
              )}
            </div>
            <div className={s.apiKeyDetailsActions}>
              <Button
                type="button"
                variant="secondary"
                size="md"
                onClick={() => setDetailsKey(null)}
              >
                Close
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="md"
                onClick={() => setDeleteConfirm(detailsKey)}
              >
                Delete key
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* ── Delete confirmation dialog ──────────────────────────────────────── */}
      <Dialog
        open={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        title="Delete API key?"
        size="sm"
        tone="danger"
        backdropClassName={s.apiKeyDialogBackdrop}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={() => setDeleteConfirm(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="md"
              onClick={() => deleteConfirm && handleDelete(deleteConfirm.id)}
            >
              Delete key
            </Button>
          </>
        }
      >
        {deleteConfirm && (
          <p className={s.sectionDescription}>
            <strong>{deleteConfirm.label}</strong> will be permanently removed.
            Any tool using this key will immediately lose access.
          </p>
        )}
      </Dialog>
    </div>
  )
}

function KeyActionMenu({
  keyData,
  onDelete,
  onDetails,
}: {
  keyData: ApiKeyList['keys'][number]
  onDelete: () => void
  onDetails: () => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const items = [
    { label: 'Look up', onSelect: onDetails },
    { label: 'Delete', onSelect: onDelete, danger: true as const },
  ]

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="sm"
        iconOnly
        active={open}
        aria-label={`Actions for ${keyData.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontalSolidIcon size={14} aria-hidden="true" />
      </Button>
      {open && (
        <ContextMenu
          ariaLabel={`Actions for ${keyData.label}`}
          onClose={() => setOpen(false)}
          anchorRef={triggerRef}
          side="bottom"
          align="end"
          width={160}
          zIndex={10000}
        >
          {items.map((item) => (
            <ContextMenuItem
              key={item.label}
              danger={'danger' in item ? item.danger : false}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
            >
              <span>{item.label}</span>
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </>
  )
}

function cn(...classes: (string | false | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}
