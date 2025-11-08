# Messages.app MCP Server

[![CI](https://github.com/Baphomet480/messages-app-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Baphomet480/messages-app-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Baphomet480/messages-app-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/Baphomet480/messages-app-mcp/actions/workflows/codeql.yml)
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
- [Troubleshooting](#troubleshooting)
- [Release Process](#release-process)
- [Security Notes](#security-notes)
- [Contributing](#contributing)
- [License](#license)

## Overview

`messages-app-mcp` exposes Messages.app over MCP transports (stdio and optional Streamable HTTP). The server is designed for local use: it reads `~/Library/Messages/chat.db` in read-only mode and delegates outgoing sends to AppleScript.

> **New in 2.1** – Streamable HTTP now advertises MCP resources. The server publishes a live inbox snapshot (`messages://inbox`), parameterised conversation transcripts (`messages://conversation/{selector}/{value}`), and contact cards (`messages://contact/{contactId}`). Codex can subscribe to these without calling tools; see [Resources](#resources) for payload details.

## Key Features

- Enumerate recent chats with unread counts that work across macOS schema changes.
- Fetch recent messages by chat, participant, or focused context windows with normalized timestamps/metadata.
- Send messages and attachments while receiving structured JSON responses that include delivery summaries, delivery routes, and recent history.
- Full-text search with optional scoping and attachment hints.
- Rotating structured logs (repo-local by default) that capture search queries, send outcomes, and errors.
- Diagnostics via `doctor` and version metadata via the `about` tool.
- Optional contact enrichment through Contacts.app (enable with `MESSAGES_MCP_CONTACTS=1`).

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
- Shell helpers in `scripts/` (useful outside pnpm):
  - `scripts/mcp-stack.sh` – start/stop the Streamable HTTP server (`start|stop|status|watch`). Defaults align to port 3338; override with `MESSAGES_MCP_PORT`.
  - Deprecated shims: `mcp-http-start.sh`, `mcp-http-stop.sh`, `mcp-http-watch.sh` now forward to `mcp-stack.sh` to keep older workflows working. Prefer `mcp-stack.sh` directly.

### Which transport should I use?

| Mode | When it shines | Notes |
| ---- | --------------- | ----- |
| `stdio` (default) | Local Codex CLI launches the server on demand. Simple auth story and fastest iteration loop. | Configure via `transport: "stdio"` (or omit the key). stdout stays pure JSON while stderr + rotating files capture logs. |
| Streamable HTTP + SSE | Need persistent resources (`messages://inbox`, `messages://conversation/...`, `messages://contact/...`) or want to front the server with an authenticated proxy. | Enable with `transport: "http"` or `pnpm run start:http`. Lock down `MESSAGES_MCP_HTTP_ALLOWED_HOSTS` and review the example config for sane defaults. |

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
| `list_chats` | Lists recent chats with participants, unread counts, and last-activity timestamps (Apple epoch converted to UNIX/ISO). | Adds `participant_names[]` (contact display names when enabled) plus `effective_display_name` fallback. Filters: `limit`, `participant`, `updated_after_unix_ms`, `unread_only`. |
| `get_messages` | Retrieves normalized message rows by `chat_id` or `participant`, optionally with contextual windows and attachment metadata. | Structured payload includes ISO timestamps, message types, and optional context bundle. |
| `recent_messages_by_participant` | Returns the most recent normalized messages for a participant handle (phone or email). | Use when you want the latest conversation history without providing a text query. |
| `history_by_days` | Fetches recent history for a chat or participant over a fixed number of days without requiring a text query. | Supply `chat_id` or `participant`, plus `days_back` (default 30) and `limit` (default 100). |
| `send_text` | Sends text to a recipient/chat and returns a single-envelope JSON result with `ok`, `summary`, `route`, target, recent messages, and the original payload/segment metadata. | Automatically falls back to SMS when iMessage delivery fails; `route` reflects the channel (`imessage` or `sms`). Honors `MESSAGES_MCP_READONLY`. |
| `send_attachment` | Sends a file (with optional caption) using the same targeting options as `send_text`. | Same envelope as `send_text`, with an optional `attachment` field. |
| `search_messages` / `search_messages_safe` | Full-text search plus scoped recency filters. | Safe variant enforces `days_back ≤ 365` (configurable default via `MESSAGES_MCP_DEFAULT_DAYS_BACK`, `MESSAGES_MCP_SEARCH_LIMIT_MAX`). |
| `search_contacts` | Looks up macOS Contacts entries by name, phone number, or email. | Enabled by default; set `MESSAGES_MCP_CONTACTS=0` to opt out. Returns `{ contacts: [{ name, phones[], emails[] }] }`. |
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
| `messages://contact/{contactId}` | Template exposing macOS Contacts entries when `MESSAGES_MCP_CONTACTS=1`. Returned contacts are capped by `MESSAGES_MCP_CONTACT_RESOURCE_LIMIT` (default 25). | JSON document `{ generated_at, resource_id, name, primary_phone, primary_email, phones[], emails[] }`. |

The Streamable HTTP manifest advertises all endpoints, so Codex can call `resources/list` to discover the inbox, curated conversations, and recent contacts, or `resources/templates/list` followed by `resources/read` to resolve arbitrary selectors.

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

1. Start the Streamable HTTP server:

   ```bash
   pnpm run build
   scripts/mcp-stack.sh start
   ```

   By default the transport binds to `http://127.0.0.1:3338/mcp`. Override the host or port with `MESSAGES_MCP_HOST` / `MESSAGES_MCP_PORT`.

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
- `MESSAGES_MCP_SEGMENT_WARNING=10` – emit `payload_warning` when a text spans more than this many segments (set to `0` to disable).
- `MESSAGES_MCP_MASK_RECIPIENTS=true` – mask phone numbers/emails in responses.
- `MESSAGES_MCP_HTTP_*` – configure optional Streamable HTTP transport (`PORT`, `HOST`, `ENABLE_SSE`, `CORS_ORIGINS`, etc.).
  - `MESSAGES_MCP_HTTP_ALLOWED_HOSTS` – comma‑separated host allowlist for DNS‑rebinding protection. The server rejects requests whose `Host` header is not in this list (normalized with the runtime port). Defaults include `127.0.0.1`, `localhost`, and `[::1]` when binding to all interfaces. Add any custom names you use over SSH tunnels (see below).
- `MESSAGES_MCP_LOG_VIEWER=true` – toggle the built-in browser log viewer. When enabled the agent opens a single local tab with live log streaming and a shutdown button.
- `MESSAGES_MCP_LOG_VIEWER_AUTO_OPEN=true` – disable to start the viewer server without automatically launching a browser tab.
- `MESSAGES_MCP_LOG_VIEWER_MAX_CHUNK=262144` – override the maximum number of bytes returned per log poll (default ~256&nbsp;KiB).
- `MESSAGES_MCP_LOG_VIEWER_PORT=3337` – pin the log viewer to a fixed port so repeated launches reuse the same browser tab (falls back to a random port if unavailable).
- `MESSAGES_MCP_OSASCRIPT_MODE=file` – controls how AppleScript is invoked. The default (`file`) writes the script to a temporary `.applescript` file before calling `/usr/bin/osascript`, avoiding inline parsing quirks. Set to `inline` to revert to the legacy `-l AppleScript -e` behaviour.
- Optional JSON config: place `messages-mcp.config.json` in the current directory (or point `MESSAGES_MCP_CONFIG` at a file). We also check `~/.config/messages-mcp.config.json`. Values in the config provide defaults for the same knobs as the environment variables (env/CLI still win).
- A commented template lives at [`messages-mcp.config.json.example`](./messages-mcp.config.json.example); copy it next to your deployment and trim the `//` key once you are ready.
- `MESSAGES_MCP_CONTACTS=0` – opt out of contact enrichment. By default `list_chats` annotates participants with contact names and the `search_contacts` tool is available.
- `MESSAGES_MCP_DEFAULT_DAYS_BACK=30` and `MESSAGES_MCP_SEARCH_LIMIT_MAX=200` – redefine the default window and hard limit for `search_messages_safe`. Useful when agents should narrow searches to smaller slices (e.g., 14 days/100 results).
- `MESSAGES_MCP_DB_DRIVER=better-sqlite` – experimental flag that swaps in the future BetterSqlite-backed store. For now this emits a helpful error; leave it unset (CLI driver) in production.
- `MESSAGES_MCP_CONNECTOR_DAYS_BACK=365`, `MESSAGES_MCP_CONNECTOR_LIMIT=20` – adjust defaults for the connector-facing `search`/`fetch` tools.
- `MESSAGES_MCP_CONNECTOR_CONTACT`, `MESSAGES_MCP_CONNECTOR_DOCS_URL`, `MESSAGES_MCP_CONNECTOR_PRIVACY_URL`, `MESSAGES_MCP_CONNECTOR_TOS_URL` – override contact/legal metadata surfaced from `/mcp/manifest` for OpenAI connectors and other registries.
- `MESSAGES_MCP_INBOX_RESOURCE_LIMIT=15` – cap the number of conversations returned by the inbox resource (bounds 5–50).
- `MESSAGES_MCP_CONVERSATION_RESOURCE_LIMIT=60` – cap the message count returned by each conversation resource payload (bounds 10–200).
- `MESSAGES_MCP_CONVERSATION_LIST_LIMIT=20` – cap how many conversation URIs appear in `resources/list` (bounds 5–100).
- `MESSAGES_MCP_CONTACT_RESOURCE_LIMIT=25` – cap the number of contacts returned by the contact resource template (bounds 5–100).

- Grant Full Disk Access before running the server so SQLite reads succeed. Without it, `doctor` will warn and send tools will fail silently in Messages.app.

### SSH tunnels and allowed hosts

When you access the HTTP transport through an SSH tunnel, the HTTP `Host` header comes from the URL you use in the client (e.g., `127.0.0.1:3338` or `localhost:3338`). Shell alias names (like `pito`) do not affect the Host header. With DNS‑rebinding protection enabled, only the Host values matter.

- Quick start (already wired in `pnpm start:http`):

  ```bash
  # Allows 127.0.0.1, localhost, and ::1
  pnpm run start:http
  ```

- Custom run (choose your own names):

  ```bash
  MESSAGES_MCP_HTTP_ALLOWED_HOSTS=127.0.0.1,localhost,my-alias \
  node dist/index.js --http --host 127.0.0.1 --port 3338 --enable-sse
  ```

- Or via JSON config (`messages-mcp.config.json` in CWD or `~/.config/`):

  ```json
  {
    "transport": "http",
    "http": {
      "host": "127.0.0.1",
      "port": 3338,
      "allowedHosts": ["127.0.0.1", "localhost", "::1"]
    }
  }
  ```

If you prefer CLI flags instead of env/config, you can append `--allowed-host <name>` for any additional hostname you actually use in the URL (e.g., a reverse‑tunnel domain). All values are normalized to include the active port at runtime.

Examples:
- Local forward: `ssh -N -L 3338:127.0.0.1:3338 my-host` → connect to `http://127.0.0.1:3338` (already allowed).
- Reverse forward: `ssh -N -R 3338:127.0.0.1:3338 my-host` → if you browse from the remote side as `http://my-host:3338`, add `my-host` to `allowedHosts`.

### Pitolandia tunnel status (helper)

This repo ships a small script that reports the health of the reverse SSH tunnel used to expose the local MCP server to `ssh.pitolandia.com`.

```
scripts/pitolandia-tunnel-status.sh           # human-readable summary
scripts/pitolandia-tunnel-status.sh --one-line  # OK / DEGRADED / DOWN + notes
scripts/pitolandia-tunnel-status.sh --json      # machine-readable
```

It checks:
- LaunchAgent `com.pitolandia.tunnel` (loaded and PID)
- `autossh` presence on the Mac
- Remote listener on `127.0.0.1:3338`
- Local and remote `http://127.0.0.1:3338/mcp/manifest`

Exit codes: `0` OK, `1` degraded, `2` down. The remote manifest probe requires `curl` or `wget` on the server.

## Versioning & Support

- The current package version is tracked in `package.json` (current: `2.0.0`).
- The `about` and `doctor` tools expose the deployed version, git commit (when available), repository, and runtime information—ideal for client dashboards.
- Use semantic versioning: bump the minor version for new features, patch for fixes, and major if you introduce breaking changes to tool schemas.

## Development

- `pnpm run dev` starts the stdio server via ts-node.
- `pnpm run build` compiles TypeScript to `dist/`; run `pnpm start` to execute the compiled build.
- An MCP Inspector session can be launched with `pnpm run inspector`.
- `pnpm run generate:wrappers` spawns the stdio server, enumerates all MCP tools, and regenerates the code-execution wrappers under `src/agents/messages/`.
- `node scripts/check-tools.mjs` performs the automated metadata audit used in CI to keep tool titles and field descriptions aligned with MCP best practices.
- `node scripts/test-search.mjs --participant '+15551234567' --days-back 30` exercises the recency/search flow exactly as an MCP client would.
- Scripts are documented in `package.json`; use `pnpm run send` or `pnpm run doctor` for quick manual checks.

## Testing

- `pnpm test` runs Vitest with coverage (see `tests/utils/*.spec.ts`).
- Focus tests on edge cases: mixed chat schemas, Apple epoch conversions, structured response shapes.
- CI (GitHub Actions, macOS) runs install → test → build → doctor; keep workflows green before cutting a release.

## Troubleshooting

- **Full Disk Access** – If queries fail with `SQLITE_CANTOPEN` or `doctor` reports permission errors, re-check **System Settings → Privacy & Security → Full Disk Access** and add your terminal/agent runner.
- **Automation prompts** – The first send on a new host triggers macOS automation prompts for Messages.app. Approve them; otherwise AppleScript calls will error with “Not authorised to send Apple events”.
- **Contacts enrichment** – `list_chats` only includes `participant_names` when `MESSAGES_MCP_CONTACTS=1` and macOS granted Contacts access. Flip the flag, restart, and accept the Contacts permission dialog when it appears.
- **Large searches** – Tighten `search_messages_safe` defaults with `MESSAGES_MCP_DEFAULT_DAYS_BACK` (e.g., `14`) and cap results via `MESSAGES_MCP_SEARCH_LIMIT_MAX` to keep agents responsive.

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
  "route": "imessage",
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
  "route": null,
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
- `search_contacts`: `{ contacts: [{ name, phones[], emails[] }] }`

### Contact lookup

Enable `MESSAGES_MCP_CONTACTS=1` to resolve phone/email handles through macOS Contacts. When active, `list_chats` gains a `participant_names[]` field and the new `search_contacts` tool returns lightweight records:

```json
{
  "contacts": [
    { "name": "Leia Organa", "phones": ["+15550001234"], "emails": ["leia@rebellion.example"] }
  ]
}
```

The first lookup prompts macOS for Contacts permission; accept it to cache entries for the process lifetime.

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
### Code-execution wrappers

`scripts/generate-mcp-wrappers.ts` produces lightweight helper modules for every MCP tool plus an index that exports `messageTools` and a lookup map. Agents running in “code execution” mode (Codex CLI, Claude desktop, etc.) can import these modules instead of ingesting the raw `tools/list` payload, which keeps prompts tiny while preserving full type info. The generator respects overrides from `messages-mcp.config.json` (see `codeExecWrappers`), so you can point it at an HTTP transport or change the destination directory if you keep wrappers in a separate workspace.
