# Requirements: Superdoc API

**Defined:** 2026-02-06
**Core Value:** Users can programmatically edit DOCX documents with track changes via simple HTTP requests, without installing any local tooling.

## v1 Requirements

### Server Infrastructure

- [ ] **INFRA-01**: GET /health returns `{"status":"ok"}` with 200 (no JSDOM/SuperDoc dependency)
- [ ] **INFRA-02**: Every request gets a unique X-Request-Id header (echo client-provided or generate UUID)
- [ ] **INFRA-03**: All errors return structured JSON: `{"error":{"code":"...","message":"...","details":[...]}}`
- [ ] **INFRA-04**: Proper HTTP status codes: 400, 401, 413, 422, 500, 503
- [ ] **INFRA-05**: Server-side request timeout (120s default) with resource cleanup on timeout
- [ ] **INFRA-06**: Graceful shutdown on SIGTERM/SIGINT (drain in-flight requests, then exit)
- [ ] **INFRA-07**: API versioning with /v1/ URL prefix

### Authentication & Security

- [x] **AUTH-01**: API key validation via Authorization: Bearer header (timing-safe comparison)
- [x] **AUTH-02**: Reject requests with missing or invalid API key with 401
- [ ] **AUTH-03**: File size limit enforcement (50MB default, configurable via env var), reject with 413
- [x] **AUTH-04**: Content-Type validation (require multipart/form-data for upload endpoints)
- [ ] **AUTH-05**: DOCX magic byte validation (PK\x03\x04 ZIP header check)
- [x] **AUTH-06**: Error sanitization — never expose internal paths, stack traces, or library details in responses
- [ ] **AUTH-07**: Zip bomb protection — check decompressed ZIP size before processing

### Read Endpoint

- [x] **READ-01**: POST /v1/read accepts multipart DOCX upload and returns document IR as JSON
- [x] **READ-02**: Response includes full document structure (blocks, outline, defined terms, ID mapping)
- [x] **READ-03**: All chunks returned in single response

### Apply Endpoint

- [ ] **APPLY-01**: POST /v1/apply accepts multipart DOCX upload + edits (JSON or markdown)
- [ ] **APPLY-02**: Auto-validates edits before applying; rejects with full validation error list if invalid
- [ ] **APPLY-03**: Returns recompressed DOCX binary with Content-Disposition header
- [ ] **APPLY-04**: Supports JSON edit format (v0.2.0 schema)
- [ ] **APPLY-05**: Supports markdown edit format (auto-detected and parsed)
- [ ] **APPLY-06**: Dry-run mode via ?dry_run=true — validates and returns report without producing DOCX
- [ ] **APPLY-07**: Edit summary response headers (X-Edits-Applied, X-Edits-Skipped, X-Warnings)

### Resource Management

- [ ] **RES-01**: JSDOM window cleanup after every request (editor.destroy() + window.close())
- [ ] **RES-02**: Concurrency limiting — semaphore to prevent simultaneous JSDOM instances from OOMing
- [ ] **RES-03**: Temp file cleanup in finally blocks (apply endpoint uses temp files for domain modules)

## v2 Requirements

### Enhanced Features

- **FEAT-01**: Configurable strictness via query params (strict, skip_invalid)
- **FEAT-02**: Author attribution passthrough (author_name, author_email)
- **FEAT-03**: Compressed JSON responses (gzip middleware)
- **FEAT-04**: CORS headers for browser clients
- **FEAT-05**: Readiness endpoint (GET /ready for K8s probes)
- **FEAT-06**: OpenAPI/Swagger specification
- **FEAT-07**: Idempotency keys (Idempotency-Key header with cache)
- **FEAT-08**: Retry-After headers on 429/503 responses

## Out of Scope

| Feature | Reason |
|---------|--------|
| Server-side file storage | Stateless by design — process and return, no persisted documents |
| Async job queue / polling | Processing is <2min synchronous; job system adds massive complexity |
| Webhook callbacks | No async processing means nothing to notify about |
| Batch operations | Memory-intensive JSDOM per document; one doc per request |
| Document format conversion | Core value is DOCX editing, not conversion (PDF, HTML, etc.) |
| OAuth2 / complex auth | API key auth is sufficient for programmatic access |
| WebSocket / streaming | DOCX must be fully assembled before sending; nothing to stream |
| Rate limiting in app | Handled at infrastructure level (reverse proxy / API gateway) |
| User management / signup | API keys managed outside the service |
| GraphQL | Two endpoints; REST is simpler and sufficient |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 1 | Complete |
| INFRA-02 | Phase 1 | Complete |
| INFRA-03 | Phase 1 | Complete |
| INFRA-04 | Phase 1 | Complete |
| INFRA-05 | Phase 8 | Pending |
| INFRA-06 | Phase 8 | Pending |
| INFRA-07 | Phase 1 | Complete |
| AUTH-01 | Phase 2 | Complete |
| AUTH-02 | Phase 2 | Complete |
| AUTH-03 | Phase 3 | Pending |
| AUTH-04 | Phase 2 | Complete |
| AUTH-05 | Phase 3 | Pending |
| AUTH-06 | Phase 2 | Complete |
| AUTH-07 | Phase 3 | Pending |
| READ-01 | Phase 4 | Complete |
| READ-02 | Phase 4 | Complete |
| READ-03 | Phase 4 | Complete |
| APPLY-01 | Phase 6 | Pending |
| APPLY-02 | Phase 6 | Pending |
| APPLY-03 | Phase 6 | Pending |
| APPLY-04 | Phase 6 | Pending |
| APPLY-05 | Phase 7 | Pending |
| APPLY-06 | Phase 7 | Pending |
| APPLY-07 | Phase 7 | Pending |
| RES-01 | Phase 5 | Pending |
| RES-02 | Phase 5 | Pending |
| RES-03 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 27 total
- Mapped to phases: 27
- Unmapped: 0

---
*Requirements defined: 2026-02-06*
*Last updated: 2026-02-06 after Phase 4 completion*
