/**
 * Send a hero section to the local CMS via the import-html endpoint.
 *
 * Usage:
 *   INSTATIC_API_KEY=<key> bun run scripts/send-hero.ts
 *
 * Creates/updates the page with slug "home" and title "Home".
 */
const API_KEY = process.env.INSTATIC_API_KEY
if (!API_KEY) {
  console.error('Please set INSTATIC_API_KEY')
  process.exit(1)
}

const BASE_URL = process.env.INSTATIC_BASE_URL ?? 'http://localhost:3001'

export {}

const html = `<section style="padding: 96px 24px; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #ffffff; text-align: center; font-family: system-ui, -apple-system, sans-serif;">
  <div style="max-width: 720px; margin: 0 auto;">
    <h1 style="font-size: 48px; line-height: 1.1; margin: 0 0 24px; font-weight: 800;">
      Build beautiful sites with Instatic
    </h1>
    <p style="font-size: 20px; line-height: 1.6; margin: 0 0 40px; color: #a0aec0;">
      A self-hosted CMS with a visual editor, AI-powered design assistance, and clean HTML export.
    </p>
    <a href="#" style="display: inline-block; padding: 16px 32px; background: #6366f1; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
      Get started
    </a>
  </div>
</section>`

const body = JSON.stringify({
  slug: 'home',
  title: 'Home',
  html,
  mode: 'replace',
})

const res = await fetch(`${BASE_URL}/admin/api/cms/pages/import-html`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  },
  body,
})

const responseText = await res.text()
let data: unknown

try {
  data = JSON.parse(responseText)
} catch {
  data = responseText
}

if (!res.ok) {
  console.error('Import failed:', res.status, data)
  process.exit(1)
}

console.log('Import succeeded:', data)
