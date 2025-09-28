# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
- Pending updates.

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
- README reorganized for public release, including npm usage instructions.

### Fixed
- `listChats` no longer fails on databases missing `chat.unread_count` column.

[1.1.0]: https://github.com/Baphomet480/messages-app-mcp/releases/tag/v1.1.0
