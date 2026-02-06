---
phase: 07-apply-endpoint-extended
plan: 01
type: execute
status: completed
completed: 2026-02-06
files_modified:
  - src/routes/apply.mjs
verification:
  - "node -e \"import('./src/routes/apply.mjs').then(m => console.log('apply route:', typeof m.default))\""
  - "grep -c \"parseMarkdownEdits\" src/routes/apply.mjs"
  - "grep \"INVALID_EDITS_MARKDOWN\" src/routes/apply.mjs"
  - "grep \"dry_run\" src/routes/apply.mjs"
  - "grep \"X-Edits-Applied\" src/routes/apply.mjs"
  - "grep \"X-Edits-Skipped\" src/routes/apply.mjs"
  - "grep \"X-Warnings\" src/routes/apply.mjs"
  - "node --test tests_and_others/tests/server.test.mjs"
  - "node --test tests_and_others/tests/auth.test.mjs"
  - "node --test tests_and_others/tests/read.test.mjs"
  - "node --test tests_and_others/tests/apply.test.mjs"
---

# Phase 07 Plan 01 Summary

Implemented all requested extensions for `POST /v1/apply` in `src/routes/apply.mjs`:

## 1. Markdown edit format auto-detection

- Added `parseMarkdownEdits` import from `src/markdownEditsParser.mjs`.
- Replaced raw JSON-only parsing with anchored markdown detection:
  - `# Edits`
  - `## Metadata`
  - `## Edits Table`
  - `^\|\s*Block\s*\|` table header
- Markdown path parses via `parseMarkdownEdits(editsString)` and requires a non-empty `parsed.edits` array.
- Malformed/empty markdown now returns:
  - `400 INVALID_EDITS_MARKDOWN`
  - message: `Markdown format detected but parsing failed or contains no edits`
  - details include field `edits`.
- JSON path now returns `INVALID_EDITS_JSON` with message:
  - `Edits field must be valid JSON or markdown format`.
- Updated missing edits message to:
  - `Edits field is required and must be a JSON array or markdown format`.

## 2. Dry-run query mode

- Extended route config with query schema:
  - `dry_run: { type: "boolean", default: false }`
- Added `const isDryRun = request.query.dry_run === true;`.
- Added early-return dry-run response immediately after validation and before `!validation.valid` hard-fail:
  - always HTTP 200
  - JSON body with `valid`, `summary`, `issues`, `warnings`
  - warnings mapping is defensive via `(validation.warnings || [])`.

## 3. Edit summary headers on successful apply

- Added success-response headers from `validation.summary`:
  - `X-Edits-Applied` = `String(validation.summary.validEdits)`
  - `X-Edits-Skipped` = `String(validation.summary.invalidEdits)`
  - `X-Warnings` = `String(validation.summary.warningCount)`
- Headers are only added on successful binary DOCX responses.

## 4. Route docs update

- Updated JSDoc to document:
  - markdown support for `edits`
  - `dry_run` query parameter
  - response headers: `X-Edits-Applied`, `X-Edits-Skipped`, `X-Warnings`
  - new error code `INVALID_EDITS_MARKDOWN`.

## Verification results

- Module import check: `apply route: function`
- `parseMarkdownEdits` references: `2` (import + usage)
- `INVALID_EDITS_MARKDOWN`, `dry_run`, and all three `X-*` summary headers present in route file
- Test suites:
  - `server.test.mjs`: pass
  - `auth.test.mjs`: pass
  - `read.test.mjs`: pass
  - `apply.test.mjs`: pass
