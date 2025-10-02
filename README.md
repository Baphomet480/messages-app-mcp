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
```

During development you can run `pnpm run dev` (ts-node) and use the MCP Inspector:

```bash
pnpm run inspector
```

Helper scripts:

- `pnpm run send -- "+1XXXXXXXXXX" "Hello"` – send a quick test message.
- `pnpm run doctor` / `pnpm run doctor -- --json` – verify prerequisites.

### Install via npm / pnpm

Once a release is published to npm you can install or run the package directly:

```bash
# one-shot usage
pnpm dlx messages-mcp --help
# (or use `npx messages-mcp --help` if you prefer npm)

# or install globally
pnpm add -g messages-app-mcp
# (or `npm install -g messages-app-mcp`)
messages-mcp --help
```

The binary exposed by npm (or installed via pnpm) is identical to `dist/index.js`; all runtime requirements (Full Disk Access, Node 18+) still apply.

## Tool Reference

| Tool | Description | Notes |
| ---- | ----------- | ----- |
| `about` | Returns version/build metadata, repository links, and runtime environment info. | Surface this in clients to confirm the deployed build. |
| `list_chats` | Lists recent chats with participants, unread counts, and last-activity timestamps (Apple epoch converted to UNIX/ISO). | Supports filters: `limit`, `participant`, `updated_after_unix_ms`, `unread_only`. |
| `get_messages` | Retrieves normalized message rows by `chat_id` or `participant`, optionally with contextual windows and attachment metadata. | Structured payload includes ISO timestamps, message types, and optional context bundle. |
| `send_text` | Sends text to a recipient/chat and returns structured JSON with target metadata, latest/recent messages, and any lookup errors. | Honors `MESSAGES_MCP_READONLY`; response always includes a human-readable summary inside the JSON. |
| `send_attachment` | Sends a file (with optional caption) using the same targeting options as `send_text`. | Structured JSON includes attachment details + recent history. |
| `search_messages` / `search_messages_safe` | Full-text search with scoping options and convenience defaults to avoid whole DB scans. | Safe variant enforces day-based limits automatically. |
| `context_around_message` | Fetches a window of normalized messages around an anchor `message_rowid`. | Useful for tools that need surrounding context without large history fetches. |
| `get_attachments` | Resolves attachment metadata (names, MIME types, byte sizes, resolved paths) with strict per-message caps. | Always read-only. |
| `doctor` | Structured diagnostics covering AppleScript availability, Messages services, SQLite access, and version metadata. | Returns JSON + summary string; artifacts can be collected in CI. |
| `applescript_handler_template` | Generates a starter AppleScript for message events (received/sent/transfer). | Save under `~/Library/Application Scripts/com.apple.iChat/`. |
| `search` / `fetch` | Connector-friendly tools for ChatGPT Pro / Deep Research (Streamable HTTP mode). | Emit JSON strings matching MCP connector expectations. |

## Configuration

Environment variables:

- `MESSAGES_MCP_READONLY=true` – disable `send_text`/`send_attachment` while keeping read tools enabled.
- `MESSAGES_MCP_MASK_RECIPIENTS=true` – mask phone numbers/emails in responses.
- `MESSAGES_MCP_HTTP_*` – configure optional Streamable HTTP transport (`PORT`, `HOST`, `ENABLE_SSE`, `CORS_ORIGINS`, etc.).
- `MESSAGES_MCP_CONNECTOR_*` – tweak connector search behavior (days back, result limits, base URL for citations).

Grant Full Disk Access before running the server so SQLite reads succeed. Without it, `doctor` will warn and send tools will fail silently in Messages.app.

## Versioning & Support

- The current package version is tracked in `package.json` (now `1.1.0`).
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
      "command": "npx",
      "args": ["messages-mcp"]
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
