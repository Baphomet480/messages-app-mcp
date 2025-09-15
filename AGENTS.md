# Repository Guidelines

## Project Structure & Module Organization
- `src/index.ts` — MCP server entry; registers tools `send_text`, `list_chats`, `get_messages`.
- `src/utils/applescript.ts` — AppleScript helpers for sending via Messages.app.
- `src/utils/sqlite.ts` — Read‑only SQLite access to `~/Library/Messages/chat.db` + Apple‑epoch conversion.
- `dist/` — compiled JS (gitignored). Supporting files: `tsconfig.json`, `package.json`, `README.md`.

## Build, Test, and Development Commands
- Setup: `npm install`
- Live dev (stdio): `npm run dev` (ts-node)
- Build: `npm run build` → emits `dist/`
- Run built: `npm start` or `npx messages-mcp`

## Coding Style & Naming Conventions
- Language: TypeScript, ES2022 modules; 2‑space indentation.
- Files/dirs: kebab‑case (e.g., `utils/applescript.ts`).
- Names: PascalCase for types/interfaces; camelCase for functions/variables.
- Exported APIs should declare explicit return types; avoid one‑letter identifiers.
- Keep side effects in `src/index.ts`; utilities should be small and pure.

## Testing Guidelines
- Currently no tests. Preferred stack: Vitest.
- Place tests in `tests/` mirroring source paths, name as `*.spec.ts` (e.g., `tests/utils/sqlite.spec.ts`).
- Add a `npm test` script in PRs; aim to cover edge cases (timestamp conversion, SQL limits, error paths).

## Commit & Pull Request Guidelines

- Maintainer prefers the agent manages git operations (commits, pushes, branches, merges) proactively—including pushing to `origin/main`—without additional prompts unless explicitly told otherwise.
- Agent should check available MCP tools (e.g., web search, Context7) whenever they would help with research or testing.
- Commits: concise, present tense; prefer Conventional Commits (e.g., `feat:`, `fix:`, `docs:`).
- PRs must include: purpose, key changes, local run notes, and linked issue(s). Keep diffs focused.
- Pre‑merge checklist: `npm run build` passes; tools tested (or testing plan noted); no unintended file changes.

## Security & Configuration Tips
- Grant Full Disk Access to your terminal to read `~/Library/Messages/chat.db`.
- Database access must use `sqlite3 -readonly -json`; never write to Messages databases.
- AppleScript sending uses `osascript`; avoid logging message bodies or full phone numbers.

## Architecture Overview
- `McpServer` (stdio transport) exposes tools. Read path: `sqlite.ts` → `chat.db` (read‑only). Send path: `applescript.ts` → `osascript` → Messages.app.
