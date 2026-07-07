/**
 * AgentPanel's model picker — a thin store-binding wrapper around the shared
 * {@link ModelPicker}. It maps the agent store's active `(credential, model)`
 * onto the picker's controlled `value`/`onChange` and renders the compact
 * `inline` trigger that fits the chat composer toolbar.
 */

import { useAgentStore } from '@admin/ai/useAgentStore'
import { ModelPicker as SharedModelPicker } from '@admin/ai/ModelPicker'
import type { CredentialView } from '@admin/ai/api'

const CASCADE_CREDENTIAL: CredentialView = {
  id: 'cascade',
  providerId: 'cascade',
  authMode: 'apiKey',
  displayLabel: 'Cascade',
  baseUrl: null,
  keyFingerprintCurrent: true,
  createdAt: new Date().toISOString(),
  lastUsedAt: new Date().toISOString(),
}

interface ModelPickerProps {
  /** Optional extra className for the trigger wrapper. */
  className?: string
  /** Credentials are loaded by AgentPanel so header + thread state stay in sync. */
  credentials: CredentialView[]
  /** True once the credential list fetch has completed at least once. */
  credentialsLoaded: boolean
  /** Re-run the credential list query when the picker opens. */
  onRefreshCredentials: () => void
  /** Live connection status of the local Cascade relay daemon. */
  cascadeConnected?: boolean
}

export function ModelPicker({
  className,
  credentials,
  credentialsLoaded,
  onRefreshCredentials,
  cascadeConnected,
}: ModelPickerProps) {
  const activeCredentialId = useAgentStore((s) => s.agentActiveCredentialId)
  const activeModelId = useAgentStore((s) => s.agentActiveModelId)
  const activeProviderId = useAgentStore((s) => s.agentActiveProviderId)
  const setAgentProvider = useAgentStore((s) => s.setAgentProvider)

  const allCredentials = [CASCADE_CREDENTIAL, ...credentials]

  const value =
    activeModelId && (activeCredentialId || activeProviderId === 'cascade')
      ? { credentialId: activeCredentialId ?? CASCADE_CREDENTIAL.id, modelId: activeModelId }
      : null

  return (
    <SharedModelPicker
      className={className}
      variant="inline"
      placeholder="Choose a model"
      credentials={allCredentials}
      credentialsLoaded={credentialsLoaded}
      value={value}
      onOpen={onRefreshCredentials}
      connectionStatus={cascadeConnected !== undefined ? { cascade: cascadeConnected } : undefined}
      onChange={({ credentialId, modelId }) => {
        const isCascade = credentialId === CASCADE_CREDENTIAL.id
        void setAgentProvider(isCascade ? null : credentialId, modelId, isCascade ? 'cascade' : undefined)
      }}
    />
  )
}
