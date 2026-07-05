/**
 * CMS HTTP API client — authenticates to the Instatic CMS and wraps REST calls.
 *
 * Login flow: POST /admin/api/cms/login with {email, password} → session cookie.
 * All subsequent calls include the cookie automatically via the stored cookie jar.
 *
 * Every fetch is bounded by Promise.race with an explicit timer so a stalled
 * CMS never hangs the MCP relay silently.
 */

import { withBudget, TimeoutError } from './trace'

const SESSION_COOKIE_NAME = 'instatic_admin_session'
const CMS_FETCH_TIMEOUT_MS = parseInt(process.env.MCP_CMS_FETCH_TIMEOUT_MS ?? '20000', 10)

export class CmsClient {
  private baseUrl: string
  private email?: string
  private password?: string
  private apiKey?: string
  private cookie: string | null = null
  private _loginPromise: Promise<void> | null = null

  constructor(baseUrl: string, email?: string, password?: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.email = email
    this.password = password
    this.apiKey = apiKey
  }

  /** Public entry for eager authentication at daemon startup. */
  async login(): Promise<void> {
    await this._ensureLogin()
  }

  /** Single-flight login — parallel callers share one in-flight promise. */
  private _ensureLogin(): Promise<void> {
    if (this.apiKey) return Promise.resolve()
    if (this.cookie) return Promise.resolve()
    if (this._loginPromise) return this._loginPromise
    this._loginPromise = this._doLogin()
    this._loginPromise.catch(() => { /* error handled in _doLogin */ })
    return this._loginPromise
  }

  private async _doLogin(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/admin/api/cms/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: this.email, password: this.password }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`CMS login failed (${res.status}): ${body}`)
      }
      const setCookie = res.headers.get('set-cookie')
      if (!setCookie) throw new Error('CMS login succeeded but no Set-Cookie header returned')
      const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))
      if (!match) throw new Error(`CMS login succeeded but no ${SESSION_COOKIE_NAME} cookie found`)
      this.cookie = `${SESSION_COOKIE_NAME}=${match[1]}`
    } finally {
      this._loginPromise = null
    }
  }

  private async request(
    traceId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    await this._ensureLogin()

    const headers: Record<string, string> = {}
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    } else if (this.cookie) {
      headers['Cookie'] = this.cookie
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const url = `${this.baseUrl}${path}`
    const fetchPromise = fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(async (res) => {
      if (res.status === 401) {
        // Session expired — clear cookie, re-login, retry once
        this.cookie = null
        await this._ensureLogin()
        if (this.cookie) headers['Cookie'] = this.cookie
        const retryRes = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        })
        if (!retryRes.ok) {
          const text = await retryRes.text().catch(() => '')
          throw new Error(`CMS ${method} ${path} failed after re-login (${retryRes.status}): ${text}`)
        }
        return retryRes.json().catch(() => null)
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`CMS ${method} ${path} failed (${res.status}): ${text}`)
      }
      return res.json().catch(() => null)
    })

    return withBudget(
      traceId,
      `cms:${method} ${path}`,
      'cmsClient:request',
      CMS_FETCH_TIMEOUT_MS,
      fetchPromise,
      undefined,
      undefined,
    )
  }

  // ── Site & Pages ──────────────────────────────────────────────────────

  getSite(traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'GET', '/admin/api/cms/site')
  }

  getSiteCatalog(traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'GET', '/admin/api/cms/site-catalog')
  }

  getComponents(traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'GET', '/admin/api/cms/components')
  }

  getLayouts(traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'GET', '/admin/api/cms/layouts')
  }

  saveSite(site: object, traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'PUT', '/admin/api/cms/site', { site })
  }

  async patchSiteField(field: string, value: unknown, traceId?: string): Promise<unknown> {
    const response = (await this.request(traceId ?? 'cms', 'GET', '/admin/api/cms/site')) as Record<string, unknown>
    const siteShell = response.site as Record<string, unknown>
    siteShell[field] = value
    return this.request(traceId ?? 'cms', 'PUT', '/admin/api/cms/site', response)
  }

  listPages(traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'GET', '/admin/api/cms/pages')
  }

  async getPageBySlug(slug: string, traceId?: string): Promise<unknown> {
    const response = (await this.request(traceId ?? 'cms', 'GET', '/admin/api/cms/pages')) as { rows: Array<{ slug: string } & Record<string, unknown>> }
    return response.rows.find((row) => row.slug === slug) ?? null
  }

  savePages(body: { changedPages: object[]; pageIds: string[]; baselinePageIds?: string[] }, traceId?: string): Promise<unknown> {
    const reqBody: Record<string, unknown> = { changedPages: body.changedPages, pageIds: body.pageIds }
    if (body.baselinePageIds) reqBody.baselinePageIds = body.baselinePageIds
    return this.request(traceId ?? 'cms', 'PUT', '/admin/api/cms/pages', reqBody)
  }

  // ── Publishing ────────────────────────────────────────────────────────

  publish(traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'POST', '/admin/api/cms/publish')
  }

  publishStatus(traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'GET', '/admin/api/cms/publish/status')
  }

  // ── Data Tables ───────────────────────────────────────────────────────

  listDataTables(traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'GET', '/admin/api/cms/data/tables')
  }

  listDataRows(tableId: string, traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'GET', `/admin/api/cms/data/tables/${tableId}/rows`)
  }

  createDataRow(tableId: string, cells?: Record<string, unknown>, traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'POST', `/admin/api/cms/data/tables/${tableId}/rows`, { cells })
  }

  // ── Data Rows (row-keyed endpoints) ───────────────────────────────────

  getDataRow(rowId: string, traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'GET', `/admin/api/cms/data/rows/${rowId}`)
  }

  saveDataRow(rowId: string, cells: Record<string, unknown>, traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'PATCH', `/admin/api/cms/data/rows/${rowId}`, { cells })
  }

  deleteDataRow(rowId: string, traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'DELETE', `/admin/api/cms/data/rows/${rowId}`)
  }

  publishDataRow(rowId: string, traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'POST', `/admin/api/cms/data/rows/${rowId}/publish`)
  }

  // ── Import / Export (API key auth) ──────────────────────────────────────

  importHtml(
    slug: string,
    html: string,
    title?: string,
    mode?: 'replace' | 'merge',
    traceId?: string,
  ): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'POST', '/admin/api/cms/pages/import-html', {
      slug,
      html,
      title,
      mode,
    })
  }

  exportHtml(slug: string, traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'GET', `/admin/api/cms/pages/${slug}/export-html`)
  }

  listClasses(traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'GET', '/admin/api/cms/classes')
  }

  getClass(nameOrId: string, traceId?: string): Promise<unknown> {
    return this.request(traceId ?? 'cms', 'GET', `/admin/api/cms/classes/${encodeURIComponent(nameOrId)}`)
  }
}
