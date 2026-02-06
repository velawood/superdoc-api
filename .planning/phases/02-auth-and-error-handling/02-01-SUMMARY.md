---
phase: 02-auth-and-error-handling
plan: 01
subsystem: security
tags: [auth, bearer-token, error-handling, fastify, security]
requires: [01-01, 01-02]
provides: ["Bearer auth on /v1 routes", "Content-Type validation hook", "Sanitized error responses"]
affects: ["All future /v1 endpoints", "Phase 3 upload routes"]
tech-stack:
  added: ["@fastify/bearer-auth"]
  patterns: ["Route-scoped auth via Fastify encapsulation", "Fail-fast API_KEY validation"]
key-files:
  created:
    - src/plugins/auth.mjs
    - src/hooks/content-type-check.mjs
  modified:
    - src/app.mjs
    - src/plugins/error-handler.mjs
    - tests_and_others/tests/server.test.mjs
key-decisions:
  - decision: "Auth plugin NOT wrapped with fastify-plugin"
    rationale: "Must be route-scoped, not global. Phase 1 plugins (request-id, error-handler) needed to be global; auth must only apply inside /v1 scope"
    impact: "Auth applies only where explicitly registered"
  - decision: "Fail-fast on missing API_KEY"
    rationale: "Server should not start without required security configuration"
    impact: "Prevents accidental deployment without authentication"
  - decision: "isSafeMessage sanitization for 4xx errors"
    rationale: "Error messages can leak file paths, stack traces, or internal details"
    impact: "All 4xx non-validation errors scrubbed before sending to client"
duration: 3.3m
completed: 2026-02-06
---

# Phase 2 Plan 01: Auth and Error Handling Summary

Bearer token auth scoped to /v1 routes, multipart Content-Type validation hook, and hardened error message sanitization.

## Performance

- Duration: 3.3 minutes
- Started: 2026-02-06T22:05:13Z
- Completed: 2026-02-06T22:08:30Z
- Tasks: 2/2 (100%)
- Files modified: 5

## Accomplishments

**Security foundation established:**

1. **Bearer token authentication** - @fastify/bearer-auth integrated with route-scoped plugin
   - API_KEY required from environment or test opts
   - Fail-fast validation: server refuses to start without API_KEY
   - Auth scoped to /v1 via Fastify encapsulation (NOT global with URL allowlist)
   - Root /health remains unprotected for infrastructure probes
   - All /v1/* routes require valid Bearer token

2. **Content-Type validation hook** - requireMultipart preHandler created for future upload routes
   - Rejects non-multipart requests with 400 INVALID_CONTENT_TYPE
   - Returns reply after reply.send() to prevent handler continuation (Pitfall 6)
   - Ready for Phase 3 upload endpoint integration

3. **Error message sanitization** - isSafeMessage guard added to error handler
   - Scrubs file paths (src/, node_modules/, Users/, etc.)
   - Scrubs stack traces (at function() patterns)
   - Scrubs file extensions (.mjs:, .js:, etc.)
   - 5xx errors remain generic ("An internal server error occurred")
   - 4xx errors sanitized: safe messages pass through, unsafe messages → "Bad request"
   - Validation errors preserve field-level details (unchanged)

## Task Commits

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Install bearer auth and wire protected routes | f9d39fe | package.json, src/plugins/auth.mjs, src/app.mjs, tests_and_others/tests/server.test.mjs |
| 2 | Create Content-Type hook and sanitize error messages | 5fe88d7 | src/hooks/content-type-check.mjs, src/plugins/error-handler.mjs |

## Files Created

- `src/plugins/auth.mjs` - Bearer token auth plugin (route-scoped, not global)
- `src/hooks/content-type-check.mjs` - Multipart Content-Type validation preHandler

## Files Modified

- `src/app.mjs` - Added protectedRoutes scope at /v1 prefix, auth plugin registered inside
- `src/plugins/error-handler.mjs` - Added isSafeMessage guard, sanitize 4xx non-validation errors
- `tests_and_others/tests/server.test.mjs` - Updated all test suites to pass apiKey option, added Authorization headers for /v1 routes
- `package.json` - Added @fastify/bearer-auth dependency

## Decisions Made

**1. Auth plugin NOT wrapped with fastify-plugin**

Phase 1 plugins (request-id, error-handler) used fastify-plugin because they need to apply globally. Auth is different: it must be route-scoped. Wrapping with fastify-plugin would make auth apply to ALL routes (including root /health), which violates the requirement that root /health remain unprotected.

**Impact:** Auth only applies where explicitly registered (inside /v1 scope). Future route groups can choose different auth strategies.

**2. Fail-fast API_KEY validation**

Server throws during startup if API_KEY is missing from both environment and opts. This prevents accidental deployment without authentication configured.

**Impact:** Deployment will fail immediately if API_KEY not set, rather than silently accepting unauthenticated requests.

**3. isSafeMessage sanitization for 4xx errors**

Error messages from libraries or framework can leak file paths (/Users/alin/code/work/superdoc-api/src/...), stack traces (at buildApp (/path/to/app.mjs:23:45)), or module details. These must be scrubbed before sending to clients.

**Impact:**
- 5xx errors: Always generic ("An internal server error occurred")
- 4xx validation errors: Field-level details preserved (need for client debugging)
- 4xx non-validation errors: Message scrubbed if unsafe, fallback to "Bad request"

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. All tasks completed without blockers.

## Next Phase Readiness

**Ready for Phase 3 (File Upload Validation):**

- ✅ Bearer auth working on /v1 routes
- ✅ requireMultipart hook ready for upload endpoints
- ✅ Error sanitization prevents internal detail leakage
- ✅ All existing tests pass (zero regressions)

**Blockers:** None

**Concerns:** None

## Self-Check: PASSED

**Created files verified:**
- ✅ src/plugins/auth.mjs exists
- ✅ src/hooks/content-type-check.mjs exists

**Commits verified:**
- ✅ f9d39fe exists (Task 1: auth plugin)
- ✅ 5fe88d7 exists (Task 2: content-type hook)
