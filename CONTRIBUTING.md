# Contributing to messages-app-mcp

Thanks for your interest in improving the Messages.app MCP server! This guide outlines how the project is organized and the expectations for contributors.

## Project layout

- `src/index.ts` – MCP server entry point, registers tools and transports.
- `src/utils/` – Supporting modules for AppleScript integration, SQLite access, message formatting, diagnostics, and version metadata.
- `scripts/` – Command-line helpers (`send.mjs`, `doctor.mjs`).
- `tests/` – Vitest suites mirroring the source tree.
- Build artifacts live in `dist/` (gitignored).

## Development workflow

1. Install dependencies with `npm install`.
2. For interactive development run `npm run dev` (ts-node) or build with `npm run build` and launch `npm start`.
3. The preferred MCP tooling flow is documented in the [README](README.md); be sure to grant Full Disk Access to your terminal for chat DB access.

## Coding standards

- TypeScript, ES2022 modules, 2-space indentation.
- PascalCase for types/interfaces, camelCase for functions and variables.
- Utilities should remain small and pure; keep side effects inside `src/index.ts`.
- Exported functions should declare explicit return types.
- Avoid logging message bodies or complete phone numbers/emails.

## Testing

- Run `npm test` (Vitest with coverage). Add or update tests alongside code changes—especially for SQLite query helpers, AppleScript fallbacks, and serialization.
- `npm run doctor` checks macOS prerequisites; include the output (or summary) for environment-related contributions.
- Always ensure `npm run build` passes before opening a PR.

## Commit & PR guidelines

- Use Conventional Commit prefixes (`feat:`, `fix:`, `docs:`, etc.).
- Summaries should be present-tense and concise.
- Pull Requests should include: purpose, key changes, test results (or rationale if tests are not run), and linked issues when applicable.
- Keep diffs focused. If you need unrelated refactors, submit them separately.

## Release & versioning

- The published version is tracked in `package.json` and surfaced via the `about` and `doctor` tools.
- Bump the version (SemVer) whenever you make user-facing changes (new tools, response schema updates, breaking changes).
- Include a short changelog entry in the PR description for release candidates.

## Security

- The server operates locally and only uses read-only SQLite queries plus AppleScript for sending; do not add network calls without prior discussion.
- Never commit secrets or personal chat data. Use mocks or anonymized fixtures in tests.

## Questions & support

If you have questions about tooling, architecture, or release cadence, open a GitHub Discussion or issue. For security disclosures, please start a private issue first.
