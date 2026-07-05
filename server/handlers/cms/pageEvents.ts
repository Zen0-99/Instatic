/**
 * `GET /admin/api/cms/pages/events` — Server-Sent Events stream of page
 * lifecycle events.
 *
 * Emits `page.updated` whenever the import-html endpoint creates or
 * updates a page. The editor client subscribes and refreshes the active
 * page canvas in real time.
 */

import { methodNotAllowed } from '../../http'
import { CMS_API_PREFIX } from './shared'
import { subscribePageEvents } from './pageEventBroadcaster'

export function handlePageEventsStream(req: Request): Response | null {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/pages/events`) return null
  if (req.method !== 'GET') return methodNotAllowed()
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      function send(payload: string): void {
        try {
          controller.enqueue(encoder.encode(payload))
        } catch {
          // Stream already closed (client gone).
        }
      }

      // Initial ping so the client sees a successful connection immediately.
      send(`event: ping\ndata: connected\n\n`)

      const unsubscribe = subscribePageEvents((event) => {
        send(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)
      })

      // Heartbeat keeps proxies + the EventSource itself happy.
      const heartbeat = setInterval(() => {
        send(`: heartbeat\n\n`)
      }, 30_000)

      req.signal.addEventListener('abort', () => {
        unsubscribe()
        clearInterval(heartbeat)
        try { controller.close() } catch { /* already closed */ }
      })
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}
