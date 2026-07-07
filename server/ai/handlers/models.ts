/**
 * Model picker source — GET /admin/api/ai/providers/:id/models
 *
 * Asks the driver to list models for one provider. The optional
 * `credentialId` query parameter is forwarded to the driver in case the
 * model list depends on the credential (e.g. Ollama's local model set,
 * Anthropic's subscription tier).
 */

import { jsonResponse } from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { resolveDriver } from '../drivers'
import {
  readCredentialForUser,
  resolveCredentialForDriver,
} from '../credentials/store'
import { getModelCatalogue, pricingKey } from '../pricing'
import type { AiProviderModel } from '../drivers/types'
import type { AiProviderId } from '../runtime/types'

const VALID_PROVIDERS: AiProviderId[] = ['anthropic', 'openai', 'ollama', 'openrouter', 'openai-compatible', 'cascade']

const CASCADE_HARDCODED_MODELS: AiProviderModel[] = [
  { id: 'glm-5-2', label: 'GLM-5.2 High', capabilities: { toolCalling: true, visionInput: false, promptCache: false, streaming: true }, pricing: { inputPerMTok: 0, outputPerMTok: 0 }, contextWindow: 200_000 },
  { id: 'kimi-k2-7', label: 'Kimi K2.7', capabilities: { toolCalling: true, visionInput: false, promptCache: false, streaming: true }, pricing: { inputPerMTok: 0, outputPerMTok: 0 }, contextWindow: 262_000 },
  { id: 'swe-1-6', label: 'SWE 1.6', capabilities: { toolCalling: true, visionInput: false, promptCache: false, streaming: true }, pricing: { inputPerMTok: 0, outputPerMTok: 0 }, contextWindow: 200_000 },
  { id: 'claude-opus-4-8-medium', label: 'Claude Opus 4.8', capabilities: { toolCalling: true, visionInput: false, promptCache: false, streaming: true }, pricing: { inputPerMTok: 5, outputPerMTok: 25 }, contextWindow: 1_000_000 },
]

export function tryHandleAiModels(
  req: Request,
  db: DbClient,
  url: URL,
  pathname: string,
): Promise<Response> | null {
  const match = pathname.match(/^\/admin\/api\/ai\/providers\/([^/]+)\/models$/)
  if (!match) return null
  return handleModels(req, db, url, match[1]!)
}

async function handleModels(
  req: Request,
  db: DbClient,
  url: URL,
  providerParam: string,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }
  const userOrResponse = await requireCapability(req, db, 'ai.chat')
  if (userOrResponse instanceof Response) return userOrResponse

  if (!VALID_PROVIDERS.includes(providerParam as AiProviderId)) {
    return jsonResponse(
      { error: `Unknown provider "${providerParam}". Must be one of: ${VALID_PROVIDERS.join(', ')}` },
      { status: 400 },
    )
  }
  const providerId = providerParam as AiProviderId

  if (providerId === 'cascade') {
    return listCascadeModels()
  }

  const driver = resolveDriver(providerId)

  // Optional credential — when the picker has one selected, decrypt it
  // so the driver can hit the real model-list endpoint. Without one, we
  // pass a placeholder credential; the key-based providers (Anthropic,
  // OpenAI) then return an empty list — there is no static fallback, so the
  // picker stays empty until a credential is chosen.
  const credentialId = url.searchParams.get('credentialId')
  let resolved
  if (credentialId) {
    const record = await readCredentialForUser(db, userOrResponse.id, credentialId)
    if (!record) {
      return jsonResponse({ error: 'Credential not found' }, { status: 404 })
    }
    try {
      resolved = await resolveCredentialForDriver(record)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Credential resolution failed.'
      return jsonResponse({ error: message }, { status: 409 })
    }
  } else {
    resolved = {
      id: '',
      providerId,
      authMode:
        providerId === 'ollama' || providerId === 'openai-compatible'
          ? ('baseUrl' as const)
          : ('apiKey' as const),
      apiKey: null,
      baseUrl: null,
    }
  }

  const models = await driver.listModels(resolved)
  // Anthropic + OpenAI list models without prices or context windows (their
  // APIs omit both). Enrich from the live OpenRouter catalogue — the same
  // source the cost path uses. OpenRouter self-populates from its own fetch
  // and Ollama is free/self-hosted, so neither is enriched here.
  const enriched =
    providerId === 'anthropic' || providerId === 'openai'
      ? await enrichFromCatalogue(db, models)
      : models
  return jsonResponse({ models: enriched })
}

async function listCascadeModels(): Promise<Response> {
  const relayUrl = process.env.INSTATIC_MCP_URL ?? 'http://localhost:9876'
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    const res = await fetch(`${relayUrl}/models`, { method: 'GET', signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) {
      return jsonResponse({ models: CASCADE_HARDCODED_MODELS })
    }
    const body = await res.json() as { models?: Array<Partial<AiProviderModel> & { id: string; label: string }> }
    const models = Array.isArray(body.models) && body.models.length > 0
      ? body.models.map((m) => ({
          id: m.id,
          label: m.label,
          capabilities: m.capabilities ?? {
            toolCalling: true,
            visionInput: false,
            promptCache: false,
            streaming: true,
          },
          ...('pricing' in m && m.pricing ? { pricing: m.pricing } : {}),
          ...('contextWindow' in m && typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
        }))
      : CASCADE_HARDCODED_MODELS
    return jsonResponse({ models })
  } catch {
    return jsonResponse({ models: CASCADE_HARDCODED_MODELS })
  }
}

async function enrichFromCatalogue(
  db: DbClient,
  models: AiProviderModel[],
): Promise<AiProviderModel[]> {
  const catalogue = await getModelCatalogue(db)
  if (catalogue.size === 0) return models
  return models.map((model) => {
    const entry = catalogue.get(pricingKey(model.id))
    if (!entry) return model
    return {
      ...model,
      pricing: {
        inputPerMTok: entry.prices.inputPerMTok,
        outputPerMTok: entry.prices.outputPerMTok,
      },
      ...(entry.contextWindow !== null ? { contextWindow: entry.contextWindow } : {}),
    }
  })
}
