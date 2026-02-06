---
phase: 07-apply-endpoint-extended
plan: 02
type: execute
status: completed
completed: 2026-02-06
files_modified:
  - tests_and_others/tests/apply-extended.test.mjs
verification:
  - "node --test tests_and_others/tests/apply-extended.test.mjs"
  - "node --test tests_and_others/tests/server.test.mjs"
  - "node --test tests_and_others/tests/auth.test.mjs"
  - "node --test tests_and_others/tests/read.test.mjs"
---

# Phase 07 Plan 02 Summary

Implemented contract tests for apply endpoint extensions in `tests_and_others/tests/apply-extended.test.mjs`.

## What was added

1. Markdown format auto-detection tests (APPLY-05)

- Accepts markdown edits generated via `editsToMarkdown(...)` and returns `200` with DOCX binary output.
- Returns `400 INVALID_EDITS_MARKDOWN` for malformed markdown that matches markdown markers but has no parseable edits table.
- Confirms valid JSON array input is still parsed as JSON (no markdown false positive).
- Confirms JSON input beginning with `[` is handled as JSON and returns normal DOCX response.

2. Dry-run mode tests (APPLY-06)

- `dry_run=true` returns `200` JSON validation report with `valid`, `summary`, `issues`, `warnings`.
- `dry_run=true` still returns `200` for invalid edits with `valid: false` and non-empty issues.
- `dry_run=true` does not return DOCX binary (not `PK` zip signature).
- No `dry_run` param returns normal DOCX binary response.
- Markdown + `dry_run=true` combination returns JSON validation report as expected.

3. Response header tests (APPLY-07)

- Successful apply responses include:
  - `x-edits-applied`
  - `x-edits-skipped`
  - `x-warnings`
- Header values are asserted as string integers.
- Count contract validated for one known-valid edit:
  - `x-edits-applied = 1`
  - `x-edits-skipped = 0`
- Error response (`MISSING_FILE`) confirms summary headers are absent.

## Test implementation details

- Added reusable multipart request helper `makeApplyRequest(...)`.
- Uses real fixture `tests_and_others/tests/fixtures/sample.docx`.
- Resolves real block `seqId`s through `/v1/read` before apply tests to avoid invalid-id noise and make success/header tests deterministic.
- Uses one shared app instance (`buildApp`) per suite with proper `before/after` lifecycle.

## Verification results

- `node --test tests_and_others/tests/apply-extended.test.mjs` passed (14/14).
- `node --test tests_and_others/tests/server.test.mjs` passed.
- `node --test tests_and_others/tests/auth.test.mjs` passed.
- `node --test tests_and_others/tests/read.test.mjs` passed.
