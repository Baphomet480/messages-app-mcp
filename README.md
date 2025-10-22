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
- [Resources](#resources)
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

> **New in 2.1** – Streamable HTTP now advertises MCP resources. The server publishes a live inbox snapshot (`messages://inbox`) and parameterised conversation transcripts via `messages://conversation/{selector}/{value}`. Codex can subscribe to these without calling tools; see [Resources](#resources) for payload details.

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
| `history_by_days` | Fetches recent history for a chat or participant over a fixed number of days without requiring a text query. | Supply `chat_id` or `participant`, plus `days_back` (default 30) and `limit` (default 100). |
| `send_text` | Sends text to a recipient/chat and returns a single-envelope JSON result with `ok`, `summary`, target, recent messages, and the original payload/segment metadata. | Honors `MESSAGES_MCP_READONLY`; always returns the same envelope shape with `ok: false` on failure. |
| `send_attachment` | Sends a file (with optional caption) using the same targeting options as `send_text`. | Same envelope as `send_text`, with an optional `attachment` field. |
| `search_messages` / `search_messages_safe` | Full-text search plus scoped recency filters. | Safe variant enforces `days_back ≤ 365`; switch to `search_messages` for longer ranges or explicit Unix timestamps. |
| `context_around_message` | Fetches a window of normalized messages around an anchor `message_rowid`. | Useful for tools that need surrounding context without large history fetches. |
| `summarize_window` | Summarize a window of messages around an anchor rowid with participant counts and trimmed lines. | Helpful for quick recap responses without fetching full history. |
| `get_attachments` | Resolves attachment metadata (names, MIME types, byte sizes, resolved paths) with strict per-message caps. | Always read-only. |
| `doctor` | Structured diagnostics covering AppleScript availability, Messages services, SQLite access, and version metadata. | Returns JSON + summary string; artifacts can be collected in CI. |
| `applescript_handler_template` | Generates a starter AppleScript for message events (received/sent/transfer). | Save under `~/Library/Application Scripts/com.apple.iChat/`. |
| `search` / `fetch` | Connector-friendly tools for ChatGPT Pro / Deep Research (Streamable HTTP mode). | Emit JSON strings matching MCP connector expectations. |

Implementation note: metadata-oriented tools share a single AppleScript dispatcher that returns normalized JSON, so the Node host mostly forwards results without extra shaping—keeping agent context lean while leaning on macOS automation for the heavy lifting.

## Resources

Resources complement the tool surface by exposing read-only feeds that Codex (and other MCP clients) can subscribe to without invoking a tool.

| Resource | Description | Payload |
| -------- | ----------- | ------- |
| `messages://inbox` | Rolling snapshot of the most recent conversations with unread counts, participants, and the latest normalized message. The list is capped by `MESSAGES_MCP_INBOX_RESOURCE_LIMIT` (default 15). | JSON document `{ generated_at, total_conversations, total_unread, conversations[] }`. Each entry includes `chat_id`, `guid`, `display_name`, `participants[]`, `unread_count`, and `latest_message` (normalized schema shared with tools). |
| `messages://conversation/{selector}/{value}` | Template that resolves a specific transcript. Supported selectors: `chat-id`, `chat-guid`, `chat-name`, and `participant`. The candidate list in `resources/list` is capped by `MESSAGES_MCP_CONVERSATION_LIST_LIMIT` (default 20). | JSON document `{ generated_at, selector, value, target, chat, messages[] }`. Messages are sorted oldest→newest and limited by `MESSAGES_MCP_CONVERSATION_RESOURCE_LIMIT` (default 60). |

The Streamable HTTP manifest advertises both endpoints, so Codex can call `resources/list` to discover the inbox plus curated conversation URIs, or `resources/templates/list` followed by `resources/read` to resolve arbitrary selectors.

> Tip: the server expects HTTP clients to send `Accept: application/json, text/event-stream` during initialization. Codex CLI v0.46+ supports this via RMCP; update `~/.codex/config.toml` accordingly:
> 
> ```toml
> experimental_use_rmcp_client = true
> 
> [mcp_servers.messages]
> url = "http://127.0.0.1:8002/mcp"
> accept = "application/json, text/event-stream"
> startup_timeout_sec = 20
> tool_timeout_sec = 60
> ```
> 
> Without the combined Accept header the server returns `406 Not Acceptable` for the `initialize` request, which surfaces in Codex as a transport handshake failure.

### Recency & search scope

- **`history_by_days`** is the quickest way to say “give me the last *N* days” for a merged conversation: supply `chat_id` or `participant`, optionally enable `include_attachments_meta`, and it returns normalized rows sorted oldest→newest.
- **`search_messages`** exposes the same normalized rows but adds optional full-text search plus explicit Unix range filters (`from_unix_ms`/`to_unix_ms`). Use this when you need more than the default history window or want to combine keyword filters.
- **`search_messages_safe`** enforces a scope guard (`chat_id`, `participant`, or `days_back ≤ 365`) to keep queries predictable for agents. Stick with this variant when you do not need multi-year lookbacks.
- **`search`** (connector) still exists for Streamable HTTP / ChatGPT connectors; it returns lightweight documents (`id`, `title`, `snippet`) rather than the full normalized message rows.

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

1. Start the stack (Messages MCP + optional mcpo proxy):

   ```bash
   pnpm run build
   MCPO_API_KEY=your-shared-secret scripts/mcp-stack.sh start
   ```

   By default the MCP transport binds to `http://127.0.0.1:8002/mcp` and the proxy listens on `http://127.0.0.1:9000`. Disable the proxy with `scripts/mcp-stack.sh start --no-mcpo`.

2. Update `~/.codex/config.toml`:

   ```toml
   experimental_use_rmcp_client = true

[mcp_servers.messages]
url = "http://127.0.0.1:8002/mcp"
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
- `MESSAGES_MCP_SEGMENT_WARNING=10` – emit `payload_warning` when a text spans more than this many segments (set to `0` to disable).
- `MESSAGES_MCP_MASK_RECIPIENTS=true` – mask phone numbers/emails in responses.
- `MESSAGES_MCP_HTTP_*` – configure optional Streamable HTTP transport (`PORT`, `HOST`, `ENABLE_SSE`, `CORS_ORIGINS`, etc.).
- `MESSAGES_MCP_LOG_VIEWER=true` – toggle the built-in browser log viewer. When enabled the agent opens a single local tab with live log streaming and a shutdown button.
- `MESSAGES_MCP_LOG_VIEWER_AUTO_OPEN=true` – disable to start the viewer server without automatically launching a browser tab.
- `MESSAGES_MCP_LOG_VIEWER_MAX_CHUNK=262144` – override the maximum number of bytes returned per log poll (default ~256&nbsp;KiB).
- `MESSAGES_MCP_OSASCRIPT_MODE=file` – controls how AppleScript is invoked. The default (`file`) writes the script to a temporary `.applescript` file before calling `/usr/bin/osascript`, avoiding inline parsing quirks. Set to `inline` to revert to the legacy `-l AppleScript -e` behaviour.
- `MESSAGES_MCP_HTTP_OIDC_*` – enable OAuth/OIDC protection for the HTTP transport. See [OAuth guard](#oauth-guard) for the full matrix.
- Optional JSON config: place `messages-mcp.config.json` in the current directory (or point `MESSAGES_MCP_CONFIG` at a file). We also check `~/.config/messages-mcp.config.json`. Values in the config provide defaults for the same knobs as the environment variables (env/CLI still win).
- `MESSAGES_MCP_CONNECTOR_DAYS_BACK=365`, `MESSAGES_MCP_CONNECTOR_LIMIT=20` – adjust defaults for the connector-facing `search`/`fetch` tools.
- `MESSAGES_MCP_CONNECTOR_CONTACT`, `MESSAGES_MCP_CONNECTOR_DOCS_URL`, `MESSAGES_MCP_CONNECTOR_PRIVACY_URL`, `MESSAGES_MCP_CONNECTOR_TOS_URL` – override contact/legal metadata surfaced from `/mcp/manifest` for OpenAI connectors and other registries.
- `MESSAGES_MCP_INBOX_RESOURCE_LIMIT=15` – cap the number of conversations returned by the inbox resource (bounds 5–50).
- `MESSAGES_MCP_CONVERSATION_RESOURCE_LIMIT=60` – cap the message count returned by each conversation resource payload (bounds 10–200).
- `MESSAGES_MCP_CONVERSATION_LIST_LIMIT=20` – cap how many conversation URIs appear in `resources/list` (bounds 5–100).

Grant Full Disk Access before running the server so SQLite reads succeed. Without it, `doctor` will warn and send tools will fail silently in Messages.app.

### OAuth guard

Set `MESSAGES_MCP_HTTP_OIDC_ENABLED=true` to wrap the HTTP transport with `express-openid-connect`. This adds login, callback, and logout routes plus a lightweight session endpoint (default: `/auth/session`). Requests to `/mcp` (and `/sse`/`/messages` if the SSE fallback is enabled) must complete an OAuth flow before traffic reaches the MCP transports.

Required environment variables:

- `MESSAGES_MCP_HTTP_OIDC_ISSUER_BASE_URL` – OIDC issuer (e.g. `https://YOUR_DOMAIN.auth0.com`, `https://accounts.google.com`).
- `MESSAGES_MCP_HTTP_OIDC_BASE_URL` – the externally reachable base URL for this server (e.g. `https://mcp.example.com`). Use the reverse proxy origin.
- `MESSAGES_MCP_HTTP_OIDC_CLIENT_ID` – OIDC client/application ID.
- `MESSAGES_MCP_HTTP_OIDC_SESSION_SECRET` – 32+ character secret for cookie encryption.

Optional knobs:

- `MESSAGES_MCP_HTTP_OIDC_CLIENT_SECRET` – supply when your provider requires a confidential client.
- `MESSAGES_MCP_HTTP_OIDC_SCOPE` (default `openid profile email`) and `MESSAGES_MCP_HTTP_OIDC_AUDIENCE` – request extra identity/API claims.
- `MESSAGES_MCP_HTTP_OIDC_AUTH_REQUIRED` – set `true` to make every route (including `/health`) require authentication; by default only MCP endpoints are guarded.
- `MESSAGES_MCP_HTTP_OIDC_PROTECT_HEALTH` – require auth for `/health` without forcing `AUTH_REQUIRED=true`.
- `MESSAGES_MCP_HTTP_OIDC_TRUST_PROXY` – numeric hop count passed to `app.set("trust proxy", value)` (default `1`) for TLS-terminating proxies.
- `MESSAGES_MCP_HTTP_OIDC_SESSION_PATH` – override the session introspection route (set to empty string to disable).
- `MESSAGES_MCP_HTTP_OIDC_IDP_LOGOUT` – set `true` to propagate logout to the identity provider when calling `/logout`.

Behind an HTTPS reverse proxy, expose `/mcp` (and `/login`, `/callback`, `/logout`) publicly, force TLS at the proxy, and ensure cookies are preserved end-to-end. The guard skips CORS pre-flight OPTIONS requests, so browsers can still negotiate HTTP transports.

## Versioning & Support

- The current package version is tracked in `package.json` (current: `2.0.0`).
- The `about` and `doctor` tools expose the deployed version, git commit (when available), repository, and runtime information—ideal for client dashboards.
- Use semantic versioning: bump the minor version for new features, patch for fixes, and major if you introduce breaking changes to tool schemas.

## Development

- `pnpm run dev` starts the stdio server via ts-node.
- `pnpm run build` compiles TypeScript to `dist/`; run `pnpm start` to execute the compiled build.
- An MCP Inspector session can be launched with `pnpm run inspector`.
- `node scripts/check-tools.mjs` performs the automated metadata audit used in CI to keep tool titles and field descriptions aligned with MCP best practices.
- `node scripts/test-search.mjs --participant '+15551234567' --days-back 30` exercises the recency/search flow exactly as an MCP client would.
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
  },
  "submitted_text": "Full status update that was sent.",
  "submitted_text_length": 75,
  "submitted_segment_count": 1,
  "submitted_segment_encoding": "gsm-7",
  "submitted_segment_unit_count": 75,
  "submitted_segment_unit_size": 160,
  "payload_warning": null
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

#### Payload sizing & diagnostics

- The server analyses each submitted text with GSM-7/UCS-2 rules to compute segments. Anything above **10 segments** (≈ 1,530 GSM characters or ≈ 670 Unicode code points) produces a `payload_warning` so automations can split or trim proactively.
- All warnings and segment counts are included in `submitted_segment_*` fields alongside the original `submitted_text`, enabling callers to assert that the payload they generated is what Messages.app received.
- You can raise/lower the warning threshold (or disable it) with `MESSAGES_MCP_SEGMENT_WARNING`. Set it to `0` to suppress warnings altogether.
- Emoji and other non-GSM characters are fully supported—they switch the encoding to `ucs-2`, appear in the returned text, and count toward the Unicode segment math.
- `send_attachment` continues to support files plus optional captions; use `get_attachments` to inspect attachment metadata after delivery. Message reactions are read-only today (visible via history tools) and cannot be sent programmatically yet.

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
