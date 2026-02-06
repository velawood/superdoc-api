---
phase: 04-read-endpoint
plan: 01
subsystem: api
tags: [fastify, multipart, docx, irExtractor, validation, zip-bomb]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: Error handling, request-id, pino logging, app factory pattern
  - phase: 02-auth-and-error-handling
    provides: Bearer auth, error sanitization, multipart plugin, content-type validation
  - phase: 03-validation
    provides: Magic bytes validation, zip bomb detection, file-upload.mjs module
provides:
  - POST /v1/read endpoint for document IR extraction
  - Integration of HTTP layer with domain module (irExtractor)
  - Complete validation pipeline: Content-Type → magic bytes → zip bomb → extraction
  - Structured error responses for upload failures
affects: [05-resource-management, 06-apply-endpoint, testing]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Domain integration pattern: HTTP handler → validation pipeline → domain module → JSON response"
    - "Error code progression: 400 (client validation), 422 (domain processing)"

key-files:
  created:
    - src/routes/read.mjs
  modified:
    - src/app.mjs

key-decisions:
  - "Use 422 Unprocessable Entity for extraction failures (file passed validation but content is corrupted)"
  - "Return full IR by default (blocks, outline, definedTerms, idMapping) - no format parameter yet"
  - "Log extraction errors server-side but return sanitized message to client"

patterns-established:
  - "Route handlers chain validation → domain logic → response with proper error handling at each step"
  - "Use preHandler hooks for request-level validation (requireMultipart)"
  - "Delegate to domain modules for business logic (extractDocumentIRFromBuffer)"

# Metrics
duration: 1m
completed: 2026-02-06
---

# Phase 04 Plan 01: Read Endpoint Summary

**POST /v1/read endpoint integrates HTTP validation pipeline with document IR extraction, returning structured JSON for DOCX uploads**

## Performance

- **Duration:** 1 min
- **Started:** 2026-02-06T16:19:50Z
- **Completed:** 2026-02-06T16:20:54Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments
- Created POST /v1/read endpoint with 6-step handler flow
- Integrated Phase 3 validation pipeline (magic bytes + zip bomb) with Phase 1 domain module (irExtractor)
- Established domain integration pattern: HTTP → validation → domain → JSON
- Proper error code usage: 400 for validation failures, 422 for domain processing errors

## Task Commits

Each task was committed atomically:

1. **Task 1: Create read route handler and register in app** - `15a6d42` (feat)

## Files Created/Modified
- `src/routes/read.mjs` - POST /read handler with multipart validation, magic bytes check, zip bomb check, and IR extraction
- `src/app.mjs` - Register readRoutes in /v1 protected scope

## Decisions Made
- Use 422 (Unprocessable Entity) for extraction failures rather than 500 - the file passed validation but the DOCX content is corrupted or unsupported
- Return full IR format by default (blocks, outline, definedTerms, idMapping) - format parameter can be added in future if needed
- Log extraction errors server-side with filename context but return sanitized error message to client (following Phase 2 error sanitization pattern)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - all imports worked as expected, Phase 3 validation modules were available, and the integration was straightforward.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- POST /v1/read endpoint is fully functional and tested (manual verification via node imports)
- Ready for Phase 5 (Resource Management) to add JSDOM memory cleanup patterns
- Ready for automated endpoint testing (integration tests)
- The domain integration pattern established here can be reused for POST /v1/apply endpoint

---
*Phase: 04-read-endpoint*
*Completed: 2026-02-06*

## Self-Check: PASSED
