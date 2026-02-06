---
phase: 06-apply-endpoint-core
plan: 02
type: execute
status: completed
completed: 2026-02-06
files_created:
  - src/routes/apply.mjs
files_modified:
  - src/app.mjs
verification:
  - "node -e \"import('./src/routes/apply.mjs').then(m => console.log(typeof m.default))\""
  - "node -e \"import('./src/app.mjs').then(m => { const app = m.default({ logger: false, apiKey: 'test' }); app.ready().then(() => { console.log('routes:\\n' + app.printRoutes()); app.close(); }); })\""
  - "node --test tests_and_others/tests/server.test.mjs"
  - "node --test tests_and_others/tests/auth.test.mjs"
  - "node --test tests_and_others/tests/read.test.mjs"
---

# Phase 06 Plan 02 Summary

Implemented the apply endpoint core and registered it under the protected `/v1` scope.

## Changes

1. `src/routes/apply.mjs` (new)
- Added `POST /apply` route with `requireMultipart` preHandler.
- Parses multipart mixed fields via `request.parts()`:
  - Buffers uploaded file part.
  - Parses `edits` JSON field and returns `400 INVALID_EDITS_JSON` on parse failure.
- Validates required inputs:
  - `400 MISSING_FILE` when file is absent.
  - `400 MISSING_EDITS` when edits are absent or not an array.
- Reuses upload safety checks from Phase 3:
  - `validateMagicBytes` -> `400 INVALID_FILE_TYPE`.
  - `checkZipBomb` -> `400 ZIP_BOMB_DETECTED`.
- Integrates semaphore + editor lifecycle:
  - Acquires `fastify.documentSemaphore`.
  - Supports both editor factory shapes (`{ editor, cleanup }` and legacy editor-only fallback).
  - Sets `request.editorCleanup` for Phase 5 onResponse cleanup/release.
  - Returns `422 DOCUMENT_LOAD_FAILED` on editor load failure with immediate fallback cleanup/release.
- Extracts IR and validates edits before apply:
  - Returns `400 INVALID_EDITS` with full mapped issue list.
- Applies edits using `applyEditsToBuffer`:
  - Returns `422 APPLY_FAILED` on IR/apply failures.
- Recompresses output with `recompressDocxBuffer`:
  - Logs warning and falls back to uncompressed buffer on recompression failure.
- Returns binary DOCX with headers:
  - `Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document`
  - `Content-Disposition: attachment; filename="<sanitized>-edited.docx"`
- Added filename sanitization for Content-Disposition safety (quotes, backslashes, newlines, non-ASCII, other unsafe chars).

2. `src/app.mjs` (updated)
- Imported `applyRoutes`.
- Registered `scope.register(applyRoutes);` inside protected `/v1` scope after `readRoutes`.

## Verification Results

- Apply route module export check: `function`
- App route tree includes:
  - `/v1/read (POST)`
  - `/v1/apply (POST)`
- Test suites:
  - `tests_and_others/tests/server.test.mjs`: 20 passed, 0 failed
  - `tests_and_others/tests/auth.test.mjs`: 14 passed, 0 failed
  - `tests_and_others/tests/read.test.mjs`: 13 passed, 0 failed
