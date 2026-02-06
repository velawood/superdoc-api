---
phase: 06-apply-endpoint-core
plan: 03
type: execute
status: completed
completed: 2026-02-06
files_created:
  - tests_and_others/tests/apply.test.mjs
verification:
  - "node --test tests_and_others/tests/apply.test.mjs"
  - "node --test tests_and_others/tests/read.test.mjs"
  - "node --test tests_and_others/tests/server.test.mjs"
  - "node --test tests_and_others/tests/auth.test.mjs"
---

# Phase 06 Plan 03 Summary

Implemented comprehensive contract tests for `POST /v1/apply` in `tests_and_others/tests/apply.test.mjs`.

## Changes

1. Added multipart test helper coverage for mixed file + text fields
- Implemented `buildMultipartPayload(parts)` to build valid multipart requests with:
  - file parts (`fieldname`, `filename`, `content`, optional `contentType`)
  - text parts (`fieldname`, `value`) for `edits` JSON payloads

2. Added stable valid-block setup using `/v1/read`
- Added `resolveValidSeqId()` helper that:
  - uploads `sample.docx` to `/v1/read`
  - extracts a valid `seqId` from response blocks
- Tests use `seqId` for valid apply edits because UUID block IDs are regenerated per parse.

3. Added Suite 1: Happy Path
- Verifies `POST /v1/apply` with valid DOCX + valid comment edit returns:
  - `200`
  - `Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document`
  - `Content-Disposition` containing `attachment` and `-edited.docx`
  - binary non-empty payload with ZIP magic bytes `PK\x03\x04`

4. Added Suite 2: Edit Validation (APPLY-02)
- Verifies `400 INVALID_EDITS` for:
  - non-existent `blockId` (`missing_block`)
  - `replace` edit missing `newText` (`missing_field`)
- Verifies mixed valid + invalid edits reject the full request and return all invalid entries.
- Verifies each details entry includes: `editIndex`, `blockId`, `type`, `message`.

5. Added Suite 3: Input Validation
- Verifies:
  - missing file -> `400 MISSING_FILE`
  - missing edits -> `400 MISSING_EDITS`
  - malformed edits JSON -> `400 INVALID_EDITS_JSON`
  - non-array edits JSON -> `400 MISSING_EDITS`
  - PNG upload (non-DOCX magic bytes) -> `400 INVALID_FILE_TYPE`

6. Added Suite 4: Authentication
- Verifies:
  - no Authorization header -> `401 UNAUTHORIZED`
  - invalid Bearer token -> `401 UNAUTHORIZED`

7. Added Suite 5: Content-Type
- Verifies non-multipart (`application/json`) request returns:
  - `400 INVALID_CONTENT_TYPE`

## Verification Results

- `node --test tests_and_others/tests/apply.test.mjs`
  - 12 tests passed, 0 failed
- `node --test tests_and_others/tests/read.test.mjs`
  - 13 tests passed, 0 failed
- `node --test tests_and_others/tests/server.test.mjs`
  - 20 tests passed, 0 failed
- `node --test tests_and_others/tests/auth.test.mjs`
  - 14 tests passed, 0 failed
