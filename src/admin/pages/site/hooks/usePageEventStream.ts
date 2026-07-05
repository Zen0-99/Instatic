/**
 * Page event stream — subscribes to the server's
 * `/admin/api/cms/pages/events` SSE endpoint and refreshes the active
 * page when a `page.updated` event arrives for the page currently open in
 * the canvas.
 *
 * The browser's EventSource auto-reconnects on transport errors with
 * native exponential backoff.
 */

import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { pageFromRow } from '@core/data/pageFromRow'

interface PageUpdatedEvent {
  kind: 'page.updated'
  pageId: string
  slug: string
}

export function usePageEventStream(): void {
  const activePageId = useEditorStore((s) => s.activePageId)

  useEffect(() => {
    if (!activePageId) return

    const source = new EventSource('/admin/api/cms/pages/events', {
      withCredentials: true,
    })

    function handlePageUpdated(event: MessageEvent) {
      try {
        const payload = JSON.parse(event.data) as PageUpdatedEvent
        if (payload.kind !== 'page.updated') return
        if (payload.pageId !== activePageId) return

        // Fetch fresh page data and surgically replace the active page.
        void refreshActivePageFromServer()
      } catch (err) {
        console.error('[page-events] failed to parse event:', err)
      }
    }

    source.addEventListener('page.updated', handlePageUpdated)

    source.addEventListener('error', (err) => {
      console.error('[page-events] EventSource error:', err)
    })

    return () => {
      source.removeEventListener('page.updated', handlePageUpdated)
      source.close()
    }
  }, [activePageId])
}

async function refreshActivePageFromServer(): Promise<void> {
  try {
    const res = await fetch('/admin/api/cms/pages', {
      credentials: 'include',
      cache: 'no-store',
    })
    if (!res.ok) return
    const body = (await res.json()) as { rows?: unknown[] }
    const rows = (body.rows ?? []) as Array<Record<string, unknown> & { id: string }>
    const pages = rows.map((r) =>
      pageFromRow(r as Parameters<typeof pageFromRow>[0]),
    )
    const { activePageId, refreshActivePage } = useEditorStore.getState()
    const freshPage = pages.find((p) => p.id === activePageId)
    if (freshPage) {
      refreshActivePage(freshPage)
    }
  } catch (err) {
    console.error('[page-events] Active page refresh failed:', err)
  }
}
