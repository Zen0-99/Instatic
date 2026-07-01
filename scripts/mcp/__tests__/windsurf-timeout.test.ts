/**
 * WindsurfClient fetch-timeout test.
 *
 * Validates strategies for aborting a hanging HTTP connection.  On Bun/Windows
 * neither AbortSignal.timeout nor AbortController.abort() reliably tear down a
 * fetch that is waiting on a server that has accepted the connection but never
 * sends a response byte.  The robust workaround is Promise.race with an
 * independent timer that rejects, letting the caller continue even if the
 * underlying fetch leaks in the background.
 */

import { describe, it, expect } from 'bun:test'

async function createHungServer(): Promise<{ url: string; stop: () => void }> {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch() {
      return new Promise(() => {}) as any
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

// ---------------------------------------------------------------------------

describe('WindsurfClient fetch timeout', () => {
  it('AbortSignal.timeout is NOT reliable on Bun/Windows for blocking responses', async () => {
    const { url, stop } = await createHungServer()
    try {
      const start = Date.now()
      const promise = fetch(url, {
        method: 'POST',
        body: 'test',
        signal: AbortSignal.timeout(50),
      })
      await expect(
        Promise.race([
          promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('SAFETY_TIMEOUT')), 500),
          ),
        ]),
      ).rejects.toThrow('SAFETY_TIMEOUT')
      expect(Date.now() - start).toBeGreaterThanOrEqual(400)
    } finally {
      stop()
    }
  })

  it('AbortController is also NOT reliable on Bun/Windows for blocking responses', async () => {
    const { url, stop } = await createHungServer()
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 50)
      const start = Date.now()
      const promise = fetch(url, {
        method: 'POST',
        body: 'test',
        signal: controller.signal,
      })
      await expect(
        Promise.race([
          promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('SAFETY_TIMEOUT')), 500),
          ),
        ]),
      ).rejects.toThrow('SAFETY_TIMEOUT')
      expect(Date.now() - start).toBeGreaterThanOrEqual(400)
    } finally {
      stop()
    }
  })

  it('Promise.race with an explicit timer lets the caller continue even if fetch leaks', async () => {
    const { url, stop } = await createHungServer()
    try {
      const fetchPromise = fetch(url, {
        method: 'POST',
        body: 'test',
      })
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('POLL_TIMEOUT')), 50),
      )
      const start = Date.now()
      await expect(Promise.race([fetchPromise, timeoutPromise])).rejects.toThrow('POLL_TIMEOUT')
      expect(Date.now() - start).toBeLessThan(150)
    } finally {
      stop()
    }
  })
})
