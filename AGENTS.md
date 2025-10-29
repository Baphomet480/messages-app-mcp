# Repository Guidelines

## Project Structure & Module Organization
Source code lives in `src/` (runtime orchestration, tool wiring, HTTP/STDIO transports). Cross-cutting helpers belong to `src/utils/`, while AppleScript bridges sit alongside their TypeScript shims. Tests mirror this layout in `tests/**` (`tests/utils/*.spec.ts` for unit coverage, `tests/integration` for transport/tool flows). Build artifacts land in `dist/`, ad-hoc scripts in `scripts/`, and diagnostic output in `logs/` and `coverage/`.

## Build, Test, and Development Commands
Install dependencies with `pnpm install`. Use `pnpm build` to compile TypeScript, `pnpm dev` to run the server via ts-node, and `pnpm start` (or `pnpm start:http`) to exercise the compiled HTTP transport. `pnpm test` runs Vitest with coverage, `pnpm doctor` audits macOS permissions, and `pnpm send` demonstrates outbound messaging. When debugging MCP behaviour, `pnpm inspector` launches the MCP inspector against `dist/index.js`.

## Coding Style & Naming Conventions
We target strict ESM TypeScript, 2-space indentation, and kebab-case filenames. Prefer named exports, colocate Zod schemas with handlers, and reuse `getLogger()` for structured logging. AppleScript helpers should expose JSON-friendly responses through `utils/applescript.ts`, keeping TypeScript adapters thin.

## Testing Guidelines
Vitest drives tests; keep `*.spec.ts` files under `tests/` aligned with their source counterparts. Ensure additions affecting database or AppleScript bridges ship with unit coverage, and refresh integration tests when transport/registry wiring changes. Run `pnpm test` (or `pnpm test --runInBand` when debugging) before opening a PR.

## Commit & Pull Request Guidelines
Commit subjects should stay short and imperative (e.g., “Refactor tool registry wiring”). Describe configuration or permissions changes in the body, list commands executed (`pnpm build`, `pnpm test`, `pnpm doctor`), and link issues. Pull requests should include behavioural notes (log viewer screenshots, CLI output) whenever user-facing behaviour changes.

## Security & Configuration Tips
Defaults can be overridden via environment variables or `messages-mcp.config.json` (current directory or `~/.config/`). For HTTP deployments, lock down `MESSAGES_MCP_HTTP_ALLOWED_HOSTS`, enable DNS protection, and document OIDC secrets separately. macOS Full Disk Access remains mandatory for AppleScript calls; remind contributors to verify it via `pnpm doctor`.

## Agent & MCP Tooling
We work with Serena-based agent tools for structured refactors (`find_symbol`, `replace_symbol_body`, `search_for_pattern`) and GitHub MCP tools for issue tracking (`github__create_issue`, `github__list_pull_requests`, etc.). Use Serena helpers to manage large-scale code moves or project memories, and GitHub MCP commands to file/triage issues and surface PR context without leaving the CLI.

## MCP Server Usage
- Azure DevOps MCP servers are registered under `ado_*` (currently `ado_candor`); always confirm whether they expose a tool that satisfies the request before resorting to manual CLI work.
- The Azure MCP server provides extensive Azure resource operations; review its catalog first for deployments, diagnostics, metrics, or documentation pulls.
- The Serena MCP server (semantic code retrieval/editing) should be the first stop for repo-aware edits, searches, and symbol operations.
- The GitHub MCP server covers repository metadata, reviews, PRs, and workflow automation; check its tools whenever the task involves GitHub.
- The Firecrawl MCP server accelerates web research; consult it for crawling, scraping, or extracting structured data from external sites.
- The Context7 MCP server offers documentation lookup; resolve libraries and pull docs there before manually browsing vendor sites.
- The Playwright MCP servers (`playwright_headless`, `playwright_extension`) can drive browsers headlessly or interactively; inspect their tooling when UI automation or screenshots are needed.
- The `ddg-search` MCP server provides DuckDuckGo web search and content fetch; use it for lightweight discovery when Firecrawl is unnecessary.
- The ConnectWise MCP server surfaces service desk automation; verify whether a ticketing action already exists before using the web UI.
- The Docker MCP server exposes container inspection and lifecycle commands; lean on it for container diagnostics instead of shelling out directly.
- The Analytics MCP server integrates with Google Analytics; rely on its reporting tools before exporting data manually.
- The MarkItDown MCP server converts URLs or files to Markdown; check it for documentation ingestion tasks.
- The Messages MCP server allows macOS Messages automation; use it for transcript pulls or sending updates when directed by the runbook.
- Ignore the `codermcp` server—it is currently non-functional.
- Periodically review the Codex CLI MCP registry (e.g., `codex mcp list`) so newly added servers are considered before manual work.

