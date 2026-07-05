/**
 * API key repository.
 *
 * Per-user API keys are scoped to a subset of the user's capabilities and are
 * used by external AI tools (IDE-based agents) to authenticate against the
 * CMS without browser sessions. The raw token is shown once at creation; only
 * its SHA-256 hash is stored.
 */
import { createHash, randomBytes } from 'crypto'
import type { DbClient } from '../db/client'
import { placeholder } from '../db/client'
import { type CoreCapability } from '@core/capabilities'
import { normalizeCapabilities } from '../auth/capabilities'
import { rowToUser, USER_JOINED_COLUMNS, type AuthUser, type JoinedUserRow } from './users'

export interface ApiKeyRow {
  id: string
  user_id: string
  label: string
  token_hash: string
  capabilities_json: unknown
  created_at: Date | string
  last_used_at: Date | string | null
  revoked_at: Date | string | null
}

export interface ApiKeyWithUser {
  apiKey: ApiKeyRow
  user: AuthUser
}

export interface CreateApiKeyResult {
  /** The raw API key to show the user exactly once. */
  token: string
  id: string
}

const API_KEY_COLUMNS = `user_api_keys.id,
  user_api_keys.user_id,
  user_api_keys.label,
  user_api_keys.token_hash,
  user_api_keys.capabilities_json,
  user_api_keys.created_at,
  user_api_keys.last_used_at,
  user_api_keys.revoked_at`

function generateToken(): string {
  return 'instatic_' + randomBytes(32).toString('hex')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createApiKey(
  db: DbClient,
  input: {
    userId: string
    label: string
    capabilities: CoreCapability[]
  },
): Promise<CreateApiKeyResult> {
  const token = generateToken()
  const id = 'uak_' + randomBytes(12).toString('hex')
  await db`
    insert into user_api_keys (id, user_id, label, token_hash, capabilities_json)
    values (${id}, ${input.userId}, ${input.label}, ${hashToken(token)}, ${JSON.stringify(input.capabilities)})
  `
  return { token, id }
}

export async function findApiKeyByTokenHash(
  db: DbClient,
  tokenHash: string,
): Promise<ApiKeyWithUser | null> {
  const { rows } = await db.unsafe<ApiKeyRow & JoinedUserRow>(
    `select ${API_KEY_COLUMNS}, ${USER_JOINED_COLUMNS}
     from user_api_keys
     join users on users.id = user_api_keys.user_id
     join roles on roles.id = users.role_id
     left join media_assets on media_assets.id = users.avatar_media_id
     where user_api_keys.token_hash = ${placeholder(db.dialect, 1)}
       and user_api_keys.revoked_at is null
       and users.status = ${placeholder(db.dialect, 2)}
       and users.deleted_at is null
     limit 1`,
    [tokenHash, 'active'],
  )
  const row = rows[0]
  if (!row) return null
  const apiKey: ApiKeyRow = {
    id: row.id,
    user_id: row.user_id,
    label: row.label,
    token_hash: row.token_hash,
    capabilities_json: row.capabilities_json,
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
    revoked_at: row.revoked_at ?? null,
  }
  return { apiKey, user: rowToUser(row) }
}

export async function revokeApiKey(db: DbClient, keyId: string, userId: string): Promise<boolean> {
  const { rowCount } = await db`
    update user_api_keys
    set revoked_at = ${new Date().toISOString()}
    where id = ${keyId} and user_id = ${userId} and revoked_at is null
  `
  return rowCount > 0
}

export async function deleteApiKey(db: DbClient, keyId: string, userId: string): Promise<boolean> {
  const { rowCount } = await db`
    delete from user_api_keys
    where id = ${keyId} and user_id = ${userId}
  `
  return rowCount > 0
}

export async function listApiKeysForUser(db: DbClient, userId: string): Promise<ApiKeyRow[]> {
  const { rows } = await db.unsafe<ApiKeyRow>(
    `select ${API_KEY_COLUMNS}
     from user_api_keys
     where user_id = ${placeholder(db.dialect, 1)}
     order by created_at desc`,
    [userId],
  )
  return rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    label: row.label,
    token_hash: row.token_hash,
    capabilities_json: row.capabilities_json,
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
    revoked_at: row.revoked_at ?? null,
  }))
}

export async function touchApiKeyLastUsed(db: DbClient, keyId: string): Promise<void> {
  await db`
    update user_api_keys
    set last_used_at = ${new Date().toISOString()}
    where id = ${keyId}
  `
}

/**
 * Compute the effective capabilities for an API key: intersection of the
 * user's role capabilities and the key's declared capabilities. The key can
 * never grant more than the user has.
 */
export function effectiveCapabilities(
  user: Pick<AuthUser, 'capabilities'>,
  apiKey: Pick<ApiKeyRow, 'capabilities_json'>,
): CoreCapability[] {
  const keyCaps = new Set(normalizeCapabilities(apiKey.capabilities_json))
  return user.capabilities.filter((cap) => keyCaps.has(cap))
}
