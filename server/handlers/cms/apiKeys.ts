/**
 * API key management endpoints.
 *
 *   GET    /admin/api/cms/api-keys      — list the current user's API keys
 *   POST   /admin/api/cms/api-keys      — create a new API key
 *   DELETE /admin/api/cms/api-keys/:id  — delete one of the user's API keys
 *
 * Keys are personal: every operation is scoped to the authenticated user
 * and the capability gate is `apiKeys.manage`.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import type { CoreCapability } from '@core/capabilities'
import type { AuthUser } from '../../repositories/users'
import { createAuditEvent } from '../../repositories/audit'
import {
  createApiKey,
  listApiKeysForUser,
  deleteApiKey,
} from '../../repositories/apiKeys'
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { CMS_API_PREFIX, requestAuditContext } from './shared'
import { runRouteTable, type Route } from './routeTable'

const ApiKeyCreateBodySchema = Type.Object({
  label: Type.String(),
  capabilities: Type.Array(Type.String()),
})

const API_KEYS_PATH = `${CMS_API_PREFIX}/api-keys`

async function handleListApiKeys(
  _req: Request,
  db: DbClient,
  _params: Record<string, string>,
  actor: AuthUser,
): Promise<Response> {
  const keys = await listApiKeysForUser(db, actor.id)
  return jsonResponse({ keys: keys.map((key) => ({
    id: key.id,
    label: key.label,
    capabilities: key.capabilities_json,
    createdAt: key.created_at,
    lastUsedAt: key.last_used_at,
    revokedAt: key.revoked_at,
  })) })
}

async function handleCreateApiKey(
  req: Request,
  db: DbClient,
  _params: Record<string, string>,
  actor: AuthUser,
): Promise<Response> {
  const body = await readValidatedBody(req, ApiKeyCreateBodySchema)
  if (!body) return badRequest('Invalid API key payload')

  const allowedCaps = new Set(actor.capabilities)
  const requestedCaps = body.capabilities as CoreCapability[]
  for (const cap of requestedCaps) {
    if (!allowedCaps.has(cap)) {
      return jsonResponse({ error: `Capability not allowed: ${cap}` }, { status: 403 })
    }
  }

  try {
    const result = await createApiKey(db, {
      userId: actor.id,
      label: body.label,
      capabilities: requestedCaps,
    })

    await createAuditEvent(db, {
      actorUserId: actor.id,
      action: 'apiKey.create',
      targetType: 'apiKey',
      targetId: result.id,
      metadata: { label: body.label },
      ...requestAuditContext(req),
    })

    return jsonResponse({
      key: {
        id: result.id,
        token: result.token,
        label: body.label,
        capabilities: requestedCaps,
      },
    }, { status: 201 })
  } catch (err) {
    return jsonResponse({ error: 'Failed to create API key' }, { status: 500 })
  }
}

async function handleDeleteApiKey(
  req: Request,
  db: DbClient,
  params: Record<string, string>,
  actor: AuthUser,
): Promise<Response> {
  const keyId = params.id
  const deleted = await deleteApiKey(db, keyId, actor.id)
  if (!deleted) {
    return jsonResponse({ error: 'API key not found' }, { status: 404 })
  }

  await createAuditEvent(db, {
    actorUserId: actor.id,
    action: 'apiKey.delete',
    targetType: 'apiKey',
    targetId: keyId,
    metadata: {},
    ...requestAuditContext(req),
  })

  return jsonResponse({ ok: true })
}

const API_KEYS_ROUTES: readonly Route<[AuthUser]>[] = [
  { method: 'GET', pattern: API_KEYS_PATH, handler: handleListApiKeys },
  { method: 'POST', pattern: API_KEYS_PATH, handler: handleCreateApiKey },
  {
    method: 'DELETE',
    pattern: new RegExp(`^${API_KEYS_PATH}/(?<id>[^/]+)$`),
    handler: handleDeleteApiKey,
  },
]

export async function handleApiKeysRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const { pathname } = new URL(req.url)
  const prefix = `${CMS_API_PREFIX}/api-keys`
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
    return null
  }

  const actor = await requireCapability(req, db, 'apiKeys.manage')
  if (actor instanceof Response) return actor

  return runRouteTable(req, db, API_KEYS_ROUTES, actor)
}
