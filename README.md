# Messages.app MCP Server

[![CI](https://github.com/Baphomet480/messages-app-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Baphomet480/messages-app-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/messages-app-mcp.svg)](https://www.npmjs.com/package/messages-app-mcp)

A Model Context Protocol (MCP) server that lets AI assistants interact with macOS Messages.app—listing chats, reading conversation history (read only), and sending new iMessage/SMS content on demand.

## Table of Contents
- [Overview](#overview)
- [Key Features](#key-features)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Tool Reference](#tool-reference)
- [Configuration](#configuration)
- [Versioning & Support](#versioning--support)
- [Development](#development)
- [Testing](#testing)
- [Release Process](#release-process)
- [Security Notes](#security-notes)
- [Contributing](#contributing)
- [License](#license)

## Overview

`messages-app-mcp` exposes Messages.app over MCP transports (stdio and optional Streamable HTTP). The server is designed for local use: it reads `~/Library/Messages/chat.db` in read-only mode and delegates outgoing sends to AppleScript.

## Key Features

- Enumerate recent chats with unread counts that work across macOS schema changes.
- Fetch recent messages by chat, participant, or focused context windows with normalized timestamps/metadata.
- Send messages and attachments while receiving structured JSON responses that include delivery summaries and recent history.
- Full-text search with optional scoping and attachment hints.
- Rotating structured logs (repo-local by default) that capture search queries, send outcomes, and errors.
- Diagnostics via `doctor` and version metadata via the `about` tool.

## Requirements

- macOS with Messages.app configured (and opened at least once). Verified on macOS 26.0.1 (Sequoia); earlier releases should work as long as Messages.app exposes `chat.db`.
- Node.js 18 or newer (tested on Node 22 in CI).
- Terminal/iTerm (or whichever shell runs the server) must have **Full Disk Access** to read Messages data.

## Quick Start

```bash
pnpm install
pnpm run build
pnpm start # stdio MCP server
pnpm run start:http # optional: run HTTP/SSE MCP server on http://127.0.0.1:3338/mcp
```

During development you can run `pnpm run dev` (ts-node) and use the MCP Inspector:

```bash
pnpm run inspector
```

Helper scripts:

- `pnpm run send -- "+1XXXXXXXXXX" "Hello"` – send a quick test message.
- `pnpm run doctor` / `pnpm run doctor -- --json` – verify prerequisites.

### Install via pnpm

Once a release is published to the npm registry you can install or run the package directly with pnpm:

```bash
# one-shot usage
pnpm dlx messages-mcp --help

# or install globally
pnpm add -g messages-app-mcp
messages-mcp --help
```

The binary published on npm (installable via pnpm) is identical to `dist/index.js`; all runtime requirements (Full Disk Access, Node 18+) still apply.

## Tool Reference

| Tool | Description | Notes |
| ---- | ----------- | ----- |
| `about` | Returns version/build metadata, repository links, and runtime environment info. | Surface this in clients to confirm the deployed build. |
| `list_chats` | Lists recent chats with participants, unread counts, and last-activity timestamps (Apple epoch converted to UNIX/ISO). | Supports filters: `limit`, `participant`, `updated_after_unix_ms`, `unread_only`. |
| `get_messages` | Retrieves normalized message rows by `chat_id` or `participant`, optionally with contextual windows and attachment metadata. | Structured payload includes ISO timestamps, message types, and optional context bundle. |
| `recent_messages_by_participant` | Returns the most recent normalized messages for a participant handle (phone or email). | Use when you want the latest conversation history without providing a text query. |
| `send_text` | Sends text to a recipient/chat and returns a single-envelope JSON result with `ok`, `summary`, target, and recent messages. | Honors `MESSAGES_MCP_READONLY`; always returns the same envelope shape with `ok: false` on failure. |
| `send_attachment` | Sends a file (with optional caption) using the same targeting options as `send_text`. | Same envelope as `send_text`, with an optional `attachment` field. |
| `search_messages` / `search_messages_safe` | Full-text search with scoping options and convenience defaults to avoid whole DB scans. | Safe variant enforces day-based limits automatically. |
| `context_around_message` | Fetches a window of normalized messages around an anchor `message_rowid`. | Useful for tools that need surrounding context without large history fetches. |
| `summarize_window` | Summarize a window of messages around an anchor rowid with participant counts and trimmed lines. | Helpful for quick recap responses without fetching full history. |
| `get_attachments` | Resolves attachment metadata (names, MIME types, byte sizes, resolved paths) with strict per-message caps. | Always read-only. |
| `doctor` | Structured diagnostics covering AppleScript availability, Messages services, SQLite access, and version metadata. | Returns JSON + summary string; artifacts can be collected in CI. |
| `applescript_handler_template` | Generates a starter AppleScript for message events (received/sent/transfer). | Save under `~/Library/Application Scripts/com.apple.iChat/`. |
| `search` / `fetch` | Connector-friendly tools for ChatGPT Pro / Deep Research (Streamable HTTP mode). | Emit JSON strings matching MCP connector expectations. |

### Search scope & participants

- **`search`** (connector) accepts `query`, optional `chat_guid`, optional `participant` (phone/email handle *or* chat display name), `days_back` (capped at 365), and `limit`. Use it for lightweight snippets.
- **`search_messages`** exposes the full normalized rows and lets you mix `query`, `chat_id`, `participant`, and explicit Unix ranges (`from_unix_ms`/`to_unix_ms`). Pass `from_unix_ms: 0` to scan all history or scope to a participant handle/display name to chase a single contact.
- **`search_messages_safe`** enforces that you provide at least one of `chat_id`, `participant`, or `days_back`, and mirrors the same structured output.

Example (`search_messages` call over MCP stdio):

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "tools/call",
  "params": {
    "name": "search_messages",
    "arguments": {
      "query": "Alderaan",
      "participant": "+14805788164",
      "from_unix_ms": 0,
      "limit": 5
    }
  }
}
```

If a message body only exists in `attributedBody`, the MCP now decodes it into `text`/`snippet` so searches still match. Every invocation is logged (e.g. `[info] search_messages { query: 'Alderaan', participant: '+14805788164', result_count: 2 }`).

### Running over Streamable HTTP / SSE

Codex CLI v0.46+ can talk to this server over the [streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) transport. To try it locally:

1. Start the HTTP server:

   ```bash
   pnpm run build
   pnpm run start:http
   ```

   This listens on `http://127.0.0.1:3338/mcp` and enables the SSE fallback under `/sse`.

2. Update `~/.codex/config.toml`:

   ```toml
   experimental_use_rmcp_client = true

   [mcp_servers.messages]
   url = "http://127.0.0.1:3338/mcp"
   startup_timeout_sec = 20
   tool_timeout_sec = 60
   ```

3. Restart Codex CLI. The HTTP server can run in a separate terminal or under a process manager.

The legacy stdio transport (`pnpm start`) remains available if you prefer Codex to launch the server automatically.

## Configuration

### Logging

The server initialises a rotating file logger on startup. When launched inside a git repository, logs default to `./logs/messages-app-mcp/`; otherwise they land in `~/Library/Logs/messages-app-mcp/`. Messages are mirrored to stderr, keeping stdout reserved for JSON payloads while still surfacing activity in your terminal.

Tune logging with:

- `MESSAGES_MCP_LOG_DIR=/absolute/path` – override the log directory entirely.
- `MESSAGES_MCP_LOG_MAX_BYTES=5242880` – rotate once the active log exceeds this many bytes (default 5 MiB).
- `MESSAGES_MCP_LOG_MAX_FILES=5` – number of archived files to keep.

Logs note every `send_text` / `send_attachment` attempt (masked recipients), each `search*` invocation (query, scopes, result count), and any uncaught errors—handy when reproducing issues.

### Runtime environment

- `MESSAGES_MCP_READONLY=true` – disable `send_text`/`send_attachment` while keeping read tools enabled.
- `MESSAGES_MCP_MASK_RECIPIENTS=true` – mask phone numbers/emails in responses.
- `MESSAGES_MCP_HTTP_*` – configure optional Streamable HTTP transport (`PORT`, `HOST`, `ENABLE_SSE`, `CORS_ORIGINS`, etc.).
- `MESSAGES_MCP_CONNECTOR_DAYS_BACK=365`, `MESSAGES_MCP_CONNECTOR_LIMIT=20` – adjust defaults for the connector-facing `search`/`fetch` tools.

Grant Full Disk Access before running the server so SQLite reads succeed. Without it, `doctor` will warn and send tools will fail silently in Messages.app.

## Versioning & Support

- The current package version is tracked in `package.json` (current: `2.0.0`).
- The `about` and `doctor` tools expose the deployed version, git commit (when available), repository, and runtime information—ideal for client dashboards.
- Use semantic versioning: bump the minor version for new features, patch for fixes, and major if you introduce breaking changes to tool schemas.

## Development

- `pnpm run dev` starts the stdio server via ts-node.
- `pnpm run build` compiles TypeScript to `dist/`; run `pnpm start` to execute the compiled build.
- An MCP Inspector session can be launched with `pnpm run inspector`.
- Scripts are documented in `package.json`; use `pnpm run send` or `pnpm run doctor` for quick manual checks.

## Testing

- `pnpm test` runs Vitest with coverage (see `tests/utils/*.spec.ts`).
- Focus tests on edge cases: mixed chat schemas, Apple epoch conversions, structured response shapes.
- CI (GitHub Actions, macOS) runs install → test → build → doctor; keep workflows green before cutting a release.

## Release Process

1. Ensure `pnpm run build` and `pnpm test` pass locally.
2. Update documentation (this README, `CONTRIBUTING.md`) if tool contracts change.
3. Bump `package.json` and mention the change in your commit message/PR.
4. Tag releases after merging to `main`; the `about` tool will automatically reflect the new version and commit hash.
5. Publish to npm with `pnpm publish --access public` (or rely on the GitHub Actions release workflow which publishes when an `v*` tag is pushed and `NPM_TOKEN` is configured).
6. **Recommended dry run:** create a pre-release tag (e.g., `v1.1.0-rc1`) without `NPM_TOKEN` set to confirm the workflow completes build/test and exercises the “skip publish” path before cutting a public release.

## Tool Output Shapes (Stable)

To improve MCP client compatibility, mutating tools now use a single stable JSON envelope. Search/reader tools continue to use `{ results }` or structured documents.

### Send tools (breaking change in 1.x)

Both `send_text` and `send_attachment` return:

```json
{
  "ok": true,
  "summary": "Sent message to +1•••0000.",
  "target": {
    "recipient": "+15550000000",
    "chat_guid": null,
    "chat_name": null,
    "display": "+1•••0000"
  },
  "chat_id": 123,
  "latest_message": { /* normalized message */ },
  "recent_messages": [ /* normalized messages */ ],
  "lookup_error": null,
  "attachment": {
    "file_path": "/Users/me/Desktop/file.png",
    "file_label": "file.png",
    "caption": "optional caption"
  }
}
```

On failure, the same shape is returned with `ok: false` and `error` populated, while other fields may be null/omitted:

```json
{
  "ok": false,
  "summary": "Failed to send to +1•••0000. Permission denied",
  "target": { "recipient": "+15550000000", "chat_guid": null, "chat_name": null, "display": "+1•••0000" },
  "error": "Permission denied"
}
```

### Search (connectors) output

`search` returns `{ "results": [ { id, title, url?, snippet, metadata{ chat_id, from_me, sender, iso_utc, iso_local } } ] }` and `fetch` returns a structured document `{ id, title, text, url?, metadata{ ... } }` suitable for connectors.

### Reader outputs

- `list_chats`: `{ chats: [...] }`
- `get_messages`: `{ summary, messages, context? }`
- `context_around_message`: `{ messages: [...] }`
- `get_attachments`: `{ attachments: [...] }`
- `search_messages`/`search_messages_safe`: `{ results: [...] }`

### Diagnostics

- `doctor`: detailed environment object (see tool definition)
- `about`: version + repo metadata (see tool definition)

## Security Notes

- The MCP server runs locally; no external network calls are made by default. Any future outbound integration should be discussed first.
- Database access is strictly read-only via `/usr/bin/sqlite3 -readonly -json`.
- Do not log or commit sensitive chat content. Tests should rely on mocks or anonymized fixtures.

## Contributing

Please read the [contribution guidelines](CONTRIBUTING.md) for coding standards, testing expectations, and release practices. Conventional commits are encouraged (`feat:`, `fix:`, `docs:` …).

The repo-specific build/verify workflow is documented in [docs/reference/build-verify-guidance.md](docs/reference/build-verify-guidance.md); make sure to follow it when opening PRs.

## License

Released under the [MIT License](LICENSE).

---

## Appendix A – Client Configurations

These snippets show how to connect common MCP clients:

**Claude Desktop**

```json
{
  "mcpServers": {
    "messages": {
      "command": "pnpm",
      "args": ["dlx", "messages-mcp"]
    }
  }
}
```

**Cursor (`cursor.mcp.json`)**

```json
{
  "servers": {
    "messages": {
      "command": "messages-mcp",
      "args": [],
      "enabled": true
    }
  }
}
```

**Direct CLI session**

```bash
pnpm dlx messages-mcp --help
# or run the stdio server manually
pnpm dlx messages-mcp
```

For HTTP transport, launch `node dist/index.js --http --port 3333 --cors-origin https://chat.openai.com` and point the client at the resulting base URL.
