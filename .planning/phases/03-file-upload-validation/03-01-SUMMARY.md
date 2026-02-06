---
phase: 03-file-upload-validation
plan: 01
subsystem: security
tags: [file-upload, multipart, validation, magic-bytes, zip-bomb, fastify]
requires: [02-01, 02-02]
provides: ["@fastify/multipart with 50MB limit", "Magic byte validation", "Zip bomb detection"]
affects: ["Phase 4 read endpoint", "All future file upload endpoints"]
tech-stack:
  added: ["@fastify/multipart"]
  patterns: ["Three-layer file validation pipeline: size → magic bytes → zip bomb"]
key-files:
  created:
    - src/plugins/multipart.mjs
    - src/validation/file-upload.mjs
  modified:
    - package.json
    - tests_and_others/tests/auth.test.mjs
key-decisions:
  - decision: "Multipart plugin wrapped with fastify-plugin for global availability"
    rationale: "Unlike auth plugin (route-scoped), multipart parsing must be available to all upload routes. Global registration prevents route-specific parser conflicts."
    impact: "All routes can accept file uploads without re-registering multipart"
  - decision: "Named imports work for unzipper (ESM compatible)"
    rationale: "Tested import { Open } from 'unzipper' and it works correctly despite unzipper being CJS"
    impact: "Clean import syntax, no destructuring workarounds needed"
  - decision: "Fix test suite for global multipart plugin"
    rationale: "Phase 2 tests tried to override multipart parser for testing, but global plugin now owns that content type"
    impact: "Tests simplified - rely on global plugin, no custom parser override"
duration: 3.5m
completed: 2026-02-06
---

# Phase 3 Plan 01: File Upload Validation Summary

Three-layer file upload validation pipeline: 50MB size limit, ZIP magic byte validation, and zip bomb detection via central directory scanning.

## Performance

- Duration: 3.5 minutes
- Started: 2026-02-06T22:18:26Z
- Completed: 2026-02-06T22:21:54Z
- Tasks: 2/2 (100%)
- Files created: 2
- Files modified: 2

## Accomplishments

**File upload protection established:**

1. **@fastify/multipart with size limits** - Global plugin for multipart file uploads
   - Installed @fastify/multipart 9.4.0
   - 50MB default file size limit (configurable via MAX_FILE_SIZE env var)
   - Auto-throws RequestFileTooLargeError (413) when limit exceeded
   - Wrapped with fastify-plugin for global availability
   - Registered in app.mjs after error-handler plugin

2. **Magic byte validation** - Inline 4-byte check for ZIP/DOCX files
   - validateMagicBytes() checks for PK\x03\x04 header
   - Rejects files smaller than 4 bytes
   - Rejects files with wrong magic bytes (e.g., PNG renamed to .docx)
   - Returns structured { valid, error } response

3. **Zip bomb detection** - Central directory metadata scan without decompression
   - checkZipBomb() uses unzipper Open.buffer() to read ZIP metadata
   - Sums uncompressedSize fields from all entries
   - Rejects if decompressed:compressed ratio > 100:1 (configurable)
   - Rejects if total decompressed size > 500MB (configurable)
   - Catches corrupted/invalid ZIP files with try/catch around Open.buffer()
   - Returns structured { safe, error, ratio, totalUncompressed } response

4. **Test infrastructure fixed** - Resolved conflict with global multipart plugin
   - Removed addContentTypeParser override from auth.test.mjs
   - Content-Type validation tests now rely on global multipart plugin
   - All 455 tests pass

## Task Commits

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Install @fastify/multipart and create plugin | 5bc4efd | package.json, package-lock.json, src/plugins/multipart.mjs |
| 2 | Create validation module and fix tests | fd0874d | src/validation/file-upload.mjs, tests_and_others/tests/auth.test.mjs |

## Files Created

- `src/plugins/multipart.mjs` - @fastify/multipart registration with 50MB file size limit, wrapped with fastify-plugin for global availability
- `src/validation/file-upload.mjs` - Reusable validation functions: validateMagicBytes (ZIP header check) and checkZipBomb (central directory ratio scan)

## Files Modified

- `package.json` - Added @fastify/multipart dependency
- `package-lock.json` - Updated with @fastify/multipart and dependencies (3 new packages)
- `tests_and_others/tests/auth.test.mjs` - Removed conflicting addContentTypeParser for Content-Type validation tests (now rely on global multipart plugin)
- `src/app.mjs` - (Already committed in Phase 4) Multipart plugin registered after error handler

## Decisions Made

**1. Multipart plugin wrapped with fastify-plugin for global availability**

The multipart plugin is wrapped with `fp(multipartPlugin, { name: "multipart" })` to make it non-encapsulated (global), unlike the auth plugin which is route-scoped.

**Rationale:** Upload routes in multiple locations (Phase 4 read, Phase 6 apply, future endpoints) all need multipart parsing. Global registration prevents route-specific parser conflicts and ensures consistent file size limits.

**Impact:** Any route can call `request.file()` without re-registering multipart. The 50MB limit applies globally.

**2. Named imports work for unzipper (ESM compatible)**

The validation module uses `import { Open } from "unzipper"` despite unzipper being a CJS package.

**Rationale:** Tested during implementation - Node.js ESM can import named exports from CJS via the ESM wrapper. No fallback to default import needed.

**Impact:** Clean, idiomatic import syntax. No `import unzipper from "unzipper"; const { Open } = unzipper;` workaround needed.

**3. Fix test suite for global multipart plugin**

The Phase 2 Content-Type validation test suite tried to register its own multipart content type parser with `scope.addContentTypeParser('multipart/form-data', ...)`. This conflicted with the global multipart plugin (FST_ERR_CTP_ALREADY_PRESENT).

**Rationale:** The test was written before the multipart plugin existed. Now that multipart is global, the custom parser override is unnecessary and causes conflicts. The requireMultipart hook (which just checks the Content-Type header) works fine with the global plugin.

**Impact:** Tests simplified - no custom parser needed. The global multipart plugin handles parsing, and requireMultipart hook checks the header.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test suite conflict with global multipart plugin**

- **Found during:** Task 2 verification (npm test)
- **Issue:** Content-Type validation test suite failed with FST_ERR_CTP_ALREADY_PRESENT error. The test tried to register a custom multipart content type parser, but the global multipart plugin already owns that content type.
- **Fix:** Removed the conflicting `scope.addContentTypeParser('multipart/form-data', ...)` call from auth.test.mjs. The test now relies on the global multipart plugin for parsing, while requireMultipart hook still validates the Content-Type header.
- **Files modified:** tests_and_others/tests/auth.test.mjs
- **Commit:** fd0874d (Task 2 commit)
- **Verification:** All 455 tests pass after fix

## Issues Encountered

**Test infrastructure conflict (resolved)**

The Phase 2 auth tests registered a custom multipart parser to test the Content-Type validation hook. This conflicted with the global multipart plugin introduced in Phase 3. Fixed by removing the custom parser override - the global plugin handles parsing correctly.

## Validation Module API

### validateMagicBytes(buffer)

Checks that buffer starts with ZIP magic bytes `PK\x03\x04` (hex: 0x50 0x4B 0x03 0x04).

**Parameters:**
- `buffer` (Buffer) - Uploaded file buffer

**Returns:**
- `{ valid: true }` - File has valid ZIP header
- `{ valid: false, error: string }` - File rejected (too small or wrong magic bytes)

**Usage:**
```javascript
import { validateMagicBytes } from "./validation/file-upload.mjs";

const result = validateMagicBytes(buffer);
if (!result.valid) {
  return reply.status(400).send({
    error: { code: "INVALID_FILE_TYPE", message: result.error, details: [] }
  });
}
```

### checkZipBomb(buffer, opts)

Scans ZIP central directory metadata to detect high compression ratios without decompressing.

**Parameters:**
- `buffer` (Buffer) - Uploaded file buffer (must be valid ZIP)
- `opts` (Object, optional):
  - `maxRatio` (Number) - Max allowed decompressed:compressed ratio (default: 100)
  - `maxDecompressedSize` (Number) - Absolute max decompressed bytes (default: 500MB)

**Returns:**
- `{ safe: true, ratio, totalUncompressed }` - File passed checks
- `{ safe: false, error, ratio, totalUncompressed }` - File rejected or corrupted

**Usage:**
```javascript
import { checkZipBomb } from "./validation/file-upload.mjs";

const result = await checkZipBomb(buffer);
if (!result.safe) {
  return reply.status(400).send({
    error: { code: "ZIP_BOMB_DETECTED", message: result.error, details: [] }
  });
}
```

## Next Phase Readiness

**Ready for Phase 4 (Read Endpoint) and beyond:**

- ✅ @fastify/multipart registered globally with 50MB limit
- ✅ validateMagicBytes function ready to reject non-DOCX files
- ✅ checkZipBomb function ready to detect malicious archives
- ✅ Reusable validation pipeline for all upload routes
- ✅ All existing tests pass (zero regressions)
- ✅ Test infrastructure compatible with global multipart plugin

**Note:** Phase 4 read endpoint (commit 15a6d42) already uses this validation infrastructure. The read route imports validateMagicBytes and checkZipBomb from src/validation/file-upload.mjs and calls them in the handler pipeline.

**Blockers:** None

**Concerns:** None

## Self-Check: PASSED

**Created files verified:**
- ✅ src/plugins/multipart.mjs exists
- ✅ src/validation/file-upload.mjs exists

**Commits verified:**
- ✅ 5bc4efd exists (Task 1: multipart plugin)
- ✅ fd0874d exists (Task 2: validation module)
