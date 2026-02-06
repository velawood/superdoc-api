# Feature Landscape

**Domain:** Document processing HTTP API (DOCX editing as a service)
**Researched:** 2026-02-06
**Confidence:** MEDIUM -- based on training knowledge of REST API design patterns, document processing APIs (Aspose, GroupDocs, Cloudmersive, DocSpring, Docuseal), and the specific codebase constraints documented in `.planning/codebase/`. WebSearch/WebFetch unavailable for verification against current competitor APIs.

---

## Table Stakes

Features users expect. Missing = product feels incomplete or unprofessional.

### Request/Response Fundamentals

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Multipart file upload** | Standard pattern for file-processing APIs. Users POST the DOCX as a file part and edits as a JSON part. Without this, users must base64-encode files (painful, +33% size). | Low | Use `multipart/form-data`. Two parts: `file` (DOCX binary) and `edits` (JSON or markdown text). For the read/extract endpoint, just the `file` part. |
| **Binary DOCX response (application/octet-stream)** | The apply endpoint returns a file. Users expect to receive the binary directly, not base64-wrapped-in-JSON. Set `Content-Disposition: attachment; filename="redlined.docx"`. | Low | For apply endpoint only. Read/extract returns JSON. |
| **Structured JSON error responses** | Every API user expects machine-parseable errors. `{ "error": { "code": "VALIDATION_FAILED", "message": "...", "details": [...] } }`. Must be consistent across all error paths. | Low | Define an error envelope early. Use it everywhere. HTTP status codes: 400 for validation, 401 for auth, 413 for too-large, 422 for bad edits, 500 for internal. |
| **Proper HTTP status codes** | 200/201 for success, 400 for bad request, 401 for auth failure, 413 for payload too large, 422 for unprocessable (valid JSON but bad edits), 500 for server error, 503 for overloaded. | Low | Not just 200-or-500. Consumers rely on status codes for retry logic. |
| **Request ID tracing** | Every request gets a unique ID (UUID v4). Returned in response header `X-Request-Id`. Included in all logs. If user provides `X-Request-Id`, echo it back; otherwise generate one. | Low | Critical for debugging production issues. Without it, correlating "my request failed" to server logs is impossible. |
| **API key authentication (Bearer token)** | Already in PROJECT.md requirements. Simple `Authorization: Bearer <key>` header. Reject with 401 if missing/invalid. | Low | Do NOT use query parameter auth (leaks in logs). Header-only. |
| **Health check endpoint** | `GET /health` returning `{ "status": "ok" }` with 200. Load balancers, orchestrators, and uptime monitors all expect this. | Low | Absolutely minimal. Should NOT load a DOCX or touch JSDOM. Just confirms process is alive and can respond. |
| **Content-Type validation** | Reject requests that don't send `Content-Type: multipart/form-data` for upload endpoints. Reject if the uploaded file is not a valid DOCX (check magic bytes or at minimum the `.docx` extension). | Low | Prevents confusing errors deep in processing. Fail fast at the gate. |
| **File size limit enforcement** | Reject files above a configurable max size BEFORE buffering the entire upload. Return 413 with a clear message including the limit. | Low | Default: 50MB is reasonable for DOCX. SuperDoc is memory-intensive (JSDOM virtual DOM per document), so this protects the server from OOM. Configurable via env var. |
| **Request timeout handling** | Set a server-side timeout for document processing. If exceeded, return 504 Gateway Timeout with a message. Kill the in-progress JSDOM/SuperDoc work to free memory. | Med | Large documents with many edits could take 30-60 seconds. Default timeout: 120s. Must actually clean up resources on timeout, not just abandon them. |
| **JSON response for read/extract** | The read endpoint returns structured JSON (the IR). Must set `Content-Type: application/json`. | Low | Already matches the CLI output format. |
| **Graceful shutdown** | Handle SIGTERM/SIGINT. Stop accepting new requests, finish in-flight requests (with timeout), then exit. | Low | Required for containerized deployments. Without it, in-flight requests get killed mid-DOCX-processing. |

### Error Reporting

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Validation error details** | When edits fail validation, return the FULL list of issues (not just the first one). Include blockId, issue type, and human-readable message for each. | Low | CLI already produces this via `validateEdits()`. Serialize the existing validation result as JSON. |
| **Partial failure reporting** | When using `skip-invalid` mode, the response should list which edits succeeded, which were skipped, and why. | Low | CLI already tracks `applied` count and `skipped` array. Return both in the response body alongside the DOCX file (use multipart response or provide a summary header). |
| **Error codes (not just messages)** | Machine-readable codes like `BLOCK_NOT_FOUND`, `TRUNCATION_DETECTED`, `INVALID_OPERATION`. Messages change; codes don't. | Low | Define an enum of error codes. Map existing validation issue types to codes. |

---

## Differentiators

Features that set the product apart. Not expected, but valued by power users and enterprise consumers.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Validation-only mode (dry run)** | `POST /apply?dry_run=true` -- validates edits against the document and returns validation results WITHOUT producing the output DOCX. Saves upload bandwidth and processing time when users just want to check edits. | Low | Already exists as `validateEdits()` in the CLI. Expose as a query param or separate endpoint. Very cheap to offer, high value for iterative workflows. |
| **Edit summary in response headers/body** | Return metadata about what happened: `X-Edits-Applied: 5`, `X-Edits-Skipped: 1`, `X-Warnings: 2`. For apply responses that return binary DOCX, headers are the only way to communicate metadata. | Low | Alternatively, support `Accept: multipart/mixed` where the response contains both the DOCX file and a JSON summary part. Default to just DOCX + headers for simplicity. |
| **Configurable strictness via query params** | Expose `strict`, `skip_invalid`, `quiet_warnings` as query parameters on the apply endpoint. Maps directly to existing CLI flags. Lets users control behavior per-request. | Low | Direct mapping to existing capabilities. No new logic needed. |
| **Markdown edit format support** | Accept edits in markdown format (not just JSON). The CLI already supports this via `parse-edits`. For LLM-generated edits, markdown is more reliable. | Low | Already implemented in the CLI. Just need to detect format (`.md` extension or Content-Type hint) and route through the markdown parser. |
| **Compressed responses (gzip/brotli)** | DOCX files are already ZIP-compressed, so gzip on the binary response helps less. But JSON responses from the read endpoint benefit enormously from compression (IR JSON can be 500KB+, compresses to ~50KB). | Low | Most HTTP frameworks support this via middleware. Use `Accept-Encoding` negotiation. Apply to JSON responses. Skip for DOCX binary (already compressed). |
| **Author attribution passthrough** | Accept `author_name` and `author_email` in the request to set track change attribution. Maps to `--author-name` and `--author-email` CLI flags. | Low | Already supported in the CLI. Pass through as fields in the JSON edits part or as query params. |
| **CORS headers for browser clients** | If the API will be called from browser-based apps, CORS headers are required. `Access-Control-Allow-Origin`, `Access-Control-Allow-Headers`, `Access-Control-Allow-Methods`. | Low | Only needed if browser clients are a target. For server-to-server only, skip. Recommend: include it (costs nothing, enables future use). |
| **Idempotency keys** | Accept `Idempotency-Key` header. If a request with the same key was already processed, return the cached result. Prevents duplicate processing on retries. | High | Requires a cache/store (Redis or in-memory with TTL). Valuable for production reliability but adds infrastructure. Defer unless demand emerges. |
| **Retry guidance (Retry-After header)** | When returning 429 (rate limited) or 503 (overloaded), include `Retry-After: <seconds>` header. Tells clients exactly when to retry instead of guessing. | Low | Even without rate limiting in the app (handled at gateway), if the server detects memory pressure or queue depth, it can return 503 + Retry-After proactively. |
| **API versioning in URL** | `/v1/apply`, `/v1/read`. Enables non-breaking evolution. When v2 changes the edit format or response shape, v1 keeps working. | Low | Use URL prefix versioning (`/v1/`). Simplest approach, universally understood. Do this from day one -- retrofitting versioning is painful. |
| **Readiness endpoint** | `GET /ready` -- returns 200 only when the server is fully initialized and can process requests. Different from `/health` (which checks if the process is alive). Useful for Kubernetes readiness probes. | Low | Check that required dependencies are loadable (JSDOM, SuperDoc). If initialization is async, `/ready` waits for it. |
| **Request body size in logs/metrics** | Log the size of uploaded DOCX files and the number of edits per request. Enables capacity planning and abuse detection. | Low | Middleware concern. Log `Content-Length`, edit count, and processing duration for every request. |
| **OpenAPI/Swagger spec** | Machine-readable API definition. Enables code generation for client SDKs, Postman import, and documentation hosting. | Med | Write it by hand or generate from route definitions. High value for developer adoption. Can be deferred to post-MVP but should come soon after. |

---

## Anti-Features

Features to explicitly NOT build. Common mistakes in the document processing API domain.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Server-side file storage** | PROJECT.md explicitly says stateless. Storing uploaded DOCX files creates security liability (PII in legal documents), requires cleanup jobs, adds state management, and violates the simple request/response model. | Process in memory, return result, discard. Every request is self-contained. If users need to store documents, they store them on their own infrastructure. |
| **Async job queue with polling** | Tempting for large files, but adds massive complexity: job store, polling endpoints, job expiry, result retrieval, webhook callbacks. The apply operation takes seconds even for large documents. The timeout mechanism handles the edge case. | Synchronous request/response with a generous timeout (120s). If a document is too large to process in that window, the answer is "split it" or "increase the limit," not "build a job system." |
| **Webhook callbacks** | Only makes sense with async processing. Since processing is synchronous, there is nothing to call back about. Adding webhooks means adding: callback URL validation, retry logic, HMAC signing, delivery tracking. | Not needed. Synchronous response includes all results. |
| **Batch operations (multiple documents per request)** | Processing one DOCX already loads JSDOM + SuperDoc (memory-intensive). Processing N documents in one request multiplies memory pressure unpredictably. Also complicates error handling (partial batch failure). | One document per request. If users need to process 100 documents, they send 100 requests. They can parallelize on their end. The API is stateless and horizontally scalable. |
| **Server-side document conversion (DOCX to PDF, DOCX to HTML)** | Out of scope. The core value is DOCX editing with track changes, not format conversion. Conversion requires additional heavy dependencies (LibreOffice, Pandoc, etc.) and is a separate product. | Return DOCX. Users convert on their end if needed. |
| **OAuth2 / complex auth flows** | PROJECT.md explicitly chose API key auth. OAuth adds token refresh, scopes, authorization servers, consent flows. Overkill for a programmatic API consumed by servers and AI agents. | Simple Bearer token. If multi-tenant access control is needed later, add API key scopes, not OAuth. |
| **WebSocket / streaming responses** | DOCX files must be fully assembled before they can be sent (they are ZIP archives). There is nothing to stream. The IR JSON could theoretically be streamed, but it is small enough to send in one response. | Standard HTTP request/response. |
| **Rate limiting in the application** | PROJECT.md says this is handled at infrastructure level (reverse proxy / API gateway). Implementing rate limiting in the app duplicates what Nginx/Cloudflare/API Gateway already does better. | Rely on infrastructure-level rate limiting. The app should return 503 with Retry-After if it detects internal overload (queue depth, memory pressure), but not implement token buckets or sliding windows. |
| **User management / signup** | PROJECT.md explicitly out of scope. API keys are managed outside the service. | Validate the key, nothing more. No user CRUD, no password reset, no email verification. |
| **GraphQL** | Two endpoints (apply, read). GraphQL adds complexity (schema definition, resolvers, query parsing) with zero benefit for this simple API surface. GraphQL shines for data-heavy APIs with many entities and relationships. This is a file-processing API. | REST with two POST endpoints. |
| **Multipart response for apply + summary** | While technically possible (`multipart/mixed`), most HTTP clients handle it poorly. Parsing multipart responses is not straightforward in Python, JavaScript, or curl. | Return the DOCX binary as the response body. Put metadata in response headers (`X-Edits-Applied`, `X-Edits-Skipped`, `X-Warnings`). If full details are needed, use the dry-run endpoint first. |
| **Automatic retries inside the server** | If SuperDoc fails to process a document, do NOT retry internally. The same input will produce the same failure. Retrying wastes resources and delays the error response. | Fail immediately, return detailed error. Let the client decide whether to retry with modified input. |

---

## Feature Dependencies

```
File Size Limit ─────────────────┐
Content-Type Validation ─────────┤
API Key Auth ────────────────────┤
                                 ▼
                        ┌────────────────┐
                        │ Request Intake  │ (must exist before any endpoint works)
                        └───────┬────────┘
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
             ┌──────────┐ ┌──────────┐ ┌──────────┐
             │ /v1/apply│ │/v1/read  │ │/health   │
             └────┬─────┘ └────┬─────┘ └──────────┘
                  │            │
                  ▼            ▼
           ┌───────────┐ ┌──────────┐
           │ Validation │ │ IR JSON  │
           │ + Apply    │ │ Response │
           └────┬──────┘ └──────────┘
                │
                ▼
         ┌─────────────┐
         │ DOCX Binary  │
         │ Response +   │
         │ Headers      │
         └─────────────┘

Request ID Tracing ──── applies to ALL endpoints (middleware)
Error Envelope ──────── applies to ALL error paths (middleware)
Graceful Shutdown ───── applies to the server process (lifecycle)
Timeout Handling ────── applies to processing endpoints (middleware)
CORS ────────────────── applies to ALL endpoints (middleware)
Compression ─────────── applies to JSON responses (middleware)
```

### Explicit Dependency Chain

1. **Health endpoint** has NO dependencies on document processing. Build first as server proof-of-life.
2. **Request intake** (multipart upload, auth, content validation, size limits) must work before either processing endpoint.
3. **Error envelope** must be defined before any endpoint, so all errors are consistent from day one.
4. **Request ID tracing** should be the very first middleware (generates ID before anything else runs).
5. **/v1/read** is simpler than /v1/apply (no edits input, no DOCX output, just JSON). Build second.
6. **/v1/apply** is the most complex endpoint. Build last among the core three.
7. **Dry-run mode** requires the apply endpoint to exist first. Layer on top.
8. **API versioning** (`/v1/` prefix) is a URL convention -- decide and implement with the first endpoint, not after.
9. **OpenAPI spec** should be written alongside or immediately after endpoint implementation.

---

## MVP Recommendation

For MVP, prioritize these in order:

### Must Ship (Table Stakes)

1. **Request ID tracing middleware** -- first middleware added, used everywhere
2. **Structured error envelope** -- consistent errors from the start
3. **API key authentication** -- gate all endpoints
4. **Health endpoint** (`GET /health`)
5. **Multipart file upload handling** -- required for both processing endpoints
6. **File size limit enforcement** (413 responses)
7. **Content-Type validation**
8. **`POST /v1/read`** -- extract/read endpoint (simpler, no DOCX output)
9. **`POST /v1/apply`** -- apply endpoint (DOCX input + edits -> DOCX output)
10. **Proper HTTP status codes** across all error paths
11. **Request timeout handling** with resource cleanup
12. **Graceful shutdown** (SIGTERM handling)

### Should Ship (High-Value Differentiators with Low Effort)

13. **Validation-only dry-run mode** (`?dry_run=true`)
14. **API versioning** (`/v1/` prefix) -- establish from day one
15. **Edit summary response headers** (`X-Edits-Applied`, etc.)
16. **Configurable strictness via query params** (`strict`, `skip_invalid`)
17. **Markdown edit format support** (already implemented in CLI)
18. **Author attribution passthrough**
19. **Compressed JSON responses** (gzip middleware)
20. **Readiness endpoint** (`GET /ready`)
21. **CORS headers**

### Defer to Post-MVP

- **Idempotency keys**: Requires cache infrastructure. Wait for demand.
- **OpenAPI spec**: High value but not blocking. Write after endpoints stabilize.
- **Retry-After headers**: Nice to have. Add when load patterns are understood.
- **Client SDKs**: Generate from OpenAPI spec once it exists.

---

## Sources and Confidence Notes

- **Codebase analysis**: HIGH confidence. Read PROJECT.md, CONCERNS.md, ARCHITECTURE.md, STACK.md, README.md, SKILL.md directly from the repository. All feature recommendations account for actual codebase capabilities and constraints.
- **REST API patterns**: MEDIUM confidence. Based on training knowledge of REST API design best practices, HTTP specification (RFC 7231, 7235, 6585, 8288), and common patterns in document processing APIs (Aspose Words Cloud, GroupDocs Cloud, Cloudmersive, DocSpring). WebSearch was unavailable to verify current competitor features.
- **Specific recommendations** (multipart upload, error envelope, request tracing, health checks): HIGH confidence. These are universal patterns in production HTTP APIs, not domain-specific. They appear in virtually every API design guide (Stripe, Twilio, GitHub API docs as canonical examples).
- **Anti-features list**: HIGH confidence for this specific project. Derived directly from PROJECT.md "Out of Scope" section and the stateless architecture constraint. The anti-features are not universally bad -- they are bad *for this project* given its stated constraints.
- **Memory/performance constraints** (file size limits, timeout handling, no batch processing): HIGH confidence. Derived from CONCERNS.md documentation of JSDOM memory intensity, SuperDoc per-document editor lifecycle, and the known 6x output size issue.

---

*Feature landscape research: 2026-02-06*
