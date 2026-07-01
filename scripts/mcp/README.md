# Instatic MCP Server

Hybrid MCP server bridging Windsurf Cascade with the Instatic CMS.

## Architecture

```
┌─────────────────┐     stdio/MCP      ┌──────────────────┐
│  Windsurf IDE   │ ◄──────────────── │  MCP Server      │
│  (Cascade)      │ ──────────────►   │  (server.ts)     │
└─────────────────┘                    │                  │
                                       │  ┌────────────┐  │
┌─────────────────┐   HTTP POST/SSE   │  │ HTTP Relay │  │
│  CMS Admin App  │ ──────────────►   │  │ (port 9876)│  │
│  (chat panel)   │ ◄──────────────   │  └────────────┘  │
└─────────────────┘                    │                  │
                                       │  ┌────────────┐  │
┌─────────────────┐   Playwright       │  │ Browser    │  │
│  CMS Admin App  │ ◄──────────────   │  │ Bridge     │  │
│  (in browser)   │ ──────────────►   │  └────────────┘  │
└─────────────────┘                    │                  │
                                       │  ┌────────────┐  │
┌─────────────────┐   HTTP REST        │  │ CMS Client │  │
│  CMS API Server │ ◄──────────────   │  │            │  │
│  (port 3001)    │ ──────────────►   │  └────────────┘  │
└─────────────────┘                    └──────────────────┘
```

## Files

- `tool-registry.ts` — All MCP tool definitions with TypeBox schemas
- `cms-client.ts` — HTTP client for CMS REST API with session auth
- `http-tools.ts` — Dispatcher mapping HTTP API tool names to CMS client calls
- `browser-bridge.ts` — Playwright browser automation for browser-bridged tools
- `windsurf-client.ts` — gRPC client for Windsurf language server (Cascade chat)
- `chat-relay.ts` — In-memory message queue for CMS ↔ Cascade chat relay
- `server.ts` — Main entry point: MCP stdio loop + HTTP relay server

## Setup

1. Ensure the CMS API server is running on `http://localhost:3001`
2. Ensure the CMS admin app is running on `http://localhost:5173`
3. Install Playwright browsers: `bunx playwright install chromium`
4. Set environment variables (or use config interpolation in `mcp_config.json`):
   - `INSTATIC_ADMIN_EMAIL` — CMS admin login email
   - `INSTATIC_ADMIN_PASSWORD` — CMS admin login password

**Do not run `bun run scripts/mcp/server.ts` manually.** Windsurf starts the MCP server automatically via stdio when configured in `mcp_config.json`. The HTTP relay on port 9876 is started by that Windsurf-spawned instance.

## Windsurf MCP Configuration

The file `~/.codeium/windsurf/mcp_config.json` should contain:

```json
{
  "mcpServers": {
    "instatic": {
      "command": "bun",
      "args": ["run", "/path/to/Instatic/scripts/mcp/server.ts"],
      "env": {
        "INSTATIC_CMS_URL": "http://localhost:3001",
        "INSTATIC_ADMIN_URL": "http://localhost:5173",
        "INSTATIC_ADMIN_EMAIL": "${INSTATIC_ADMIN_EMAIL}",
        "INSTATIC_ADMIN_PASSWORD": "${INSTATIC_ADMIN_PASSWORD}",
        "INSTATIC_MCP_PORT": "9876"
      }
    }
  }
}
```

## Tool Categories

### Browser-bridged tools (via Playwright → window.__instaticAgent.executeTool)
- `insertHtml`, `replaceNodeHtml`, `getNodeHtml`, `deleteNode`, `duplicateNode`
- `updateNodeProps`, `moveNode`, `renameNode`, `assignClass`, `removeClass`
- `applyCss`, `addPage`, `deletePage`, `duplicatePage`, `renamePage`
- `setPageTemplate`, `clearPageTemplate`, `render_snapshot`
- `open_document`, `inspect_code_runtime`
- `set_color_tokens`, `set_font_tokens`, `set_spacing_scale`, `set_type_scale`
- `write_code_asset`, `read_code_asset`, `patch_code_asset`
- `cms_publish`, `cms_publish_status`

### HTTP API tools (via CMS REST API)
- `cms_get_site`, `cms_save_site`, `cms_list_pages`, `cms_save_pages`
- `cms_list_data_tables`, `cms_list_data_rows`, `cms_create_data_row`
- `cms_get_data_row`, `cms_save_data_row`, `cms_delete_data_row`, `cms_publish_data_row`

### Chat relay tools
- `get_cms_chat_messages` — Poll for pending CMS chat messages
- `send_cms_chat_response` — Send a response back to the CMS chat panel

## CMS Chat Panel Toggle

The AgentPanel has a toggle button (AI icon) that switches between:
- **OFF** (default): Native AI provider (streaming NDJSON to `/admin/api/ai/chat/${scope}`)
- **ON**: IDE Cascade relay (POST to `http://localhost:9876/chat/message` + SSE stream)

When ON, messages route through the MCP server's HTTP relay using a **dual-path** architecture:

**Primary path (direct Connect-RPC):**
1. The HTTP relay forwards the message directly to the Windsurf language server via Connect-RPC
2. Cascade in the IDE processes the message and can use any Instatic tool
3. The AI model's tool calls are routed through the registered MCP server
4. Responses stream back to the CMS via SSE on `/chat/stream/:id`

**Secondary path (MCP tool queue):**
1. When the language server is unreachable, messages queue for Cascade to pick up via `get_cms_chat_messages`
2. Cascade calls the tool, processes the message, and sends responses via `send_cms_chat_response`

Both paths provide full tool access because Windsurf routes tool calls through the registered MCP server.
