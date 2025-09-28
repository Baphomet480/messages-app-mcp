# Build & Verify Guidance (repo copy)

This document captures the tailored workflow rules we follow in this repository. It reflects the "Universal Build–Verify Guidance" with practical adjustments discussed on 2025-09-28.

## Session self-check

- Run the environment inventory once per session (start of work). Record tool versions: `node`, `npm`, `git`, `tsc`, `vitest`. Cache the result in memory; re-run only if the environment changes.
- Warn immediately if a required tool is missing or versions do not match expected ranges.

## Risk classification & planning

- Classify each task:
  - **Low risk** – read-only operations or reversible local edits. Proceed directly.
  - **Medium risk** – standard repo writes (docs/code) on a local branch. Print a plan before executing.
  - **High risk** – changes that affect production behavior or are hard to roll back. Present a plan and wait for explicit `YES` confirmation.
  - **Prod-critical** – security/compliance or production-impacting changes. Require `PROD YES` confirmation.
- If ambiguity blocks accuracy, ask a targeted question. Otherwise state assumptions explicitly and note them in project memory.

## Verification expectations

- Always verify before completion:
  - **Code changes** – run `npm run build` and, when relevant, `npm test`. If a test suite is too heavy for a docs-only change, explain the exception.
  - **Docs-only changes** – at minimum run a quick check (e.g., `npm run build` to ensure no TypeScript regressions) and manually review links/snippets touched.
  - **Scripts/CLIs** – perform a smoke run (`npm run send -- --help`, etc.) when feasible.
- Record what was verified, the command, and the result in the final summary. Investigate failures; do not skip silently.

## Tool provenance

- When verification involves tools, note their versions in the final summary and in `AGENTS/project.memory.json` (tooling.versions → last_used).
- Prefer MCP-integrated tools where possible; resort to raw shell commands only when no MCP alternative exists.

## Memory & persistence

- Persist long-lived facts and decisions in `AGENTS/project.memory.json` (schema-based). Keep human-readable notes or logs under `docs/reference/notes/`.
- Avoid storing transient run outputs unless they serve as proof. Retention limit: 14 days or 100 MB. If pruning, leave a short summary entry.
- Do not persist secrets or PII. Redact identifiers when copying logs.

## Parameterization & idempotency

- Avoid hard-coded secrets, hosts, or local paths. Prefer environment variables or configuration parameters.
- Use dry-run/`--what-if` modes when available; confirm idempotency by re-running once when practical.

## Notifications (future use)

- The repo currently has no automated notification system. If one is introduced, obey pause/resume commands and log history in memory.

## Release tagging

- Release workflow runs on tags named `v*` (e.g., `v1.1.0`). Push the version bump to `main`, then create the tag to trigger publish.

Guidance version: 1 (repo-adjusted)
