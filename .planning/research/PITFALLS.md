# Domain Pitfalls

**Domain:** Document processing HTTP API (DOCX editing via SuperDoc + JSDOM)
**Researched:** 2026-02-06
**Confidence:** HIGH (derived from codebase analysis of actual patterns, not hypothetical)

---

## Critical Pitfalls

Mistakes that cause production incidents, data loss, or require architectural rewrites.

---

### Pitfall 1: JSDOM Window Leak -- The Silent Memory Killer

**What goes wrong:** Every request creates a `new JSDOM(...)` instance in `editorFactory.mjs` (line 33). The `window` object is extracted but never explicitly closed with `window.close()`. The code calls `editor.destroy()` but that only destroys the SuperDoc editor -- not the underlying JSDOM virtual DOM. In a CLI context this does not matter because the process exits. In a long-running server, each request leaks an entire browser window object with its full DOM tree, timers, and event listeners.

**Why it happens:** The existing CLI pattern works because `process.exit()` cleans up everything. When porting to a server, developers assume `editor.destroy()` handles all cleanup because it is the only teardown call visible in the code. The JSDOM `window` object is created in `createHeadlessEditor` but the reference is not returned to callers -- it is trapped in closure scope and never accessible for cleanup.

**Consequences:**
- Memory grows linearly with requests. A 10MB DOCX creates ~50-100MB of JSDOM state. At 100 requests, the server is consuming 5-10GB.
- Node.js garbage collector cannot reclaim the JSDOM window because the editor may still hold references into the DOM tree.
- Server becomes unresponsive before crashing. Requests start timing out, and the OOM kill is not graceful.
- Under load testing, this will appear stable for 20-50 requests then suddenly degrade.

**Prevention:**
1. Refactor `createHeadlessEditor` to return both the editor and a `cleanup` function that calls `window.close()` after `editor.destroy()`.
2. Wrap every request handler in a try/finally that guarantees cleanup runs even on error.
3. Add a process-level memory watchdog that logs RSS after each request (flag requests that grow memory by >100MB).
4. Pattern should be:
   ```javascript
   const { editor, cleanup } = await createHeadlessEditor(buffer);
   try {
     // process document
   } finally {
     cleanup(); // editor.destroy() + window.close()
   }
   ```

**Detection:**
- `process.memoryUsage().rss` growing monotonically across requests.
- `process.memoryUsage().heapUsed` sawtooth pattern where each "low" is higher than the previous.
- Node.js `--max-old-space-size` OOM crashes after N requests (N is inversely proportional to document size).

**Phase:** Must be addressed in Phase 1 (HTTP layer foundation). This is the single most important architectural change when converting from CLI to server.

---

### Pitfall 2: Event Loop Blocking During Document Processing

**What goes wrong:** The entire document processing pipeline is CPU-bound and synchronous within its async shell. `editor.state.doc.descendants()` traversals, `computeWordDiff()` via diff-match-patch, `buildPositionMap()` character-by-character walking, and `dmp.diff_cleanupSemantic()` all run on the main thread. A single large document (100+ pages, 1000+ blocks) can block the event loop for 2-10 seconds.

**Why it happens:** In CLI mode, blocking the event loop is irrelevant -- there is only one operation. In a server, blocking for 5 seconds means all other requests (including health checks) are unresponsive for 5 seconds. If multiple large documents arrive simultaneously, the server appears down.

**Consequences:**
- Health check endpoints return timeout, load balancers remove the instance from rotation.
- Other in-flight requests time out waiting for the event loop to unblock.
- API gateway may retry, creating duplicate processing load.
- Cascading failure: one large document takes down the entire server for all users.

**Prevention:**
1. Accept that document processing is inherently CPU-bound. Do not try to make it async -- that adds complexity without solving the problem.
2. Use a request queue with concurrency limit of 1 (or N for N workers). Process one document at a time per worker.
3. For the initial phase, a simple mutex or semaphore (e.g., `p-limit` with concurrency=1) prevents concurrent processing.
4. For production scale, use `worker_threads` to offload document processing to a separate thread, keeping the main event loop responsive for health checks and request acceptance.
5. Set appropriate request timeouts: accept the request quickly (within 100ms), process in the background, return result when done. Or, use a synchronous model with documented timeout expectations.

**Detection:**
- Health check latency spikes correlating with document processing requests.
- `event-loop-lag` monitoring showing spikes >500ms.
- Requests timing out at the load balancer while the server is still processing.

**Phase:** Concurrency limiting should be Phase 1. Worker threads can be Phase 2 or later optimization.

---

### Pitfall 3: DOCX Zip Bomb and Malicious File Upload

**What goes wrong:** DOCX files are ZIP archives. A malicious user can upload a ZIP bomb (small compressed file that expands to gigabytes), a crafted DOCX with recursive XML entity expansion (billion laughs attack via XML), or a DOCX with path traversal entries (e.g., `../../etc/passwd` as a file entry within the ZIP).

**Why it happens:** The existing CLI tool trusts its input because the operator is the user. An HTTP API accepts files from untrusted sources. `Editor.loadXmlData(buffer, true)` parses the ZIP and XML without documented size limits. The `unzipper` library used in recompress also processes ZIP entries without path validation.

**Consequences:**
- Zip bomb: Server allocates gigabytes of memory, OOM crash.
- XML entity expansion: SuperDoc's XML parser may expand entities, consuming CPU and memory.
- Path traversal in ZIP: If any temp file extraction is added later, files could be written outside the intended directory.
- Denial of service is trivial -- a single malicious upload crashes the server.

**Prevention:**
1. **File size limit at the HTTP layer**: Reject uploads over a reasonable maximum (e.g., 50MB compressed) before any processing begins. Use the framework's built-in body size limit.
2. **Decompressed size check**: Before passing to SuperDoc, validate the DOCX by checking ZIP entry sizes. Sum all uncompressed sizes from the ZIP central directory (without extracting). Reject if total exceeds a threshold (e.g., 500MB decompressed).
3. **Processing timeout**: Wrap `createHeadlessEditor` and all processing in a per-request timeout (e.g., 60 seconds). If processing exceeds the timeout, kill the operation and return 408/503.
4. **Content-Type validation**: Check both the Content-Type header and the actual file magic bytes. DOCX files start with the ZIP magic bytes `PK\x03\x04` and must contain `[Content_Types].xml` inside.
5. **No temp file extraction to disk** (for now): Process everything in memory buffers. This eliminates path traversal risks entirely. The current pattern of passing buffers to SuperDoc is correct -- do not add disk extraction.

**Detection:**
- Memory spike monitoring on upload endpoints.
- Request duration monitoring -- zip bombs cause sudden processing time spikes.
- Ratio check: if compressed size is <100KB but processing takes >30 seconds, likely malicious.

**Phase:** File size limits in Phase 1 (trivial, just configure the framework). Decompressed size validation in Phase 1 or early Phase 2. Content-Type validation in Phase 1.

---

### Pitfall 4: Error Responses Leaking Internal Details

**What goes wrong:** The existing code throws errors with messages like `error.message` and logs full stack traces. Errors from SuperDoc, ProseMirror, JSDOM, and diff-match-patch contain internal details: file paths, node structure, position numbers, library versions. If these propagate to HTTP responses, they reveal server internals to attackers.

**Why it happens:** CLI tools are supposed to be verbose -- the user is the operator. When wrapping CLI code in HTTP handlers, developers often do `res.json({ error: error.message })` which directly exposes internal error messages. The codebase has patterns like `console.error('Error:', error.message)` and `return { success: false, error: error.message }` that will propagate verbatim if not intercepted.

**Consequences:**
- Path disclosure: Error messages may contain absolute file paths from the server.
- Library fingerprinting: Attackers learn exact library versions from error messages.
- Schema disclosure: ProseMirror errors reveal document structure ("Invalid content for node paragraph...").
- Enumeration: Detailed validation errors (e.g., "Block b042 not found") reveal document structure to unauthorized users.

**Prevention:**
1. Create an error mapping layer that translates internal errors to safe external messages:
   - `Block not found` -> `"Invalid edit: referenced block does not exist in the document"`
   - ProseMirror schema errors -> `"Document processing error. The edit could not be applied."`
   - File I/O errors -> `"Internal server error"`
2. Log the full error (with stack trace) server-side. Return only the sanitized message to the client.
3. Use structured error codes (e.g., `BLOCK_NOT_FOUND`, `INVALID_OPERATION`, `PROCESSING_FAILED`) alongside human messages so clients can programmatically handle errors without parsing messages.
4. Never include `stack` property in HTTP responses, even in development mode.

**Detection:**
- Search response bodies for patterns: absolute paths (`/Users/`, `/home/`, `/var/`), library names (`ProseMirror`, `JSDOM`), Node.js internals (`at Module._compile`).
- Automated test: send invalid input, verify response contains only safe error messages.

**Phase:** Phase 1, as part of the HTTP response layer design.

---

### Pitfall 5: Temp File and Buffer Cleanup on Error Paths

**What goes wrong:** The recompress step (lines 567-643 in `superdoc-redline.mjs`) creates temp directories and temp files. If processing fails mid-way (e.g., the archive step throws), the temp directory is never cleaned up. In a server context, every failed request leaves orphaned temp files on disk. The same pattern applies to any buffer-heavy processing: if `editor.exportDocx()` throws after allocating a large buffer, that buffer may not be freed if references are held in the error path.

**Why it happens:** The CLI recompress command uses `try/catch` but the cleanup (`await rm(tempDir, ...)`) is only in the success path (line 634), not in a `finally` block. In a server, failed requests accumulate. Additionally, Node.js buffers from `readFile` and `exportDocx` can be large (multi-MB) and if error handlers hold references to them (e.g., in error logging that captures the request context), they will not be garbage collected.

**Consequences:**
- Disk fills up with orphaned temp directories over time.
- Memory is held by buffers referenced in error contexts.
- Eventually: ENOSPC (disk full) or OOM crashes.
- Insidious because it only manifests under error conditions, which are rare in testing but common in production.

**Prevention:**
1. Always use `try/finally` for resource cleanup, never rely on success-path-only cleanup.
2. For the API layer: avoid temp files entirely for the initial implementation. Process DOCX in memory (buffers) and stream the result back. The current `applyEdits` already works with buffers -- the recompress step is the only one that touches disk.
3. If recompress must use disk: use a managed temp directory with automatic cleanup on process exit (e.g., `tmp-promise` or `os.tmpdir()` with a cleanup interval).
4. Nullify large buffer references in finally blocks: `buffer = null; exportedBuffer = null;` to allow immediate GC.
5. Add a periodic cleanup job that sweeps stale temp directories older than 10 minutes.

**Detection:**
- Monitor `/tmp` or `os.tmpdir()` for directories matching the `docx-recompress-*` pattern.
- Monitor disk usage trends.
- Track request error rates -- high error rates correlate with temp file accumulation.

**Phase:** Phase 1 for the in-memory pattern (avoid temp files). Phase 2 if recompress needs to be ported to the API.

---

### Pitfall 6: Request Timeout vs Processing Time Mismatch

**What goes wrong:** Document processing takes variable time depending on document size and edit complexity. A 5-page document might take 500ms. A 200-page contract with 50 edits and word-level diff might take 30-60 seconds. Default HTTP timeouts (often 30 seconds at the load balancer, 120 seconds at Node.js) are either too short (causing premature termination mid-processing) or too long (causing resource holding for slow clients).

**Why it happens:** The processing pipeline has multiple variable-time steps: DOCX loading, IR extraction, edit validation, word diff computation, document export, and recompression. Each step's duration is proportional to document size. Developers set a single timeout that works for test documents (small) but fails for production documents (large).

**Consequences:**
- Client receives a timeout error but the server continues processing, wasting resources.
- Worse: the server finishes processing but the client has already disconnected, and the result is discarded.
- Load balancer retries cause duplicate processing.
- Inconsistent behavior: same endpoint works for small documents, fails for large ones.

**Prevention:**
1. Set conservative but explicit timeouts at each layer:
   - HTTP server: `server.requestTimeout = 120000` (2 minutes).
   - Load balancer/reverse proxy: Match or exceed the server timeout.
   - Per-request processing: Use `AbortSignal.timeout(90000)` to kill processing 30 seconds before the HTTP timeout.
2. Document expected processing times per document size in API documentation.
3. Return early headers (e.g., `Transfer-Encoding: chunked`) to keep connections alive during long processing. Or, accept the job and return a 202 with a poll URL for truly long operations (this is a Phase 2+ concern).
4. Add request size heuristics: estimate processing time from file size and edit count, reject with 413 if estimated time exceeds the timeout.

**Detection:**
- Monitor request duration distribution. If p99 is >30 seconds, timeout mismatches are likely.
- Track "client disconnected" events during processing.
- Compare gateway timeout rates with successful completion rates.

**Phase:** Basic timeout configuration in Phase 1. Size-based estimation and 202 async pattern in Phase 2+.

---

## Moderate Pitfalls

Mistakes that cause degraded performance, poor developer experience, or technical debt.

---

### Pitfall 7: process.exit() Calls in Imported Modules

**What goes wrong:** The existing CLI uses `process.exit(1)` in 19 places (all in `superdoc-redline.mjs`). If any of these patterns leak into the server code -- or if library code called by the domain modules calls `process.exit()` -- the entire server terminates on a single request error.

**Prevention:**
1. The domain modules (`src/*.mjs`) do not call `process.exit()` -- only the CLI layer does. This separation already exists and is correct.
2. When building the HTTP layer, never import or call anything from `superdoc-redline.mjs`. Import only from `src/` modules.
3. Add a test that greps for `process.exit` in `src/` to prevent accidental introduction.
4. Consider adding `process.on('exit')` listener in the server that logs a warning if exit is called unexpectedly.

**Phase:** Phase 1 awareness. The existing separation is good -- just do not break it.

---

### Pitfall 8: console.warn Override in editApplicator

**What goes wrong:** `editApplicator.mjs` (lines 406-414) overrides `console.warn` globally to suppress a ProseMirror warning during document export. In a server context, if two requests are processing concurrently, one request's warn suppression affects the other request's logging. This is a shared mutable state race condition.

**Prevention:**
1. Remove the global `console.warn` override when porting to the server context.
2. If the ProseMirror warning must be suppressed, do it at the ProseMirror configuration level (if possible) or accept the warning in server logs and filter it in the logging pipeline.
3. If the override must remain, use `AsyncLocalStorage` to scope the suppression to the current request context.

**Phase:** Phase 1, as part of wrapping the edit applicator for HTTP use.

---

### Pitfall 9: Multipart Upload Parsing Edge Cases

**What goes wrong:** DOCX file uploads come as multipart/form-data. Common edge cases include:
- File field name mismatch (client sends `document`, server expects `file`).
- Missing Content-Type header on the file part.
- Chunked transfer encoding with multipart boundaries that split across chunks.
- Empty file uploads (0-byte body with valid multipart headers).
- Multiple files in a single request when only one is expected.
- Filename with path separators or special characters.

**Prevention:**
1. Use a well-tested multipart parser (e.g., `multer`, `busboy`, or the framework's built-in parser). Do not implement custom parsing.
2. Validate after parsing: check that exactly one file was uploaded, that it has non-zero size, and that the field name matches expectations.
3. Ignore the client-provided filename for security. Generate a UUID-based name if any temp file is needed.
4. Set explicit limits in the parser configuration: max file size, max number of files (1), max field size for JSON body parts.
5. Test with: empty file, file >max size, wrong field name, multiple files, missing Content-Type, filename with `../`.

**Phase:** Phase 1, as part of endpoint implementation.

---

### Pitfall 10: Graceful Shutdown Losing In-Flight Requests

**What goes wrong:** When the server receives SIGTERM (deployment, scaling, restart), in-flight document processing is interrupted. The client receives a connection reset. If the server was mid-export, partial DOCX data may have been sent (corrupted response).

**Prevention:**
1. Implement graceful shutdown: on SIGTERM, stop accepting new requests, wait for in-flight requests to complete (with a timeout), then exit.
2. Track active request count. On shutdown signal, set a flag that rejects new requests with 503, then wait up to 60 seconds for active requests to finish.
3. If active requests do not finish within the grace period, force-exit. Log which requests were abandoned.
4. Pattern:
   ```javascript
   process.on('SIGTERM', () => {
     server.close(() => process.exit(0));
     setTimeout(() => process.exit(1), 60000); // force after 60s
   });
   ```

**Phase:** Phase 1 or Phase 2. Important for production but not for initial development/testing.

---

### Pitfall 11: Large Response Size Without Limits

**What goes wrong:** The extract/read endpoint returns the full document IR as JSON. For a 200-page contract, this can be 5-10MB of JSON. The apply endpoint returns a DOCX file that, before recompression, is 6x the original size (per the known bug in CONCERNS.md). Without response size awareness, large responses consume server memory, client memory, and network bandwidth unexpectedly.

**Prevention:**
1. For JSON responses (extract/read): set a configurable maximum response size. If the IR exceeds it, return chunked results with pagination metadata (the chunking system already exists in `documentReader.mjs`).
2. For binary responses (apply): stream the DOCX buffer directly to the response rather than serializing to JSON. Use `Content-Length` header so clients know what to expect.
3. Add `Content-Length` headers to all responses so clients can pre-allocate and detect truncation.
4. Consider gzip/brotli compression for JSON responses (the IR is highly compressible text).

**Phase:** Basic streaming and Content-Length in Phase 1. Compression in Phase 2.

---

### Pitfall 12: API Key Timing Attacks

**What goes wrong:** If API key comparison uses JavaScript's `===` operator, the comparison short-circuits on the first mismatched character. An attacker can measure response times to determine the correct key character by character.

**Prevention:**
1. Use `crypto.timingSafeEqual()` for all API key comparisons. This is a single-line change but easy to forget.
2. Convert both the provided key and the stored key to equal-length buffers before comparison.
3. Pattern:
   ```javascript
   const valid = crypto.timingSafeEqual(
     Buffer.from(providedKey),
     Buffer.from(storedKey)
   );
   ```
4. Also: return the same error response (same status code, same body, same headers) for "missing key" and "wrong key" to prevent enumeration.

**Phase:** Phase 1, when implementing the auth middleware.

---

### Pitfall 13: File Type Validation Beyond Extension Checking

**What goes wrong:** Checking only the filename extension (`.docx`) is insufficient. A malicious user can upload a PNG renamed to `.docx`, a ZIP file that is not a valid DOCX, or an OOXML spreadsheet (`.xlsx`) renamed to `.docx`. Each of these will fail at different points in processing with unhelpful errors or unexpected behavior.

**Prevention:**
1. Check magic bytes: DOCX files are ZIP files starting with `PK\x03\x04` (bytes `50 4B 03 04`).
2. After magic byte check, verify ZIP contains `[Content_Types].xml` (required OOXML component) and `word/document.xml` (required Word component). This distinguishes DOCX from XLSX, PPTX, and other OOXML formats.
3. Do this validation before passing to SuperDoc to get a clear early error instead of a cryptic SuperDoc/JSDOM failure.
4. Return a specific error: `"Invalid file: expected a DOCX document"` rather than propagating the internal parse failure.

**Phase:** Phase 1, as a pre-processing validation step.

---

### Pitfall 14: Missing CORS Headers

**What goes wrong:** If the API is ever called from a browser context (developer testing, internal tooling, web-based clients), missing CORS headers cause all requests to fail with opaque browser errors. This is especially confusing because the same requests work fine from curl or Postman.

**Prevention:**
1. Add CORS middleware from the start, even if initial clients are server-to-server.
2. Configure conservatively: specific allowed origins, not `*`. Allow `Content-Type` and `Authorization` headers.
3. Handle preflight (OPTIONS) requests explicitly.
4. Do not assume "API keys mean no browser clients" -- developers will test from browsers.

**Phase:** Phase 1, as part of middleware setup. Trivial to add, painful to debug when missing.

---

## Minor Pitfalls

Mistakes that cause developer annoyance or minor issues but are easily fixable.

---

### Pitfall 15: DiffMatchPatch Module-Level Singleton

**What goes wrong:** `wordDiff.mjs` creates a single `dmp` instance at module load time (line 12: `const dmp = new DiffMatchPatch()`). DMP has mutable state (`Diff_Timeout`, `Diff_EditCost`). In a server context, if any request modifies these settings, it affects all subsequent requests.

**Prevention:**
1. Create a new DMP instance per operation, or ensure the module-level instance settings are never modified.
2. The current code does not modify DMP settings, so this is not an active bug -- but it is a latent risk if anyone adds configuration options later.
3. Document that the DMP instance must not be configured per-request.

**Phase:** Awareness only. No immediate action needed unless per-request DMP configuration is added.

---

### Pitfall 16: JSON Body Size for Edit Payloads

**What goes wrong:** The edits JSON payload can be large if it contains many edits with full `newText` content. A 100-edit payload where each `newText` is a full paragraph could be 500KB-1MB of JSON. Default body parser limits (often 100KB) will silently truncate or reject the request.

**Prevention:**
1. Set explicit JSON body parser limits appropriate for the use case (e.g., 5MB for the edit payload).
2. Document maximum payload sizes in API documentation.
3. Validate that the parsed JSON is structurally complete (not truncated) before processing.

**Phase:** Phase 1 configuration.

---

### Pitfall 17: Inconsistent Error Status Codes

**What goes wrong:** Without a deliberate mapping, errors get inconsistent HTTP status codes. Validation failures (invalid block ID) return 500 instead of 400. Auth failures return 403 instead of 401. Processing timeouts return 500 instead of 504 or 408.

**Prevention:**
1. Define the status code mapping upfront:
   - 400: Malformed request, invalid JSON, missing required fields, invalid edit format.
   - 401: Missing or invalid API key.
   - 404: Endpoint not found (not for "block not found" -- that is a 400/422).
   - 408: Processing timeout.
   - 413: File too large.
   - 415: Unsupported file type (not a valid DOCX).
   - 422: Valid request format but semantically invalid (e.g., block ID not found in document, invalid operation type).
   - 500: Unexpected internal error.
   - 503: Server busy / shutting down.
2. Implement this mapping as middleware, not scattered across handlers.

**Phase:** Phase 1, as part of error handling design.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|---|---|---|
| HTTP framework setup | Missing body size limits, CORS, timeout config | Configure all limits explicitly in Phase 1 |
| File upload endpoint | Zip bombs, invalid file types, multipart edge cases | Validate magic bytes + ZIP structure before SuperDoc |
| Editor lifecycle in server | JSDOM window leak (Pitfall 1) | Return cleanup function from factory, always try/finally |
| Auth middleware | Timing attack on key comparison | Use crypto.timingSafeEqual from day one |
| Error handling | Leaking internal details | Build error sanitization layer in Phase 1 |
| Apply endpoint | Event loop blocking (Pitfall 2) | Concurrency limiter (p-limit) in Phase 1 |
| Recompress integration | Temp file cleanup on errors | Use in-memory processing, avoid temp files |
| Health check | Blocked by document processing | Keep health check on separate fast path, monitor event loop lag |
| Graceful shutdown | In-flight requests lost | Track active requests, drain on SIGTERM |
| Load testing | Memory leak only visible under sustained load | Monitor RSS per request, test with 100+ sequential requests |

---

## Sources

- Direct codebase analysis of `/Users/alin/code/work/superdoc-api/src/*.mjs` (HIGH confidence -- actual code patterns observed)
- `/Users/alin/code/work/superdoc-api/.planning/codebase/CONCERNS.md` -- existing concerns analysis documenting known bugs and security issues
- `/Users/alin/code/work/superdoc-api/.planning/codebase/ARCHITECTURE.md` -- architecture analysis documenting data flow and lifecycle
- JSDOM documentation (MEDIUM confidence -- based on training knowledge that `window.close()` is required for cleanup; should be verified against current JSDOM docs when web access is available)
- Node.js `crypto.timingSafeEqual` is a well-established API (HIGH confidence)
- DOCX/OOXML file format structure (HIGH confidence -- well-documented standard)
- diff-match-patch mutable state concern (MEDIUM confidence -- based on training knowledge of DMP API)

**Note on WebSearch:** WebSearch and WebFetch were unavailable during this research session. Pitfalls are derived from direct codebase analysis and established domain knowledge. The JSDOM cleanup pattern (Pitfall 1) and DMP singleton concern (Pitfall 15) should be verified against current library documentation when web access is available. All other pitfalls are directly observable from the code.
