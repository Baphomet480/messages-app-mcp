**Messages.app MCP Server**

This repository provides a Model Context Protocol (MCP) server that lets AI clients interact with the macOS Messages.app: list chats, read recent messages (read‑only), and send new messages.

Features
- List recent chats with participants (from `~/Library/Messages/chat.db`).
- Get recent messages for a chat or participant.
- Send messages via AppleScript (iMessage/SMS) by recipient, chat GUID, or Messages display name.
- Send attachments with optional captions using the same targeting options as `send_text`.
- Decode `attributedBody` typedstreams via `imessage-parser` to recover formatted text, mentions, and attachment hints.
- Search messages by text with optional scoping and filters; results include ISO timestamps and message-type hints.
- Pull focused context windows around a specific message to minimize tokens.
- Fetch attachment metadata and resolved file paths on demand with strict per-message caps.
- Generate AppleScript handler templates for incoming/outgoing events to “push” notifications into other tools.
- Opt-in read-only mode to disable `send_text`/`send_attachment` when you only need to browse history.
- Optional HTTP transport (Streamable HTTP with legacy SSE fallback) for remote MCP connectors like ChatGPT Pro / Deep Research.
- Connector-friendly `search` / `fetch` tools that emit JSON strings exactly as the MCP spec expects for remote integrations.

Requirements
- macOS with Messages.app set up.
- Node.js 18+.
- Grant Full Disk Access to your terminal app (or the process running the server) so it can read `~/Library/Messages/chat.db`.

Install
- `npm install`
- `npm run build`

Run
- `npm start` (stdio MCP server)
- HTTP / connector mode: `node dist/index.js --http --port 3333 --cors-origin https://chat.openai.com`
  - Sets up Streamable HTTP endpoints at `/mcp` with optional SSE fallback (add `--enable-sse` if you need legacy clients).
  - Provide an externally reachable hostname (e.g., behind a reverse proxy) and expose the `Mcp-Session-Id` header.
  - Set `MESSAGES_MCP_CONNECTOR_BASE_URL=https://your-domain.example/mcp` so the new `search`/`fetch` tools return URLs that match your deployment.

CLI
- After `npm run build`, a `messages-mcp` binary is available: `npx messages-mcp` or `./node_modules/.bin/messages-mcp`.
- Quick send helper: `npm run send -- "+1XXXXXXXXXX" "Hello"`
  - Default output shows full recipient; use `--mask` to mask locally.
  - The repo `.gitignore` excludes `*.log`; avoid committing any logs containing phone numbers/emails.
 - Environment check: `npm run doctor` or `npm run doctor -- --json`
   - Verifies AppleScript availability, Messages services/accounts (iMessage/SMS), and read access to `chat.db`.
   - Exits with non‑zero status if checks fail.

Integrate (Claude Desktop example)
- Add to `claude_desktop_config.json` under `mcpServers`:
  {
    "messages": {
      "command": "/absolute/path/to/messages.app-mcp/dist/index.js"
    }
  }
- Or point to the Node entry with args: `{"command":"node","args":["/abs/path/dist/index.js"]}`.

Remote MCP (ChatGPT Pro / Deep Research)
- Enable HTTP mode via CLI (`--http`, `--port`, `--host`) or env (`MESSAGES_MCP_HTTP_PORT`, `MESSAGES_MCP_HTTP_HOST`).
- Default transport is Streamable HTTP at `/mcp`. Add `--enable-sse` (or `MESSAGES_MCP_HTTP_ENABLE_SSE=1`) if you need the legacy `/sse`+`/messages` endpoints.
- CORS: set `--cors-origin https://chat.openai.com` (repeat flag to allow multiple origins) or `MESSAGES_MCP_HTTP_CORS_ORIGINS` (comma-separated). The server always exposes the `Mcp-Session-Id` header required by browser clients.
- DNS rebinding protection: toggle with `--enable-dns-protection` / `--disable-dns-protection` or `MESSAGES_MCP_HTTP_DNS_PROTECTION` and optionally `MESSAGES_MCP_HTTP_ALLOWED_HOSTS`.
- Tailor search defaults via `MESSAGES_MCP_CONNECTOR_DAYS_BACK` (default 30) and `MESSAGES_MCP_CONNECTOR_SEARCH_LIMIT` (default 20).
- Set `MESSAGES_MCP_CONNECTOR_BASE_URL` to the externally visible base (e.g., `https://example.net/mcp`) so connector search results return useful citation URLs.
- Connector tools:
  - `search` → returns `{ "results": [ { id, title, url, snippet, metadata } ] }` as a JSON string per MCP spec.
  - `fetch` → returns `{ id, title, text, url, metadata }` with optional context window controls (`context_before`, `context_after`).

-Inspector
- Use the MCP Inspector to poke tools locally (Node 22+ recommended):
  - Build first: `npm run build`
  - Quick launch: `npx @modelcontextprotocol/inspector node dist/index.js`
  - Or add a script: `"inspector": "npx @modelcontextprotocol/inspector node dist/index.js"` then run `npm run inspector`.
  - In the Inspector UI, call `doctor`, `list_chats`, `get_messages`, or `send_text`.

-Exposed Tools
- `list_chats({ limit?: number=50, participant?: string, updated_after_unix_ms?: number, unread_only?: boolean })`
  - Returns chat metadata with UNIX + ISO timestamps and unread counts.
- `get_messages({ chat_id?: number, participant?: string, limit?: number=50, context_anchor_rowid?: number, context_before?: number=10, context_after?: number=10, context_include_attachments_meta?: boolean })`
  - Messages include best-effort text (decoding `attributedBody` when needed), ISO timestamps, message type/subtype hints, and attachment previews. Optional inline context bundle avoids an extra `context_around_message` call.
- `send_text({ text: string, recipient?: string, chat_guid?: string, chat_name?: string })`
  - Provide at least one target field. Targets can be people (phone/email) or existing group chats by GUID/display name.
  - Disabled automatically when `MESSAGES_MCP_READONLY=true`.
  - Responses are structured JSON: the `structuredContent` object (and the text fallback) include a summary, target metadata, and recent normalized message rows pulled from chat history.
- `send_attachment({ file_path: string, caption?: string, recipient?|chat_guid?|chat_name? })`
  - Sends files via AppleScript after optional caption delivery. Ensure Messages has Full Disk Access in System Settings; otherwise the OS may show “Not Delivered.”
  - Read-only mode blocks this tool automatically.
  - Returns the same structured JSON shape as `send_text` plus an `attachment` descriptor (path, resolved filename, caption).
- `applescript_handler_template({ minimal?: boolean })`
  - Returns a starter AppleScript with `message received`, `message sent`, and `received file transfer invitation` handlers. Save it under `~/Library/Application Scripts/com.apple.iChat/` to enable “push” style automations (AppleScript handlers still have the ~10s execution limit).
- `search_messages({ query: string, chat_id|participant|from/to unix, ... })`
  - Requires at least one scope filter to prevent whole-database scans. Returns structured results with snippets, timestamps, and metadata.
- `search_messages_safe({ query: string, chat_id?|participant?|days_back?, ... })`
  - Convenience wrapper that auto-bounds the time range.
- `search({ query: string, chat_guid?, participant?, days_back?, limit? })`
  - Connector-safe search that always returns a JSON-string payload with `results[]` objects containing `id`, `title`, `url`, and snippets for ChatGPT Pro / Deep Research.
- `fetch({ id: string, context_before?: number=5, context_after?: number=5 })`
  - Retrieves the full text (and optional context window) for a search result `id`, formatted as a JSON string with metadata and connector-friendly citation URL.
- `context_around_message({ message_rowid: number, before?: number=10, after?: number=10, include_attachments_meta?: boolean })`
  - Emits normalized messages with attachments metadata for the requested window.
- `get_attachments({ message_rowids: number[], per_message_cap?: number=5 })`
  - Resolves attachment transfer names, MIME types, byte sizes, and absolute file paths (still read-only).
- `doctor()`
  - Structured environment diagnostics with actionable remediation notes.
  - Includes the current package version and git commit (if available) in the summary and structured payload.
- `about()`
  - Returns metadata about this MCP server, including the current version, git commit (when available), repository, and runtime environment details.

Set `MESSAGES_MCP_MASK_RECIPIENTS=true` to redact phone numbers/emails in tool responses (useful when logging remotely or demoing). Leave unset to show full recipients locally.

Structured Output
- For `list_chats`, `get_messages`, `send_text`, `send_attachment`, and `about`, the server now returns both:
  - `structuredContent` validated against an `outputSchema` (for clients that support it), and
  - a text fallback containing pretty‑printed JSON for broad compatibility.

Notes
- `imessage-parser` is used to decode `attributedBody` typedstreams, so rich-text, mentions, and attachment hints surface even when `message.text` is empty (falls back to a `plutil` heuristic if parsing fails).
- Reading uses the system `sqlite3` CLI in read-only mode with JSON output. If you see a permissions error, grant Full Disk Access and try again.
- Message timestamps are converted from Apple epoch to UNIX milliseconds and exposed as both UNIX + ISO strings.
- Search prefers the plain `message.text` column but transparently decodes `attributedBody` blobs for matches when possible.
- Attachment metadata is surfaced via `get_messages`/`context_around_message` hints; full paths remain opt-in through `get_attachments`.
- Messages.app enforces sandbox rules for attachments. Grant Messages Full Disk Access (System Settings → Privacy & Security → Full Disk Access) so it can read files you reference via AppleScript. Without it, you’ll see “Not Delivered.”

Development
- `npm run dev` to run from source via ts-node.
- `npm run build` to emit `dist/` and run with `npm start`.
 - `npm run inspector` to launch MCP Inspector against the built server (optional helper).

AppleScript Automations
- Messages supports AppleScript event handlers (e.g., `on message received`, `on message sent`, `on received file transfer invitation`). Save scripts under `~/Library/Application Scripts/com.apple.iChat/` and enable “Allow Scripts” in Messages → Settings.
- Call the `applescript_handler_template` tool to get a ready-to-customize script; set the `minimal` flag for a comment-free version.
- Handlers have a ~10s execution budget—delegate long work to background processes (CLI, MCP tool invocation, etc.) to avoid timeouts.
- Use a throttling layer if you log from handlers; Messages occasionally fires duplicate events for the active chat.

Security
- No network calls are made; everything runs locally. The server only reads from Messages.db and uses AppleScript to send messages.
- Set `MESSAGES_MCP_READONLY=true` to start the server without any send capability (all tools become read-only).
- Opt-in masking is available via `MESSAGES_MCP_MASK_RECIPIENTS=true` to reduce accidental exposure in logs. Do not commit any logs containing personal data.
