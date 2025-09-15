**Messages.app MCP Server**

This repository provides a Model Context Protocol (MCP) server that lets AI clients interact with the macOS Messages.app: list chats, read recent messages (read‑only), and send new messages.

Features
- List recent chats with participants (from `~/Library/Messages/chat.db`).
- Get recent messages for a chat or participant.
- Send messages via AppleScript (iMessage/SMS).
- Search messages by text with optional scoping and filters.
- Pull focused context windows around a specific message to minimize tokens.

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
- `list_chats(limit?: number=50)` → Returns array with `chat_id`, `guid`, `display_name`, `participants[]`, `last_message_unix_ms`.
- `get_messages({ chat_id?: number, participant?: string, limit?: number=50 })` → Recent messages for a chat or participant handle.
  - `send_text({ recipient: string, text: string })` → Sends text via Messages.app. Use E.164 numbers like `+14155551212` or iMessage email handles.
  - `search_messages({ query: string, chat_id?: number, participant?: string, from_unix_ms?: number, to_unix_ms?: number, from_me?: boolean, has_attachments?: boolean, limit?: number=50, offset?: number=0 })` → Find messages matching text with filters. Returns `message_rowid`, `chat_id`, `snippet`, timestamps, and flags.
  - `context_around_message({ message_rowid: number, before?: number=10, after?: number=10 })` → Returns a small, ordered window of messages around the anchor to give Codex just-in-time context without sending entire threads.
  - Responses mask recipients by default. To reveal full recipients in responses, set env var `MESSAGES_MCP_SHOW_FULL_RECIPIENTS=true` before starting the server.
  - `doctor()` → Runs environment checks and returns a structured report with:
    - `services`/`accounts` reported by Messages (e.g., iMessage, SMS)
    - `iMessage_available` and `sms_available`
    - `sqlite_access` and the `db_path` checked
    - `notes[]` with recommended fixes (Full Disk Access, Text Message Forwarding, etc.)

Structured Output
- For `list_chats` and `get_messages`, the server now returns both:
  - `structuredContent` validated against an `outputSchema` (for clients that support it), and
  - a text fallback containing pretty‑printed JSON for broad compatibility.

Notes
- Reading uses the system `sqlite3` CLI in read‑only mode with JSON output. If you see a permissions error, grant Full Disk Access and try again.
- Message timestamps are converted from Apple epoch to UNIX milliseconds.
- Search operates on the plain `message.text` column; rich `attributedBody` blobs are not searched.
- Attachments and rich message bodies aren’t surfaced yet.

Development
- `npm run dev` to run from source via ts-node.
- `npm run build` to emit `dist/` and run with `npm start`.
 - `npm run inspector` to launch MCP Inspector against the built server (optional helper).

Security
- No network calls are made; everything runs locally. The server only reads from Messages.db and uses AppleScript to send messages.
 - By default, tool responses mask recipients to reduce accidental exposure in logs. You can opt in to full recipients locally via `MESSAGES_MCP_SHOW_FULL_RECIPIENTS=true`. Do not commit any logs containing personal data.
