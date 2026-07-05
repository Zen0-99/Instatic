import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDbClient } from '../../../server/db'
import { runMigrations } from '../../../server/db/runMigrations'
import { syncSystemRoles } from '../../../server/repositories/roles'
import { createUser } from '../../../server/repositories/users'
import {
  createApiKey,
  findApiKeyByTokenHash,
  hashToken,
  listApiKeysForUser,
  deleteApiKey,
  effectiveCapabilities,
} from '../../../server/repositories/apiKeys'
import { handleExportHtmlRoute } from '../../../server/handlers/cms/exportHtml'
import { handleImportHtmlRoute } from '../../../server/handlers/cms/importHtml'
import { handleApiKeysRoutes } from '../../../server/handlers/cms/apiKeys'
import { createSession } from '../../../server/auth/sessions'
import { hashSessionToken, SESSION_COOKIE_NAME } from '../../../server/auth/tokens'
import { listDataRows } from '../../../server/repositories/data'
import { exportSiteFiles, deleteExportedPageFile } from '../../../server/persistence/exportSiteFiles'
import { loadFullDraftSiteDocument } from '../../../server/repositories/siteDocument'
import type { DbClient } from '../../../server/db'

async function withTestDb<T>(fn: (db: DbClient, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'instatic-api-key-'))
  const databaseUrl = `sqlite:${join(dir, 'cms.db')}`
  const { db, migrations } = createDbClient(databaseUrl)
  try {
    await runMigrations(db, migrations)
    // System role sync runs on server boot; replicate it in tests so the
    // seeded Owner/Admin roles include any newly-added capabilities.
    await syncSystemRoles(db)
    return await fn(db, dir)
  } finally {
    db.close?.()
    let cleanupErr: unknown
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true })
        cleanupErr = null
        break
      } catch (e) {
        cleanupErr = e
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
      }
    }
    if (cleanupErr) {
      console.warn('[withTestDb] temp directory cleanup failed:', cleanupErr)
    }
  }
}

async function seedOwner(db: DbClient): Promise<{ userId: string; apiKeyToken: string }> {
  const user = await createUser(db, {
    id: 'test-owner',
    email: 'owner@example.com',
    displayName: 'Owner',
    passwordHash: 'fakehash',
    roleId: 'owner',
    allowOwnerRole: true,
  })
  const { token } = await createApiKey(db, {
    userId: user.id,
    label: 'Test Key',
    capabilities: ['pages.import', 'pages.export', 'site.structure.edit', 'site.content.edit'],
  })
  return { userId: user.id, apiKeyToken: token }
}

async function seedSite(db: DbClient): Promise<void> {
  await db`
    insert into site (id, name, settings_json)
    values ('default', 'Test Site', '{}')
  `
}

function makeRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost:3001${path}`, init)
}

function jsonBody(data: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }
}

async function sessionRequest(
  db: DbClient,
  userId: string,
  path: string,
  init: RequestInit = {},
): Promise<Request> {
  const token = 'test-session-' + Date.now()
  await createSession(db, {
    idHash: await hashSessionToken(token),
    userId,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    ipAddress: '127.0.0.1',
    userAgent: 'test',
  })
  const req = makeRequest(path, init)
  req.headers.set('Cookie', `${SESSION_COOKIE_NAME}=${token}`)
  return req
}

describe('API key repository', () => {
  it('hashes and looks up tokens correctly', async () => {
    await withTestDb(async (db) => {
      const { userId } = await seedOwner(db)
      const { token } = await createApiKey(db, {
        userId,
        label: 'Lookup Key',
        capabilities: ['pages.export'],
      })
      const result = await findApiKeyByTokenHash(db, hashToken(token))
      expect(result).not.toBeNull()
      expect(result!.apiKey.user_id).toBe(userId)
      expect(result!.user.id).toBe(userId)
      expect(result!.apiKey.revoked_at).toBeNull()
    })
  })

  it('effective capabilities are intersection of user and key caps', () => {
    const user = { capabilities: ['pages.import', 'pages.export', 'site.read'] }
    const apiKey = { capabilities_json: ['pages.export', 'site.structure.edit'] }
    expect(effectiveCapabilities(user, apiKey)).toEqual(['pages.export'])
  })

  it('deletes keys and excludes them from lookup', async () => {
    await withTestDb(async (db) => {
      const { userId } = await seedOwner(db)
      const { token, id } = await createApiKey(db, {
        userId,
        label: 'Delete Key',
        capabilities: ['pages.export'],
      })
      expect(await deleteApiKey(db, id, userId)).toBe(true)
      expect(await findApiKeyByTokenHash(db, hashToken(token))).toBeNull()
      const keys = await listApiKeysForUser(db, userId)
      expect(keys.some((k) => k.id === id)).toBe(false)
    })
  })
})

describe('HTML export handler', () => {
  it('returns clean HTML for an existing page via API key', async () => {
    await withTestDb(async (db) => {
      await seedSite(db)
      const { apiKeyToken } = await seedOwner(db)

      // Import a page first.
      const importReq = makeRequest(
        '/admin/api/cms/pages/import-html',
        jsonBody({ slug: 'home', title: 'Home', html: '<h1>Hello world</h1>' }),
      )
      importReq.headers.set('Authorization', `Bearer ${apiKeyToken}`)
      const importRes = await handleImportHtmlRoute(importReq, db)
      expect(importRes?.status).toBe(200)

      // Export it.
      const exportReq = makeRequest('/admin/api/cms/pages/home/export-html')
      exportReq.headers.set('Authorization', `Bearer ${apiKeyToken}`)
      const exportRes = await handleExportHtmlRoute(exportReq, db)
      expect(exportRes?.status).toBe(200)
      const body = await exportRes!.json()
      expect(body.slug).toBe('home')
      expect(body.title).toBe('Home')
      expect(body.html).toContain('Hello world')
      expect(body.html).toContain('<h1>')
    })
  })

  it('returns 404 for a missing slug', async () => {
    await withTestDb(async (db) => {
      await seedSite(db)
      const { apiKeyToken } = await seedOwner(db)
      const req = makeRequest('/admin/api/cms/pages/missing/export-html')
      req.headers.set('Authorization', `Bearer ${apiKeyToken}`)
      const res = await handleExportHtmlRoute(req, db)
      expect(res?.status).toBe(404)
    })
  })

  it('returns 401 without a valid API key', async () => {
    await withTestDb(async (db) => {
      await seedSite(db)
      const req = makeRequest('/admin/api/cms/pages/home/export-html')
      const res = await handleExportHtmlRoute(req, db)
      expect(res?.status).toBe(401)
    })
  })

  it('returns 403 for a key without pages.export', async () => {
    await withTestDb(async (db) => {
      await seedSite(db)
      const user = await createUser(db, {
        id: 'limited-user',
        email: 'limited@example.com',
        displayName: 'Limited',
        passwordHash: 'fakehash',
        roleId: 'client',
      })
      const { token } = await createApiKey(db, {
        userId: user.id,
        label: 'Limited Key',
        capabilities: ['pages.import'],
      })
      const req = makeRequest('/admin/api/cms/pages/home/export-html')
      req.headers.set('Authorization', `Bearer ${token}`)
      const res = await handleExportHtmlRoute(req, db)
      expect(res?.status).toBe(403)
    })
  })
})

describe('HTML import handler', () => {
  it('creates a new page when the slug does not exist', async () => {
    await withTestDb(async (db) => {
      await seedSite(db)
      const { apiKeyToken } = await seedOwner(db)

      const req = makeRequest(
        '/admin/api/cms/pages/import-html',
        jsonBody({ slug: 'about', title: 'About', html: '<p>About us</p>' }),
      )
      req.headers.set('Authorization', `Bearer ${apiKeyToken}`)
      const res = await handleImportHtmlRoute(req, db)
      expect(res?.status).toBe(200)
      const body = await res!.json()
      expect(body.created).toBe(true)
      expect(body.slug).toBe('about')

      const rows = await listDataRows(db, 'pages')
      expect(rows.some((r) => r.slug === 'about')).toBe(true)
    })
  })

  it('round-trips a design page: import and export preserve text and structure', async () => {
    await withTestDb(async (db) => {
      await seedSite(db)
      const { apiKeyToken } = await seedOwner(db)

      const designHtml = `
        <section class="hero">
          <h1>Hero Title</h1>
          <p>Hero subtitle</p>
          <a href="/about" class="button">Learn more</a>
        </section>
      `
      const importReq = makeRequest(
        '/admin/api/cms/pages/import-html',
        jsonBody({ slug: 'landing', title: 'Landing', html: designHtml }),
      )
      importReq.headers.set('Authorization', `Bearer ${apiKeyToken}`)
      const importRes = await handleImportHtmlRoute(importReq, db)
      expect(importRes?.status).toBe(200)

      const exportReq = makeRequest('/admin/api/cms/pages/landing/export-html')
      exportReq.headers.set('Authorization', `Bearer ${apiKeyToken}`)
      const exportRes = await handleExportHtmlRoute(exportReq, db)
      expect(exportRes?.status).toBe(200)
      const exported = await exportRes!.text()

      expect(exported).toContain('Hero Title')
      expect(exported).toContain('Hero subtitle')
      expect(exported).toContain('Learn more')
      expect(exported).toContain('/about')
      // Clean export should not contain internal node ids.
      expect(exported).not.toContain('node-id-')
    })
  })

  it('updates an existing page in replace mode', async () => {
    await withTestDb(async (db) => {
      await seedSite(db)
      const { apiKeyToken } = await seedOwner(db)

      // First import.
      const req1 = makeRequest(
        '/admin/api/cms/pages/import-html',
        jsonBody({ slug: 'contact', title: 'Contact', html: '<p>Old</p>' }),
      )
      req1.headers.set('Authorization', `Bearer ${apiKeyToken}`)
      await handleImportHtmlRoute(req1, db)

      // Replace.
      const req2 = makeRequest(
        '/admin/api/cms/pages/import-html',
        jsonBody({ slug: 'contact', title: 'Contact v2', html: '<p>New</p>' }),
      )
      req2.headers.set('Authorization', `Bearer ${apiKeyToken}`)
      const res = await handleImportHtmlRoute(req2, db)
      expect(res?.status).toBe(200)
      const body = await res!.json()
      expect(body.created).toBe(false)

      const rows = await listDataRows(db, 'pages')
      const row = rows.find((r) => r.slug === 'contact')
      expect(row?.cells.title).toBe('Contact v2')
    })
  })

  it('rejects import for a key without pages.import', async () => {
    await withTestDb(async (db) => {
      await seedSite(db)
      const user = await createUser(db, {
        id: 'readonly-user',
        email: 'readonly@example.com',
        displayName: 'Readonly',
        passwordHash: 'fakehash',
        roleId: 'client',
      })
      const { token } = await createApiKey(db, {
        userId: user.id,
        label: 'Readonly Key',
        capabilities: ['pages.export'],
      })
      const req = makeRequest(
        '/admin/api/cms/pages/import-html',
        jsonBody({ slug: 'x', html: '<p>x</p>' }),
      )
      req.headers.set('Authorization', `Bearer ${token}`)
      const res = await handleImportHtmlRoute(req, db)
      expect(res?.status).toBe(403)
    })
  })
})

describe('Local file export hook', () => {
  it('writes imported page HTML to .instatic/pages/<slug>.html', async () => {
    await withTestDb(async (db, dir) => {
      await seedSite(db)
      const { apiKeyToken } = await seedOwner(db)

      const req = makeRequest(
        '/admin/api/cms/pages/import-html',
        jsonBody({ slug: 'local', title: 'Local', html: '<h2>Local page</h2>' }),
      )
      req.headers.set('Authorization', `Bearer ${apiKeyToken}`)
      await handleImportHtmlRoute(req, db, { projectRoot: dir })

      const exported = await readFile(join(dir, '.instatic', 'pages', 'local.html'), 'utf-8')
      expect(exported).toContain('Local page')
      expect(exported).toContain('<h2>')
    })
  })

  it('exports changed pages and deletes the export file for removed pages', async () => {
    await withTestDb(async (db, dir) => {
      await seedSite(db)
      const { apiKeyToken } = await seedOwner(db)

      const req = makeRequest(
        '/admin/api/cms/pages/import-html',
        jsonBody({ slug: 'delete-me', title: 'Delete Me', html: '<p>Delete me</p>' }),
      )
      req.headers.set('Authorization', `Bearer ${apiKeyToken}`)
      await handleImportHtmlRoute(req, db)

      const site = await loadFullDraftSiteDocument(db)
      expect(site).not.toBeNull()

      await exportSiteFiles(dir, site!)
      expect(
        await readFile(join(dir, '.instatic', 'pages', 'delete-me.html'), 'utf-8'),
      ).toContain('Delete me')

      await deleteExportedPageFile(dir, 'delete-me')
      await expect(readFile(join(dir, '.instatic', 'pages', 'delete-me.html'), 'utf-8')).rejects.toBeDefined()
    })
  })
})

describe('API key admin endpoints', () => {
  it('lists the current user API keys', async () => {
    await withTestDb(async (db) => {
      const { userId } = await seedOwner(db)
      await createApiKey(db, { userId, label: 'List Key', capabilities: ['pages.export'] })

      const req = await sessionRequest(db, userId, '/admin/api/cms/api-keys')
      const res = await handleApiKeysRoutes(req, db)
      expect(res?.status).toBe(200)
      const body = await res!.json()
      expect(body.keys).toHaveLength(2)
      expect(body.keys.some((k: { label: string }) => k.label === 'List Key')).toBe(true)
    })
  })

  it('creates an API key scoped to a subset of user capabilities', async () => {
    await withTestDb(async (db) => {
      const { userId } = await seedOwner(db)
      const req = await sessionRequest(
        db,
        userId,
        '/admin/api/cms/api-keys',
        jsonBody({ label: 'New Key', capabilities: ['pages.import'] }),
      )
      const res = await handleApiKeysRoutes(req, db)
      expect(res?.status).toBe(201)
      const body = await res!.json()
      expect(body.key.token).toMatch(/^instatic_/)
      expect(body.key.label).toBe('New Key')

      const key = await findApiKeyByTokenHash(db, hashToken(body.key.token))
      expect(key).not.toBeNull()
    })
  })

  it('deletes an API key', async () => {
    await withTestDb(async (db) => {
      const { userId } = await seedOwner(db)
      const { id } = await createApiKey(db, { userId, label: 'Delete Me', capabilities: ['pages.export'] })

      const req = await sessionRequest(db, userId, `/admin/api/cms/api-keys/${id}`, { method: 'DELETE' })
      const res = await handleApiKeysRoutes(req, db)
      expect(res?.status).toBe(200)

      const keys = await listApiKeysForUser(db, userId)
      expect(keys.find((k) => k.id === id)).toBeUndefined()
    })
  })

  it('returns 403 for a user without apiKeys.manage', async () => {
    await withTestDb(async (db) => {
      const user = await createUser(db, {
        id: 'client-user',
        email: 'client@example.com',
        displayName: 'Client',
        passwordHash: 'fakehash',
        roleId: 'client',
      })
      const req = await sessionRequest(db, user.id, '/admin/api/cms/api-keys')
      const res = await handleApiKeysRoutes(req, db)
      expect(res?.status).toBe(403)
    })
  })
})
