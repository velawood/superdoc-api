# Roadmap: Superdoc API

## Overview

This roadmap delivers a stateless HTTP API that wraps the existing superdoc-redline CLI, enabling programmatic DOCX editing with track changes via simple HTTP requests. The 8 phases progress from server infrastructure through security layers and domain integration to production hardening, with each phase delivering a coherent, verifiable capability. The read endpoint ships before apply (simpler integration path), and resource management ships before the memory-intensive apply endpoint to prevent the critical JSDOM memory leak.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation** - Fastify server bootstrap with health check, error format, API versioning, and request tracing
- [x] **Phase 2: Auth and Error Handling** - API key authentication middleware and error sanitization
- [ ] **Phase 3: File Upload Validation** - File size limits, DOCX magic byte validation, and zip bomb protection
- [x] **Phase 4: Read Endpoint** - POST /v1/read accepts DOCX upload and returns document IR as JSON
- [ ] **Phase 5: Resource Management** - JSDOM lifecycle cleanup, concurrency limiting, and temp file management
- [ ] **Phase 6: Apply Endpoint Core** - POST /v1/apply accepts DOCX + JSON edits and returns redlined DOCX
- [ ] **Phase 7: Apply Endpoint Extended** - Markdown edit support, dry-run mode, and edit summary headers
- [ ] **Phase 8: Production Hardening** - Request timeouts with resource cleanup and graceful shutdown

## Phase Details

### Phase 1: Foundation
**Goal**: A running Fastify server responds to requests with structured JSON, versioned URL routing, and request tracing
**Depends on**: Nothing (first phase)
**Requirements**: INFRA-01, INFRA-02, INFRA-03, INFRA-04, INFRA-07
**Success Criteria** (what must be TRUE):
  1. GET /health returns {"status":"ok"} with HTTP 200, with no SuperDoc or JSDOM dependency
  2. Every HTTP response includes an X-Request-Id header (echoed from client or server-generated UUID)
  3. Any error (404, malformed request) returns structured JSON with error.code, error.message, and error.details
  4. The server uses correct HTTP status codes (400 for bad requests, 404 for unknown routes, 500 for server errors)
  5. All endpoints are mounted under the /v1/ URL prefix
**Plans**: 2 plans

Plans:
- [x] 01-01-PLAN.md — Server bootstrap (Fastify 5, app factory, plugins, health route, request ID, error handler, /v1/ prefix)
- [x] 01-02-PLAN.md — TDD: Server behavior tests (health, tracing, errors, status codes, versioning)

### Phase 2: Auth and Error Handling
**Goal**: Unauthorized requests are rejected before reaching any endpoint, and error responses never leak internal details
**Depends on**: Phase 1
**Requirements**: AUTH-01, AUTH-02, AUTH-04, AUTH-06
**Success Criteria** (what must be TRUE):
  1. Requests with a valid Bearer token in the Authorization header pass through to the endpoint
  2. Requests with missing or invalid API key receive 401 with structured error body (no details about why the key is wrong)
  3. POST requests to upload endpoints without multipart/form-data Content-Type receive 400 with clear error message
  4. When the server encounters an internal error, the response contains a safe error code and message -- no file paths, stack traces, or library details
**Plans**: 2 plans

Plans:
- [x] 02-01-PLAN.md — Auth plugin, Content-Type hook, and error sanitization implementation
- [x] 02-02-PLAN.md — TDD: Auth, Content-Type validation, and error sanitization tests

### Phase 3: File Upload Validation
**Goal**: Malicious or oversized file uploads are rejected before any document processing begins
**Depends on**: Phase 2
**Requirements**: AUTH-03, AUTH-05, AUTH-07
**Success Criteria** (what must be TRUE):
  1. Uploading a file larger than the configured size limit (default 50MB) returns 413 with a structured error body
  2. Uploading a non-DOCX file (e.g., a PNG renamed to .docx) is rejected based on magic byte validation (PK\x03\x04 ZIP header)
  3. Uploading a zip bomb (small compressed, enormous decompressed) is detected and rejected before full decompression
**Plans**: 2 plans

Plans:
- [ ] 03-01-PLAN.md — Install @fastify/multipart, create multipart plugin, file upload validation module (magic bytes + zip bomb)
- [ ] 03-02-PLAN.md — TDD: File size limit, magic byte validation, and zip bomb detection tests

### Phase 4: Read Endpoint
**Goal**: Users can upload a DOCX file and receive its complete structured representation as JSON
**Depends on**: Phase 3
**Requirements**: READ-01, READ-02, READ-03
**Success Criteria** (what must be TRUE):
  1. POST /v1/read with a valid DOCX file returns 200 with JSON containing the document's block structure, outline, defined terms, and ID mapping
  2. The response includes all chunks in a single JSON payload (no pagination, no streaming)
  3. Invalid or corrupted DOCX files return a clear error (not an unhandled crash or stack trace)
**Plans**: 2 plans

Plans:
- [x] 04-01-PLAN.md — Read route handler (POST /v1/read with validation pipeline + IR extraction)
- [x] 04-02-PLAN.md — TDD: Read endpoint contract tests (happy path, errors, auth, Content-Type)

### Phase 5: Resource Management
**Goal**: The server can process many sequential requests without memory leaks, event loop blocking, or orphaned temp files
**Depends on**: Phase 4
**Requirements**: RES-01, RES-02, RES-03
**Success Criteria** (what must be TRUE):
  1. After processing a document, the JSDOM window and editor are fully destroyed (no memory growth over 20+ sequential requests)
  2. When multiple requests arrive simultaneously, a concurrency limiter queues excess requests instead of spawning unbounded JSDOM instances
  3. Temp files created during document processing are cleaned up in all code paths (success, error, timeout)
  4. A request that fails mid-processing does not leave behind leaked JSDOM instances or orphaned temp files
**Plans**: TBD

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD

### Phase 6: Apply Endpoint Core
**Goal**: Users can upload a DOCX file with JSON edits and receive a redlined document with tracked changes
**Depends on**: Phase 5
**Requirements**: APPLY-01, APPLY-02, APPLY-03, APPLY-04
**Success Criteria** (what must be TRUE):
  1. POST /v1/apply with a DOCX file and JSON edits (v0.2.0 schema) returns a recompressed DOCX binary with Content-Disposition header
  2. If any edits reference invalid block IDs or fail validation, the entire request is rejected with a full list of validation errors (no partial application)
  3. The returned DOCX file is recompressed (not the inflated SuperDoc output size)
  4. The endpoint handles both the happy path (valid edits applied) and all error paths (bad edits, corrupted DOCX, processing failure) with structured responses
**Plans**: TBD

Plans:
- [ ] 06-01: TBD
- [ ] 06-02: TBD
- [ ] 06-03: TBD

### Phase 7: Apply Endpoint Extended
**Goal**: The apply endpoint supports markdown edit format, dry-run validation, and returns edit metadata in response headers
**Depends on**: Phase 6
**Requirements**: APPLY-05, APPLY-06, APPLY-07
**Success Criteria** (what must be TRUE):
  1. POST /v1/apply with markdown-formatted edits (instead of JSON) auto-detects the format, parses to JSON, and applies edits identically to JSON input
  2. POST /v1/apply?dry_run=true validates edits and returns a validation report without producing or returning a DOCX file
  3. Successful apply responses include X-Edits-Applied, X-Edits-Skipped, and X-Warnings headers with accurate counts
**Plans**: TBD

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD

### Phase 8: Production Hardening
**Goal**: The server handles timeouts and shutdowns gracefully without losing in-flight work or leaking resources
**Depends on**: Phase 7
**Requirements**: INFRA-05, INFRA-06
**Success Criteria** (what must be TRUE):
  1. A request that exceeds the timeout limit (default 120s) is terminated with a 503 response, and all resources (JSDOM, temp files) are cleaned up
  2. On SIGTERM/SIGINT, the server stops accepting new connections, waits for in-flight requests to complete (with a drain timeout), then exits cleanly
  3. A request in progress during shutdown completes normally (not killed mid-processing)
**Plans**: TBD

Plans:
- [ ] 08-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8

| Phase | Plans Complete | Status | Completed |
|-------|---------------|--------|-----------|
| 1. Foundation | 2/2 | Complete | 2026-02-06 |
| 2. Auth and Error Handling | 2/2 | Complete | 2026-02-06 |
| 3. File Upload Validation | 0/2 | Not started | - |
| 4. Read Endpoint | 2/2 | Complete | 2026-02-06 |
| 5. Resource Management | 0/TBD | Not started | - |
| 6. Apply Endpoint Core | 0/TBD | Not started | - |
| 7. Apply Endpoint Extended | 0/TBD | Not started | - |
| 8. Production Hardening | 0/TBD | Not started | - |
