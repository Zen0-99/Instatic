/**
 * Injection pack loader & classifier.
 *
 * Reads markdown files from the `injections/` directory next to this script.
 * Each pack (except base.md) has YAML-ish frontmatter with id, title, keywords,
 * and summary. The base.md pack is always injected; others are loaded on demand
 * or pre-selected via keyword classification.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INJECTIONS_DIR = join(__dirname, 'injections')

export interface Pack {
  id: string
  title: string
  keywords: string[]
  summary: string
  body: string
}

let baseBody = ''
let packs: Pack[] = []
let loaded = false

function loadIfNeeded(): void {
  if (loaded) return
  loaded = true

  const files = readdirSync(INJECTIONS_DIR).filter((f) => f.endsWith('.md'))

  for (const file of files) {
    const raw = readFileSync(join(INJECTIONS_DIR, file), 'utf-8')

    if (file === 'base.md') {
      baseBody = raw.trim()
      continue
    }

    const parsed = parseFrontmatter(raw)
    if (!parsed) continue

    packs.push({
      id: parsed.frontmatter.id ?? file.replace(/\.md$/, ''),
      title: parsed.frontmatter.title ?? parsed.frontmatter.id ?? file,
      keywords: parseKeywords(parsed.frontmatter.keywords),
      summary: parsed.frontmatter.summary ?? '',
      body: parsed.body.trim(),
    })
  }
}

interface ParsedPack {
  frontmatter: Record<string, string>
  body: string
}

function parseFrontmatter(raw: string): ParsedPack | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!fmMatch) return null

  const fmText = fmMatch[1]
  const body = fmMatch[2]
  const frontmatter: Record<string, string> = {}

  let currentKey = ''
  for (const line of fmText.split('\n')) {
    const kvMatch = line.match(/^(\w+):\s*(.*)$/)
    if (kvMatch) {
      currentKey = kvMatch[1]
      frontmatter[currentKey] = kvMatch[2].trim()
    } else if (currentKey && line.startsWith('  ') && line.trim()) {
      // Multi-line value (e.g., keywords list)
      frontmatter[currentKey] += (frontmatter[currentKey] ? ' ' : '') + line.trim()
    }
  }

  return { frontmatter, body }
}

function parseKeywords(raw: string): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
}

export function getBase(): string {
  loadIfNeeded()
  return baseBody
}

export function buildManifest(): string {
  loadIfNeeded()
  if (packs.length === 0) return ''
  const lines = packs.map((p) => `- **${p.id}** — ${p.summary}`)
  return 'Available guidance packs (call get_guidance with the pack id to load full details):\n' + lines.join('\n')
}

export function classify(message: string): string {
  loadIfNeeded()
  const lower = message.toLowerCase()
  let bestId = 'design' // sensible default for a CMS visual builder
  let bestScore = 0

  for (const pack of packs) {
    let score = 0
    for (const kw of pack.keywords) {
      if (lower.includes(kw)) score += kw.length > 4 ? 2 : 1
    }
    if (score > bestScore) {
      bestScore = score
      bestId = pack.id
    }
  }

  return bestId
}

export function getPack(id: string): string {
  loadIfNeeded()
  const pack = packs.find((p) => p.id === id)
  if (!pack) {
    const validIds = packs.map((p) => p.id).join(', ')
    return `No guidance pack named "${id}". Valid packs: ${validIds}`
  }
  return `# ${pack.title}\n\n${pack.body}`
}

export function getPackBody(id: string): string | null {
  loadIfNeeded()
  const pack = packs.find((p) => p.id === id)
  return pack ? pack.body : null
}

/**
 * Format a live page-context snapshot (from the browser store) into a concise
 * "Current state" paragraph the AI can use to address real node/page IDs.
 */
function formatSnapshot(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') return ''
  const s = snapshot as Record<string, unknown>
  const page = s.page as Record<string, unknown> | undefined
  const site = s.site as Record<string, unknown> | undefined
  const currentDoc = s.currentDocument as Record<string, string> | undefined
  const selected = s.selectedNodeId as string | null
  const activeBp = s.activeBreakpointId as string | undefined

  const parts: string[] = []

  if (page) {
    parts.push(`Active page: "${page.title}" (id=${page.id}, slug=${page.slug ?? '(none)'}, root=${page.rootNodeId ?? '(empty)'})`)
  }
  if (currentDoc) {
    parts.push(`Current document: ${currentDoc.type}:${currentDoc.id}`)
  }
  if (selected) {
    parts.push(`Selected node: ${selected}`)
  }
  if (activeBp) {
    parts.push(`Active breakpoint: ${activeBp}`)
  }

  // Page list (compact)
  const pages = site?.pages as Array<Record<string, unknown>> | undefined
  if (pages && pages.length > 0) {
    const pageList = pages
      .map((p) => `${p.id}=${p.slug || '(no-slug)'}${p.id === page?.id ? ' (active)' : ''}`)
      .join(', ')
    parts.push(`Pages: [${pageList}]`)
  }

  // Token digest (compact)
  const colorTokens = site?.colorTokens as Array<Record<string, unknown>> | undefined
  if (colorTokens && colorTokens.length > 0) {
    const colors = colorTokens.map((c) => `${c.slug}=${c.lightValue}`).join(', ')
    parts.push(`Colors: ${colors}`)
  }
  const typeScales = site?.typeScales as Record<string, unknown> | undefined
  if (typeScales && Object.keys(typeScales).length > 0) {
    parts.push(`Type scales: ${Object.keys(typeScales).join(', ')}`)
  }
  const spacingScales = site?.spacingScales as Record<string, unknown> | undefined
  if (spacingScales && Object.keys(spacingScales).length > 0) {
    parts.push(`Spacing scales: ${Object.keys(spacingScales).join(', ')}`)
  }

  if (parts.length === 0) return ''
  return `--- Current state ---\n${parts.join(' · ')}\nUse the real page/node ids above. Never invent ids.`
}

export function buildInjectedPrompt(userText: string, snapshot?: unknown): string {
  loadIfNeeded()
  const base = getBase()
  const manifest = buildManifest()
  const preLoadedId = classify(userText)
  const preLoadedBody = getPackBody(preLoadedId) ?? ''
  const snapshotText = snapshot ? formatSnapshot(snapshot) : ''

  const parts: string[] = [
    base,
    '',
    manifest,
    '',
    `--- Pre-loaded guidance: ${preLoadedId} ---`,
    preLoadedBody,
    '',
  ]

  if (snapshotText) {
    parts.push(snapshotText, '')
  }

  parts.push(
    'If the request involves additional areas (e.g., SEO, data tables, publishing), call the get_guidance tool with the relevant pack id to load detailed instructions before acting.',
    '',
    '--- User request ---',
    userText,
  )

  return parts.join('\n')
}

/**
 * Lightweight follow-up prompt for messages after the first in a session.
 * Avoids re-injecting the full base guidance every turn — the model already
 * has the context. We only remind it of the available packs and the user text.
 */
export function buildFollowUpPrompt(userText: string, snapshot?: unknown): string {
  loadIfNeeded()
  const manifest = buildManifest()
  const preLoadedId = classify(userText)
  const snapshotText = snapshot ? formatSnapshot(snapshot) : ''

  const parts: string[] = [
    'You are continuing a conversation in the Instatic CMS via MCP tools.',
    'Refer to earlier context for design tokens, page structure, and current state.',
    '',
    manifest,
    '',
  ]

  if (snapshotText) {
    parts.push(snapshotText, '')
  }

  parts.push(
    `If the request involves ${preLoadedId}, you already have that guidance loaded.`,
    'For other areas (SEO, data tables, publishing, etc.), call get_guidance with the pack id.',
    '',
    '--- User request ---',
    userText,
  )

  return parts.join('\n')
}

export function listPackIds(): string[] {
  loadIfNeeded()
  return packs.map((p) => p.id)
}
