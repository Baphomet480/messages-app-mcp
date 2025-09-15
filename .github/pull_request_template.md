## Purpose

Explain the motivation for this change. Link any related issues.

Fixes #

## Key Changes

- 

## Local Run Notes

- Build: `npm run build`
- Dev (stdio): `npm run dev`
- Inspector (optional): `npm run inspector`
- Doctor: `npm run doctor` or `npm run doctor -- --json`

## Testing Plan

- Unit tests: `npm test`
- Manual tool checks via Inspector:
  - `doctor` → environment report
  - `list_chats` → lists recent chats
  - `get_messages` → recent messages by `chat_id` or `participant`
  - `send_text` → send a message (masking enabled by default)

## Security / Privacy

- Avoid logging message bodies or full phone numbers. Keep recipients masked in output unless explicitly revealing locally.
- Database access stays read-only via `sqlite3 -readonly -json`.
- AppleScript only used to send via Messages.app.

## Checklist

- [ ] Conventional Commit message (e.g., `feat:`, `fix:`, `docs:`)
- [ ] `npm run build` passes
- [ ] `npm test` passes locally (if applicable)
- [ ] `npm run doctor` produces expected guidance (ok on a configured Mac, or helpful notes otherwise)
- [ ] No unintended file changes
- [ ] No sensitive logs or PII committed

