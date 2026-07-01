/**
 * AgentPanel's model picker — a thin store-binding wrapper around the shared
 * {@link ModelPicker}. It maps the agent store's active `(credential, model)`
 * onto the picker's controlled `value`/`onChange` and renders the compact
 * `inline` trigger that fits the chat composer toolbar.
 *
 * When Windsurf Cascade relay is active, this component swaps in a
 * Cascade-specific picker that reuses the same visual primitives (Button,
 * ContextMenu, ChevronDownIcon) so the toolbar stays visually consistent.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAgentStore } from '@admin/ai/useAgentStore'
import { ModelPicker as SharedModelPicker } from '@admin/ai/ModelPicker'
import type { CredentialView } from '@admin/ai/api'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { cn } from '@ui/cn'
import sharedStyles from '@admin/ai/ModelPicker/ModelPicker.module.css'
import styles from './AgentPanel.module.css'

interface ModelPickerProps {
  /** Optional extra className for the trigger wrapper. */
  className?: string
  /** Credentials are loaded by AgentPanel so header + thread state stay in sync. */
  credentials: CredentialView[]
  /** True once the credential list fetch has completed at least once. */
  credentialsLoaded: boolean
  /** Re-run the credential list query when the picker opens. */
  onRefreshCredentials: () => void
}

interface CascadeModel {
  id: string
  label: string
  free: boolean
}

/** Fetch available Cascade models from the MCP server. */
function useCascadeModels(cascadeRelay: boolean) {
  const [models, setModels] = useState<CascadeModel[]>([])

  useEffect(() => {
    if (!cascadeRelay) {
      setModels([])
      return
    }
    fetch('http://localhost:9876/cascade/models')
      .then((r) => r.json())
      .then((data) => {
        setModels(data.models?.map((m: CascadeModel) => ({ id: m.id, label: m.label, free: m.free })) ?? [])
      })
      .catch(() => {
        // Fallback if MCP server isn't reachable
        setModels([
          { id: 'kimi-k2-6', label: 'Kimi K2.6', free: true },
          { id: 'swe-1-6', label: 'SWE 1.6', free: true },
        ])
      })
  }, [cascadeRelay])

  return models
}

/** Poll MCP server for Cascade session status (tools available vs chat-only). */
function useCascadeStatus(cascadeRelay: boolean) {
  const [toolsAvailable, setToolsAvailable] = useState(false)

  useEffect(() => {
    if (!cascadeRelay) {
      setToolsAvailable(false)
      return
    }
    let cancelled = false
    const poll = () => {
      fetch('http://localhost:9876/cascade/status')
        .then((r) => r.json())
        .then((data: { toolsAvailable?: boolean }) => {
          if (!cancelled) setToolsAvailable(data.toolsAvailable ?? false)
        })
        .catch(() => {
          if (!cancelled) setToolsAvailable(false)
        })
    }
    poll()
    const interval = setInterval(poll, 10_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [cascadeRelay])

  return toolsAvailable
}

/** Inline model picker for Windsurf Cascade — visually identical to the shared
 *  ModelPicker's inline variant but backed by a plain model list (no credentials). */
function CascadeModelPicker({
  models,
  selectedId,
  onChange,
  className,
}: {
  models: CascadeModel[]
  selectedId: string | null
  onChange: (id: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const selected = models.find((m) => m.id === selectedId) ?? models[0]
  const label = selected?.label ?? 'Choose a model'

  const closeMenu = useCallback(() => setOpen(false), [])

  return (
    <div className={cn(className, sharedStyles.root)}>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        align="between"
        tooltip="Model"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={sharedStyles.inlineTrigger}
      >
        <span className={cn(sharedStyles.triggerLabel, !selected && sharedStyles.triggerPlaceholder)}>
          {label}
        </span>
        <ChevronDownIcon size={10} aria-hidden="true" />
      </Button>

      {open && (
        <ContextMenu
          ref={menuRef}
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          align="start"
          side="auto"
          offset={6}
          minWidth={200}
          maxHeight={280}
          ariaLabel="Windsurf Cascade models"
          onClose={closeMenu}
        >
          {models.map((m) => (
            <ContextMenuItem
              key={m.id}
              onClick={() => {
                onChange(m.id)
                closeMenu()
              }}
              data-active={m.id === selectedId ? 'true' : undefined}
            >
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <span>{m.label}</span>
                {m.free && (
                  <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--primary)', fontWeight: 700, marginLeft: '8px' }}>
                    Free
                  </span>
                )}
              </span>
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </div>
  )
}

export function ModelPicker({
  className,
  credentials,
  credentialsLoaded,
  onRefreshCredentials,
}: ModelPickerProps) {
  const activeCredentialId = useAgentStore((s) => s.agentActiveCredentialId)
  const activeModelId = useAgentStore((s) => s.agentActiveModelId)
  const setAgentProvider = useAgentStore((s) => s.setAgentProvider)
  const cascadeRelay = useAgentStore((s) => s.agentCascadeRelay)
  const setCascadeModel = useAgentStore((s) => s.setCascadeModel)
  const cascadeModelId = useAgentStore((s) => s.agentCascadeModelId)
  const cascadeModels = useCascadeModels(cascadeRelay)
  const toolsAvailable = useCascadeStatus(cascadeRelay)

  const value =
    activeCredentialId && activeModelId
      ? { credentialId: activeCredentialId, modelId: activeModelId }
      : null

  // When Cascade relay is active, swap in the Cascade-specific inline picker
  if (cascadeRelay) {
    return (
      <div className={className} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <CascadeModelPicker
          models={cascadeModels}
          selectedId={cascadeModelId}
          onChange={setCascadeModel}
        />
        <span className={styles.cascadeModelBadge} title="Windsurf Cascade">
          Cascade
        </span>
        <span
          className={styles.cascadeModelBadge}
          title={toolsAvailable
            ? 'Full tool access — Cascade can edit the CMS via the registered MCP server'
            : 'No connection — ensure Windsurf is running with the Instatic MCP server configured'}
          style={{
            color: toolsAvailable ? 'var(--success-bright)' : 'var(--text-muted)',
          }}
        >
          {toolsAvailable ? 'Tools ready' : 'No connection'}
        </span>
      </div>
    )
  }

  return (
    <SharedModelPicker
      className={className}
      variant="inline"
      placeholder="Choose a model"
      credentials={credentials}
      credentialsLoaded={credentialsLoaded}
      value={value}
      onOpen={onRefreshCredentials}
      onChange={({ credentialId, modelId }) => void setAgentProvider(credentialId, modelId)}
    />
  )
}
