import { useEffect, useState } from 'react'

const RELAY_URL = 'http://localhost:9876'
const POLL_INTERVAL_MS = 5_000

export interface RelayStatus {
  connected: boolean
  windsurfConnected: boolean
}

/**
 * Poll the local Instatic relay daemon's /health endpoint and return whether
 * it (and optionally the Windsurf language server) is reachable. Used to show
 * a live connection dot next to the Cascade provider in the model picker.
 */
export function useRelayStatus(enabled = true): RelayStatus {
  const [status, setStatus] = useState<RelayStatus>({
    connected: false,
    windsurfConnected: false,
  })

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    async function check() {
      try {
        const res = await fetch(`${RELAY_URL}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(3_000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json() as { ok?: boolean; windsurfConnected?: boolean }
        if (!cancelled) {
          setStatus({
            connected: body.ok === true,
            windsurfConnected: body.windsurfConnected === true,
          })
        }
      } catch {
        if (!cancelled) {
          setStatus({ connected: false, windsurfConnected: false })
        }
      }
    }

    check()
    const interval = setInterval(check, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [enabled])

  return status
}
