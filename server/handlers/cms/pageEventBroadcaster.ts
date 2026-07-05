/**
 * Page event broadcaster — singleton fan-out from the CMS import-html
 * handler to subscribed admin clients via SSE.
 *
 * When a page is created or updated via the import-html endpoint, it
 * broadcasts a `page.updated` event so every connected editor tab can
 * refresh the active page without a manual reload.
 */

export interface PageEvent {
  kind: 'page.updated'
  pageId: string
  slug: string
}

type PageEventListener = (event: PageEvent) => void

const listeners = new Set<PageEventListener>()

/**
 * Subscribe to page events. Returns an unsubscribe function.
 */
export function subscribePageEvents(listener: PageEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Fire a page event to every current subscriber.
 */
export function broadcastPageEvent(event: PageEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (err) {
      console.error('[page-events] subscriber threw:', err)
    }
  }
}
