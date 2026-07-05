/**
 * API key authentication helper.
 *
 * Resolves an authenticated user from an `Authorization: Bearer <token>`
 * header. The token is hashed and looked up in the `user_api_keys` table; the
 * resulting user object carries the intersection of the user's role
 * capabilities and the key's declared capabilities, so a key can never grant
 * more than the user has.
 */
import type { DbClient } from '../db/client'
import { jsonResponse } from '../http'
import { requireAuthenticatedUser } from './authz'
import { findApiKeyByTokenHash, hashToken, touchApiKeyLastUsed, effectiveCapabilities } from '../repositories/apiKeys'
import type { AuthUser } from '../repositories/users'

function readBearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(\S+)$/i)
  return match?.[1] ?? null
}

async function resolveApiKeyUser(
  db: DbClient,
  token: string,
): Promise<AuthUser | null> {
  const result = await findApiKeyByTokenHash(db, hashToken(token))
  if (!result) return null
  const { apiKey, user } = result
  const capabilities = effectiveCapabilities(user, apiKey)
  // Update last_used asynchronously; failures are non-fatal.
  touchApiKeyLastUsed(db, apiKey.id).catch(() => {})
  return { ...user, capabilities }
}

/**
 * Authenticate via API key only. Returns the user with effective capabilities,
 * or a 401 response when the header is missing, malformed, or the key is
 * revoked/unknown.
 */
export async function requireApiKeyAuthenticatedUser(
  req: Request,
  db: DbClient,
): Promise<AuthUser | Response> {
  const token = readBearerToken(req)
  if (!token) {
    return jsonResponse({ error: 'Unauthorized' }, { status: 401 })
  }
  const user = await resolveApiKeyUser(db, token)
  if (!user) {
    return jsonResponse({ error: 'Unauthorized' }, { status: 401 })
  }
  return user
}

/**
 * Authenticate via session cookie, falling back to API key when no valid
 * session is present. This is useful for read endpoints that should work both
 * from the browser and from IDE tools.
 */
export async function requireAuthenticatedUserOrApiKey(
  req: Request,
  db: DbClient,
): Promise<AuthUser | Response> {
  const sessionUser = await requireAuthenticatedUser(req, db)
  if (!(sessionUser instanceof Response)) return sessionUser

  const token = readBearerToken(req)
  if (!token) return sessionUser // 401 from session check

  const user = await resolveApiKeyUser(db, token)
  if (!user) {
    return jsonResponse({ error: 'Unauthorized' }, { status: 401 })
  }
  return user
}
