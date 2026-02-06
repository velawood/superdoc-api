# Project Research Summary

**Project:** superdoc-api
**Domain:** Document processing HTTP API (DOCX editing as a service)
**Researched:** 2026-02-06
**Confidence:** MEDIUM-HIGH

## Executive Summary

This project wraps the existing superdoc-redline CLI tool with an HTTP API layer. The CLI provides robust DOCX editing capabilities (applying tracked changes, extracting document IR) built on SuperDoc, JSDOM, and ProseMirror. The HTTP API should be a thin adapter layer that translates HTTP requests into calls to existing domain modules and returns results, without modifying the tested CLI codebase.

The recommended approach is Fastify-based HTTP server with stateless, synchronous request/response processing. Each request uploads a DOCX file, processes it in memory (creating a new JSDOM/Editor instance per request), and returns either a modified DOCX or JSON IR. The architecture must address the critical memory management concern: JSDOM window objects leak in long-running processes unless explicitly cleaned up with `window.close()`. Without this, the server will OOM after 50-100 requests. The second critical concern is event loop blocking -- document processing is CPU-bound and can block for 5-10 seconds on large documents, requiring concurrency limiting to prevent health check failures.

The key risks are memory leaks (JSDOM), event loop blocking (ProseMirror processing), and malicious file uploads (zip bombs). Mitigation requires proper resource cleanup (try/finally with window.close()), concurrency limiting (process one document at a time or use worker threads), and input validation (file size limits, magic byte checking, decompressed size validation). The existing CLI code already handles domain logic correctly -- the HTTP layer's only job is safe resource lifecycle management.

## Key Findings

### Recommended Stack

The stack should leverage Fastify 5 as the HTTP framework for its built-in capabilities that match this use case: JSON Schema validation, structured logging via Pino, multipart file upload handling via `@fastify/multipart`, and graceful shutdown support. The existing domain modules (SuperDoc, JSDOM, ProseMirror, diff-match-patch) remain unchanged.

**Core technologies:**
- **Fastify 5**: HTTP server with schema validation, request logging, and plugin architecture designed for file-processing APIs
- **@fastify/multipart**: First-party multipart parser with Buffer mode for in-memory DOCX processing (no disk writes needed)
- **Fastify JSON Schema (Ajv)**: Built-in validation for edit configuration payloads without additional dependencies
- **Pino (via Fastify)**: Structured JSON logging with request ID correlation for debugging file processing failures
- **Docker + PM2**: Containerized deployment with multi-worker process management to handle CPU-bound JSDOM processing

**Critical version note:** Fastify 5 has ESM support matching the existing codebase. Exact minor versions for @fastify plugins need verification with `npm view` before installation (research flagged versions as MEDIUM/LOW confidence due to unavailable WebSearch).

**Key architectural decision:** Use temp files for the apply endpoint (existing `applyEdits()` expects file paths) but direct buffer processing for the read endpoint (existing `extractDocumentIRFromBuffer()` accepts buffers). This avoids modifying tested production code while enabling HTTP integration.

### Expected Features

**Must have (table stakes):**
- Multipart file upload with DOCX validation (magic bytes + ZIP structure check)
- Binary DOCX response with Content-Disposition header for apply endpoint
- JSON response for read/extract endpoint
- Structured JSON error responses with proper HTTP status codes (400/401/413/422/500)
- Request ID tracing (X-Request-Id header + log correlation)
- API key authentication (Bearer token, timing-safe comparison)
- Health check endpoint (GET /health)
- File size limit enforcement (default 50MB, configurable)
- Request timeout handling (120s with resource cleanup)
- Graceful shutdown (SIGTERM handling with connection draining)

**Should have (competitive differentiators):**
- Validation-only dry-run mode (query param: ?dry_run=true)
- API versioning (/v1/ prefix from day one)
- Edit summary response headers (X-Edits-Applied, X-Edits-Skipped, X-Warnings)
- Configurable strictness via query params (strict, skip_invalid)
- Markdown edit format support (already in CLI, just expose via API)
- Author attribution passthrough (author_name, author_email fields)
- Compressed JSON responses (gzip for IR output)
- Readiness endpoint (GET /ready for K8s probes)
- CORS headers (enable browser clients)

**Defer (v2+):**
- Idempotency keys (requires cache infrastructure)
- OpenAPI spec generation (high value but not blocking)
- Retry-After headers (add when load patterns understood)
- Worker thread isolation (only if needed for crash isolation)

**Anti-features (do not build):**
- Server-side file storage (stateless by design)
- Async job queue with polling (processing is <2min, use sync model)
- Webhook callbacks (no async processing, so nothing to notify)
- Batch operations (memory-intensive, process one document per request)
- Server-side format conversion (out of scope, return DOCX only)
- OAuth2 (API key auth is sufficient and simpler)

### Architecture Approach

The architecture is a layered adapter pattern: thin HTTP layer that translates requests into domain module calls without modifying existing code. All new HTTP functionality lives in separate directories (routes/, handlers/, services/, middleware/) while existing src/*.mjs domain modules remain untouched.

**Major components:**
1. **Server bootstrap** (server.mjs) — Fastify instance creation, plugin registration, lifecycle hooks
2. **Route definitions** (routes/) — Map HTTP endpoints to handlers with schema validation
3. **Request handlers** (handlers/) — Parse multipart uploads, call services, format responses
4. **Service layer** (services/) — Adapter between HTTP buffers and domain module file path expectations; manages temp file lifecycle
5. **Temp file manager** (lib/tempFiles.mjs) — Create temp files for domain modules, guarantee cleanup in try/finally
6. **Concurrency limiter** (lib/concurrency.mjs) — Semaphore to prevent simultaneous JSDOM instances from OOMing the process
7. **Auth middleware** (middleware/auth.mjs) — Validate Bearer token using crypto.timingSafeEqual
8. **Error middleware** (middleware/errors.mjs) — Sanitize errors, prevent leaking internal paths/stack traces
9. **Domain modules** (src/*.mjs, unchanged) — All existing SuperDoc/JSDOM/ProseMirror logic

**Data flow for POST /apply:** Multipart upload -> auth check -> parse file buffer + edits JSON -> write buffer to temp file -> call `applyEdits(inputPath, outputPath, config, options)` -> read output file to buffer -> delete temp files (in finally block) -> return DOCX binary with metadata headers.

**Critical pattern:** Every request creates a new JSDOM instance via `createHeadlessEditor()`, processes the document, and must call both `editor.destroy()` AND `window.close()`. The current CLI code only calls `editor.destroy()` -- the HTTP wrapper must refactor the editor factory to return a cleanup function that includes `window.close()`.

### Critical Pitfalls

1. **JSDOM window leak (the silent memory killer)** — The CLI creates JSDOM instances but never calls `window.close()`. In a long-running server, each request leaks 50-100MB of virtual DOM. After 50-100 requests, the process OOMs. **Prevention:** Refactor `createHeadlessEditor()` to return `{ editor, cleanup }` where cleanup calls `editor.destroy() + window.close()`. Wrap every request in try/finally that guarantees cleanup runs.

2. **Event loop blocking during document processing** — Document processing is CPU-bound (JSDOM parsing, ProseMirror traversals, diff-match-patch). A large document blocks the event loop for 5-10 seconds, making health checks timeout and triggering load balancer removal. **Prevention:** Use a concurrency limiter (semaphore with max=1 or N) to process one document at a time. Monitor event loop lag. Phase 2: use worker threads for true isolation.

3. **DOCX zip bomb and malicious uploads** — DOCX files are ZIP archives. Malicious uploads can be zip bombs (small compressed, gigabytes decompressed), XML entity expansion attacks, or crafted ZIPs. **Prevention:** File size limit at HTTP layer (50MB), decompressed size validation (check ZIP central directory without extracting), processing timeout (60s), magic byte validation (PK\x03\x04 + [Content_Types].xml + word/document.xml).

4. **Error responses leaking internal details** — CLI errors contain file paths, library versions, ProseMirror schema details. HTTP responses must sanitize these. **Prevention:** Error mapping layer that translates internal errors to safe codes/messages. Log full errors server-side, return only sanitized messages. Never include stack traces in responses.

5. **Temp file cleanup on error paths** — The recompress step creates temp directories but cleanup only runs in success path, not in finally block. In a server, every failed request leaves orphaned temp files. **Prevention:** Always use try/finally for cleanup. For HTTP API, avoid temp files where possible (use buffer-based processing).

6. **Request timeout vs processing time mismatch** — Documents take variable time to process (5-page doc = 500ms, 200-page doc = 60s). Mismatched timeouts cause clients to timeout while server continues processing. **Prevention:** Set conservative server timeout (120s), document expected processing times, add size-based heuristics to reject oversized documents upfront.

## Implications for Roadmap

Based on research, the implementation naturally divides into 6 phases ordered by technical dependencies and risk mitigation priorities.

### Phase 1: Foundation + Health Check
**Rationale:** Validate framework choice and deployment before building domain integration. Zero dependency on SuperDoc/JSDOM means fastest feedback on infrastructure correctness.

**Delivers:** Running Fastify server with health endpoint, config from environment variables, basic logging.

**Addresses:** Health check endpoint (table stakes from FEATURES.md)

**Avoids:** N/A (no domain integration yet)

**Research needs:** None (standard Fastify setup, well-documented)

### Phase 2: Auth + Error Handling Infrastructure
**Rationale:** Every subsequent endpoint needs auth and error handling. Build once, use everywhere. Ensures security and consistency from the start.

**Delivers:** Auth middleware with timing-safe key comparison, error sanitization middleware with structured response format, request ID tracing.

**Addresses:** API key authentication, structured error responses, request ID tracing (all table stakes)

**Avoids:** Pitfall 12 (timing attacks), Pitfall 4 (error leaking)

**Research needs:** None (standard patterns)

### Phase 3: Read Endpoint (Simpler Path)
**Rationale:** The read endpoint is simpler than apply (no temp files needed, buffer-based via `extractDocumentIRFromBuffer`). Validates multipart upload parsing and domain module integration without the complexity of temp file lifecycle management.

**Delivers:** POST /v1/read endpoint that accepts DOCX upload, returns document IR as JSON.

**Addresses:** Read/extract endpoint, multipart upload, file size limits, content-type validation (table stakes)

**Avoids:** Pitfall 3 (file upload validation, magic bytes check)

**Research needs:** None (uses existing `extractDocumentIRFromBuffer`)

### Phase 4: JSDOM Lifecycle Fix + Concurrency Limiting
**Rationale:** Must solve the critical memory leak before building the apply endpoint. Refactor editor factory to enable proper cleanup. Add concurrency limiting to prevent event loop blocking.

**Delivers:** Refactored `createHeadlessEditor()` returning cleanup function, semaphore-based concurrency limiter, memory monitoring.

**Addresses:** Memory management, server stability

**Avoids:** Pitfall 1 (JSDOM window leak), Pitfall 2 (event loop blocking)

**Research needs:** JSDOM documentation verification for window.close() API (flagged MEDIUM confidence)

### Phase 5: Apply Endpoint (Complex Path)
**Rationale:** Most complex endpoint. Requires multipart parsing (DOCX + edits), temp file management, domain orchestration, and binary response. All supporting infrastructure must be in place first.

**Delivers:** POST /v1/apply endpoint that accepts DOCX + edits, returns modified DOCX with metadata headers.

**Addresses:** Apply endpoint, temp file lifecycle, binary response, edit validation (table stakes)

**Avoids:** Pitfall 5 (temp file cleanup on errors)

**Research needs:** None (uses existing `applyEdits`)

### Phase 6: Production Hardening
**Rationale:** Operational concerns for reliability. Can be layered after functional completeness.

**Delivers:** Graceful shutdown, request timeout with resource cleanup, decompressed ZIP size validation, process memory watchdog.

**Addresses:** Graceful shutdown (table stakes), timeout handling, zip bomb protection

**Avoids:** Pitfall 3 (zip bombs), Pitfall 6 (timeout mismatches), Pitfall 10 (shutdown in-flight loss)

**Research needs:** None (standard production patterns)

### Phase Ordering Rationale

- **Phase 1-2 before domain integration:** Establish infrastructure correctness before touching complex SuperDoc logic. Enables fast deployment verification and testing infrastructure.
- **Read before Apply:** Read endpoint is simpler (buffer-only, no temp files) and validates domain integration patterns without full complexity. Success here proves multipart upload parsing and service layer design.
- **JSDOM fix before Apply:** The memory leak is fatal and must be solved before the CPU-intensive apply endpoint. Fixing after deployment is risky.
- **Concurrency limiting alongside JSDOM fix:** Both address resource management. Together they prevent memory leaks (Phase 4) and event loop blocking (Phase 4) before Apply goes live (Phase 5).
- **Production hardening last:** Graceful shutdown and advanced validation are important but don't block functionality. Can iterate after MVP is functional.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 4 (JSDOM lifecycle):** Needs verification of JSDOM `window.close()` API behavior with current library version. Research flagged MEDIUM confidence on cleanup pattern. Use Context7 or live docs before implementation.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Foundation):** Fastify setup is well-documented, no custom research needed
- **Phase 2 (Auth/Errors):** Standard middleware patterns, crypto.timingSafeEqual is built-in
- **Phase 3 (Read endpoint):** Uses existing domain module, straightforward integration
- **Phase 5 (Apply endpoint):** Uses existing domain module, temp file pattern is standard
- **Phase 6 (Hardening):** Standard production patterns (graceful shutdown, timeouts)

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM | Fastify 5 choice is HIGH confidence (well-established, ESM support verified). Plugin versions (MEDIUM/LOW) need npm verification before install. PM2 recommendation is MEDIUM. |
| Features | HIGH | Derived directly from codebase analysis and universal REST API patterns. Table stakes features are well-established. Anti-features list is specific to this project's stateless constraint. |
| Architecture | HIGH | Based on direct code inspection of existing domain modules. Service layer pattern matches existing file path expectations. Temp file approach preserves tested CLI code. |
| Pitfalls | HIGH | All critical pitfalls derived from direct codebase analysis (JSDOM creation in editorFactory.mjs, console.warn override in editApplicator.mjs, recompress temp file handling). Not hypothetical. |

**Overall confidence:** MEDIUM-HIGH

The architecture and pitfalls assessments are HIGH confidence (direct code inspection). The stack recommendation is MEDIUM confidence due to inability to verify exact library versions (WebSearch unavailable). The JSDOM window.close() pattern (Pitfall 1 mitigation) needs verification against current JSDOM docs before implementation.

### Gaps to Address

- **JSDOM cleanup API verification:** Research states `window.close()` is required for cleanup but could not verify against current JSDOM documentation (training data only). Verify with Context7/live docs before implementing Phase 4. If the API has changed, the cleanup pattern must be adjusted.

- **Fastify plugin versions:** All @fastify/* package versions are flagged LOW confidence. Run `npm view <package> version` for each before installation to confirm latest versions. Major version recommendations (Fastify 5, not 4) are correct.

- **PM2 ESM compatibility:** Research notes PM2 has historically had issues with ESM. Verify `pm2 start server.mjs` works or use ecosystem.config.cjs wrapper. Test during Phase 6.

- **Worker thread viability:** Research suggests worker threads may not work with JSDOM due to C++ bindings. This is MEDIUM confidence inference. If Phase 2+ requires worker isolation, test JSDOM transferability explicitly.

- **DiffMatchPatch mutable state:** Module-level singleton (wordDiff.mjs line 12) could be an issue if per-request configuration is added. Current code is safe but document the constraint.

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection: `/Users/alin/code/work/superdoc-api/src/*.mjs` (editorFactory.mjs, editApplicator.mjs, irExtractor.mjs, editApplicator.mjs, superdoc-redline.mjs)
- Project planning docs: `.planning/PROJECT.md`, `.planning/codebase/STACK.md`, `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md`
- Existing package.json with dependency versions and ESM configuration

### Secondary (MEDIUM confidence)
- Fastify documentation (training data cutoff ~May 2025) — framework features, plugin ecosystem
- Node.js built-in APIs — crypto.timingSafeEqual, process lifecycle, os.tmpdir()
- DOCX/OOXML file format specification — magic bytes, ZIP structure, required components
- REST API design patterns — error envelopes, status codes, multipart upload, CORS

### Tertiary (LOW confidence, needs verification)
- @fastify/multipart version 9.x, @fastify/swagger version 9.x, pino-pretty version 13.x — flagged for npm verification
- JSDOM window.close() API — training data says it exists and is required for cleanup; verify with current docs
- PM2 ESM support — training data notes historical issues; test with latest PM2
- Worker threads + JSDOM compatibility — inference based on C++ binding concerns; needs testing

---
*Research completed: 2026-02-06*
*Ready for roadmap: yes*
