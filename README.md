**Messages.app MCP Server**

This repository provides a Model Context Protocol (MCP) server that lets AI clients interact with the macOS Messages.app: list chats, read recent messages (read‑only), and send new messages.

Features
- List recent chats with participants (from `~/Library/Messages/chat.db`).
- Get recent messages for a chat or participant.
- Send messages via AppleScript (iMessage/SMS).

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
- Quick send helper: `npm run send -- [--reveal|-r] "+1XXXXXXXXXX" "Hello"`
  - Default output masks recipients in console.
  - Use `--reveal` to print the full recipient locally.
  - The repo `.gitignore` excludes `*.log`; avoid committing any logs containing phone numbers/emails.

Integrate (Claude Desktop example)
- Add to `claude_desktop_config.json` under `mcpServers`:
  {
    "messages": {
      "command": "/absolute/path/to/messages.app-mcp/dist/index.js"
    }
  }
- Or point to the Node entry with args: {"command":"node","args":["/abs/path/dist/index.js"]}.

-Exposed Tools
- `list_chats(limit?: number=50)` → Returns array with `chat_id`, `guid`, `display_name`, `participants[]`, `last_message_unix_ms`.
- `get_messages({ chat_id?: number, participant?: string, limit?: number=50 })` → Recent messages for a chat or participant handle.
  - `send_text({ recipient: string, text: string })` → Sends text via Messages.app. Use E.164 numbers like `+14155551212` or iMessage email handles.
  - Responses mask recipients by default. To reveal full recipients in responses, set env var `MESSAGES_MCP_SHOW_FULL_RECIPIENTS=true` before starting the server.

Structured Output
- For `list_chats` and `get_messages`, the server now returns both:
  - `structuredContent` validated against an `outputSchema` (for clients that support it), and
  - a text fallback containing pretty‑printed JSON for broad compatibility.

Notes
- Reading uses the system `sqlite3` CLI in read‑only mode with JSON output. If you see a permissions error, grant Full Disk Access and try again.
- Message timestamps are converted from Apple epoch to UNIX milliseconds.
- Attachments and rich message bodies aren’t surfaced yet.

Development
- `npm run dev` to run from source via ts-node.
- `npm run build` to emit `dist/` and run with `npm start`.

Security
- No network calls are made; everything runs locally. The server only reads from Messages.db and uses AppleScript to send messages.
 - By default, tool responses mask recipients to reduce accidental exposure in logs. You can opt in to full recipients locally via `MESSAGES_MCP_SHOW_FULL_RECIPIENTS=true`. Do not commit any logs containing personal data.
