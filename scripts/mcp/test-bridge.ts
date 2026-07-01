/**
 * Standalone health check — verifies the MCP HTTP relay is running and
 * the Windsurf language server is connected. Browser tools now ride the
 * SSE stream (no separate bridge process to test).
 */
const MCP_PORT = process.env.INSTATIC_MCP_PORT ?? '9876'

async function main() {
  const url = `http://localhost:${MCP_PORT}/health`
  console.log('Checking MCP relay health:', url)

  try {
    const res = await fetch(url)
    const body = await res.json() as { ok: boolean; windsurfConnected: boolean }
    console.log('Status:', res.status, body)
    if (!body.ok) process.exit(1)
    console.log(body.windsurfConnected ? 'Windsurf: connected' : 'Windsurf: NOT connected')
  } catch (err) {
    console.error('Health check failed:', err)
    process.exit(1)
  }

  process.exit(0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
