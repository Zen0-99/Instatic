# Plan: Paste images into the CMS agent panel

## Summary
Let users paste images (e.g. a screenshot/mockup) into the agent composer. The image is attached to the user message as a base64 data URL, sent to the server, and forwarded to **vision-capable models** (native providers — Anthropic/OpenAI/OpenRouter/Ollama all already map image blocks to native multimodal content). The image is persisted and replayed on every turn, and rendered as a thumbnail in the thread.

**Key finding:** the server already supports image blocks end-to-end (drivers userContent() handle {kind:'image'}; AiContentBlockSchema persists them; buildMessageHistory replays them verbatim). The work is almost entirely on the **ingest + UI** side.

## Data flow
1. Browser: paste event → read image File → base64 data URL → local pendingImages state → thumbnail tray above the textarea.
2. On send: sendAgentMessage(content, images) builds a user message with text + image blocks, and the native path POSTs images in AgentRequestBody; the cascade path includes them in the relay body.
3. Server (native): chat.ts appends the user message with image blocks → driver maps to native multimodal content → model sees the image. Persisted + replayed on follow-ups.
4. Cascade (Windsurf): relay persists image blocks for thread display; Windsurf itself receives text only (its sendMessage protobuf is text-only). **Documented limitation** — I'll surface a note when the active provider is cascade and images are attached.

## Files to change

### Browser / types
- **src/admin/pages/site/agent/types.ts**
  - Add AgentImageAttachment = { mimeType: string; data: string } (base64, no data: prefix).
  - Add | { kind: 'image'; mimeType: string; data: string } to AgentMessageBlock.
  - Add images?: AgentImageAttachment[] to AgentRequestBody.

- **src/admin/pages/site/agent/agentSliceTypes.ts**
  - Change sendAgentMessage(content: string, images?: AgentImageAttachment[]): Promise<void>.

- **src/admin/pages/site/agent/agentSlice.ts** (sendAgentMessage)
  - Build user message blocks: a text block (if any) + one image block per attachment.
  - Native path: include images in the AgentRequestBody POST body.
  - Cascade path: include images in the /chat/message body, and include image blocks in the appendConversationMessage persistence call (currently only {kind:'text'}).

- **src/admin/pages/site/agent/agentApi.ts** (rehydrateMessages)
  - Handle image blocks (currently skipped with a "v1" comment) so reloaded conversations show pasted images.

### UI
- **src/admin/pages/site/panels/AgentPanel/AgentPanel.tsx**
  - onPaste handler on the Textarea capturing clipboardData.items/files of type.startsWith('image/'); convert to data URL; cap size (~10MB) + allowed MIME (png/jpeg/webp/gif) → reject with pushToast otherwise.
  - Local pendingImages state + a thumbnail tray (with remove buttons) rendered above the textarea.
  - Pass pendingImages to sendAgentMessage, then clear.
  - Soft warning when activeModel.visionInput === false and images are attached (model can't see them).
  - groupRenderItems + MessageBubble: add an image render item + UserImageBubble so user-pasted images render as thumbnails in the thread.

- **src/admin/pages/site/panels/AgentPanel/AgentPanel.module.css**
  - Styles for the attachment tray + thumbnail (reuse existing .toolCallScreenshot aesthetic).

### Server
- **server/ai/handlers/chat.ts**
  - Add images to ChatRequestBodySchema (array of { mimeType: string; data: string }, validated/length-capped).
  - Make prompt optional; require ≥1 of text/image; append user message with image blocks alongside text.

### Relay (cascade)
- **scripts/mcp/relay-daemon.ts**
  - Accept images in the /chat/message body (typed) and pass through to persistence; Windsurf still gets text only (noted).

## Validation & limits
- Allowed MIME: image/png | image/jpeg | image/webp | image/gif.
- Per-image cap ~10MB (base64); reject with toast.
- Vision warning when selected model lacks visionInput.

## Tests / verification
- bun run test (existing agentSlice.test.ts keeps working — images? is optional; aiAssistant.ts spotlight call unaffected).
- Add a chat-handler test asserting an image block is persisted on the user message.
- Manual: bun run dev, open agent panel, paste a screenshot, send with a vision model (e.g. Claude), confirm the model references the image; reload conversation and confirm the thumbnail reappears.

## Out of scope
- Drag-and-drop file upload (paste only, per request).
- Client-side image downscaling/compression (can add later if size is an issue).
- Forwarding images into Windsurf's Cascade model (protobuf is text-only; documented limitation).