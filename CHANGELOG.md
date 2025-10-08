# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
- Pending updates.

## [2.0.1] - 2025-10-08
### Fixed
- Normalized Messages containing only object-replacement glyphs (`\uFFFC`/`\uFFFD`) now fall back to decoded bodies, preventing connector clients from seeing a lone `�` when sending rich links.
- CLI sender accepts `pnpm run send -- <recipient> "message"` by ignoring the passthrough `--`, avoiding false "Unable to resolve recipient" errors.

### Added
- New rotating file logger writes to `~/Library/Logs/messages-app-mcp/` (configurable via `MESSAGES_MCP_LOG_*`) and mirrors output to stdout/stderr.

## [2.0.0] - 2025-10-03
### Breaking
- Unified send tool outputs to a single-envelope schema with `ok` instead of prior `status` union:
  - `send_text`, `send_attachment` now return `{ ok, summary, target, chat_id?, latest_message?, recent_messages?, error?, lookup_error?, attachment? }`.
  - Read-only mode now returns `{ ok: false, ... }` in the same envelope (previously returned only text with `isError`).

### Added
- Explicit `outputSchema` for `send_text`, `send_attachment`, connector tools `search` and `fetch` for stronger MCP self-description.

### Changed
- Standardized structuredContent across tools to always match `outputSchema`.
- README updated with stable output shapes and examples for clients.

### Migration
- Clients parsing `send_*` results should switch from checking `status === "sent"` to boolean `ok` and read `summary`/`error` accordingly.

## [1.1.0] - 2025-09-28
### Added
- `about` MCP tool exposing package version, git commit, repository, and runtime environment metadata.
- Release workflow (`.github/workflows/release.yml`) to build/test and publish on `v*` tags.
- Contributor documentation (`CONTRIBUTING.md`) and build/verify guidance under `docs/reference/`.
- Structured send payload helpers (`src/utils/send-result.ts`) with tests.

### Changed
- `send_text`/`send_attachment` now return structured JSON payloads alongside summaries.
- `doctor` tool includes package/git metadata in its structured response.
- `list_chats` unread-count logic tolerates macOS schema variants lacking `chat.unread_count`.
- README reorganized for public release, including pnpm usage instructions.

### Fixed
- `listChats` no longer fails on databases missing `chat.unread_count` column.

[2.0.0]: https://github.com/Baphomet480/messages-app-mcp/releases/tag/v2.0.0
[1.1.0]: https://github.com/Baphomet480/messages-app-mcp/releases/tag/v1.1.0
