**Messages.app MCP Server**

This repository provides a Model Context Protocol (MCP) server that lets AI clients interact with the macOS Messages.app: list chats, read recent messages (read‑only), and send new messages.

Features
- List recent chats with participants (from `~/Library/Messages/chat.db`).
- Get recent messages for a chat or participant.
- Send messages via AppleScript (iMessage/SMS).
- Search messages by text with optional scoping and filters; results include ISO timestamps and message-type hints.
- Pull focused context windows around a specific message to minimize tokens.
- Fetch attachment metadata and resolved file paths on demand with strict per-message caps.
- Opt-in read-only mode to disable `send_text` when you only need to browse history.

Requirements
- macOS with Messages.app set up.
- Node.js 18+.
- Grant Full Disk Access to your terminal app (or the process running the server) so it can read `~/Library/Messages/chat.db`.

Install
- `npm install`
- `npm run build`

Run
- `npm start` (stdio MCP server)

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
- `send_text({ recipient: string, text: string })`
  - Disabled automatically when `MESSAGES_MCP_READONLY=true`.
- `search_messages({ query: string, chat_id|participant|from/to unix, ... })`
  - Requires at least one scope filter to prevent whole-database scans. Returns structured results with snippets, timestamps, and metadata.
- `search_messages_safe({ query: string, chat_id?|participant?|days_back?, ... })`
  - Convenience wrapper that auto-bounds the time range.
- `context_around_message({ message_rowid: number, before?: number=10, after?: number=10, include_attachments_meta?: boolean })`
  - Emits normalized messages with attachments metadata for the requested window.
- `get_attachments({ message_rowids: number[], per_message_cap?: number=5 })`
  - Resolves attachment transfer names, MIME types, byte sizes, and absolute file paths (still read-only).
- `doctor()`
  - Structured environment diagnostics with actionable remediation notes.

Responses mask recipients by default. To reveal full recipients in responses, set env var `MESSAGES_MCP_SHOW_FULL_RECIPIENTS=true` before starting the server.

Structured Output
- For `list_chats` and `get_messages`, the server now returns both:
  - `structuredContent` validated against an `outputSchema` (for clients that support it), and
  - a text fallback containing pretty‑printed JSON for broad compatibility.

Notes
- Reading uses the system `sqlite3` CLI in read-only mode with JSON output. If you see a permissions error, grant Full Disk Access and try again.
- Message timestamps are converted from Apple epoch to UNIX milliseconds and exposed as both UNIX + ISO strings.
- Search prefers the plain `message.text` column but transparently decodes `attributedBody` blobs for matches when possible.
- Attachment metadata is surfaced via `get_messages`/`context_around_message` hints; full paths remain opt-in through `get_attachments`.

Development
- `npm run dev` to run from source via ts-node.
- `npm run build` to emit `dist/` and run with `npm start`.
 - `npm run inspector` to launch MCP Inspector against the built server (optional helper).

Security
- No network calls are made; everything runs locally. The server only reads from Messages.db and uses AppleScript to send messages.
- Set `MESSAGES_MCP_READONLY=true` to start the server without any send capability (all tools become read-only).
- By default, tool responses mask recipients to reduce accidental exposure in logs. You can opt in to full recipients locally via `MESSAGES_MCP_SHOW_FULL_RECIPIENTS=true`. Do not commit any logs containing personal data.
