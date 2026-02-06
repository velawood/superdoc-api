# Architecture Patterns: File-Processing HTTP API Wrapping a CLI Tool

**Domain:** Document editing HTTP API (wrapping superdoc-redline CLI)
**Researched:** 2026-02-06
**Overall confidence:** HIGH for patterns, MEDIUM for specific library version details

> **Source note:** WebSearch and WebFetch were unavailable during this research session. Architecture patterns are based on analysis of the existing codebase (HIGH confidence -- direct code inspection) and established Node.js HTTP API patterns (MEDIUM-HIGH confidence -- well-established patterns unlikely to have changed, but specific version details unverified).

---

## Recommended Architecture

### Overview: Thin HTTP Shell over Domain Logic

The architecture is a **layered adapter pattern**: a thin HTTP layer that translates HTTP requests into calls to existing domain modules, then translates domain results back into HTTP responses. The existing domain modules (`irExtractor`, `editApplicator`, `documentReader`, `editorFactory`) remain untouched. The HTTP layer is entirely additive.

```
                           HTTP Boundary
                    +--------------------------+
                    |                          |
  Client  --->     |  Routes  -->  Services   |  --->  Domain Modules
  (HTTP)           |    ^              |      |        (existing code)
                    |    |              v      |
                    |  Middleware    Temp File  |
                    |  (auth,       Lifecycle   |
                    |   validation,  Manager    |
                    |   errors)                |
                    +--------------------------+
```

### Component Boundaries

| Component | Responsibility | Communicates With | Location |
|-----------|---------------|-------------------|----------|
| **Server bootstrap** | Create Fastify instance, register plugins, start listening | All components (initialization) | `src/server.mjs` |
| **Route definitions** | Map HTTP verbs/paths to handler functions | Handlers, middleware | `src/routes/` |
| **Request handlers** | Parse multipart uploads, call services, format responses | Services, temp file manager | `src/handlers/` |
| **Service layer** | Orchestrate domain module calls, manage editor lifecycle | Domain modules, temp file manager | `src/services/` |
| **Middleware: auth** | Validate API key from Authorization header | Fastify request lifecycle | `src/middleware/auth.mjs` |
| **Middleware: errors** | Catch errors, format structured JSON error responses | Fastify error handler | `src/middleware/errors.mjs` |
| **Temp file manager** | Write uploaded buffers to disk, clean up after request | Handlers, OS filesystem | `src/lib/tempFiles.mjs` |
| **Domain modules** | All existing superdoc-redline logic (unchanged) | Each other (existing dependency graph) | `src/*.mjs` (existing) |

### Why This Structure

**Separation of HTTP from domain logic is the single most important architectural decision.** The existing modules accept file paths or buffers and return data structures. The HTTP layer's job is exclusively:

1. Receive bytes and metadata from HTTP
2. Make them available to domain modules (as buffers or temp file paths)
3. Take domain module output and send it as HTTP response
4. Clean up resources regardless of success/failure

This means the existing modules need zero modification. They already have buffer-accepting variants (`createHeadlessEditor(buffer)`, `extractDocumentIRFromBuffer(buffer, filename)`). The `applyEdits` function currently takes file paths, but a service layer can write the buffer to a temp file, call `applyEdits`, read the result, and return it.

---

## Data Flow

### POST /apply (Apply Edits)

```
Client sends: multipart/form-data
  - field "file": DOCX binary
  - field "edits": JSON string (or file upload)
  - field "options": JSON string (optional: author, trackChanges, strict, etc.)

1. AUTH MIDDLEWARE
   - Extract Bearer token from Authorization header
   - Validate against configured API key(s)
   - Reject 401 if invalid

2. HANDLER: parseApplyRequest
   - Parse multipart: extract file buffer + edits JSON + options
   - Validate: file exists, edits parse as valid JSON, required fields present
   - Reject 400 with structured error if validation fails

3. SERVICE: applyEditsService(fileBuffer, editConfig, options)
   a. Write fileBuffer to temp file (os.tmpdir)
   b. Generate output temp file path
   c. Call editApplicator.applyEdits(inputTempPath, outputTempPath, editConfig, options)
   d. Read output temp file into buffer
   e. Delete both temp files (in finally block)
   f. Return { resultBuffer, applyResult }

4. HANDLER: formatApplyResponse
   - If applyResult.success or applyResult.applied > 0:
     - Set Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document
     - Set Content-Disposition: attachment; filename="redlined.docx"
     - Set X-Applied-Count, X-Skipped-Count, X-Warnings headers (metadata)
     - Send DOCX buffer as response body
   - If total failure:
     - Return 422 with JSON error body containing validation issues

5. ERROR HANDLER (if exception)
   - Catch, log, ensure temp files cleaned up
   - Return 500 with structured JSON error
```

### POST /read (Read/Extract Document)

```
Client sends: multipart/form-data
  - field "file": DOCX binary
  - field "options": JSON string (optional: format, maxTokens)

1. AUTH MIDDLEWARE (same as above)

2. HANDLER: parseReadRequest
   - Parse multipart: extract file buffer + options
   - Validate: file exists
   - Reject 400 if validation fails

3. SERVICE: readDocumentService(fileBuffer, filename, options)
   a. Call irExtractor.extractDocumentIRFromBuffer(fileBuffer, filename, options)
   b. If format requires chunked reading:
     - Call chunking.chunkDocument(ir, maxTokens)
     - Return all chunks in single response
   c. Return IR JSON

4. HANDLER: formatReadResponse
   - Set Content-Type: application/json
   - Send IR JSON as response body

5. ERROR HANDLER (same pattern)
```

### GET /health

```
1. No auth required
2. Return { status: "ok", version: "x.y.z", uptime: process.uptime() }
```

---

## Patterns to Follow

### Pattern 1: Service Layer as Domain Adapter

**What:** A service module that adapts between HTTP-layer data (buffers, parsed JSON) and domain-module expectations (file paths, option objects). This is the only code that "knows" about both worlds.

**Why:** The existing `applyEdits()` expects file paths. Rather than rewriting it to accept buffers (which would change tested code), the service writes to temp files and calls the existing function. This is the safest approach for wrapping production CLI code.

**Confidence:** HIGH (based on direct code inspection -- `applyEdits` takes `inputPath`/`outputPath` strings)

```javascript
// src/services/applyService.mjs
import { applyEdits } from '../editApplicator.mjs';
import { createTempFile, cleanupTempFiles } from '../lib/tempFiles.mjs';
import { readFile } from 'fs/promises';

export async function applyEditsFromBuffer(fileBuffer, editConfig, options = {}) {
  const tempPaths = [];
  try {
    // Write input to temp file
    const inputPath = await createTempFile(fileBuffer, '.docx');
    tempPaths.push(inputPath);

    // Create output path
    const outputPath = inputPath.replace('.docx', '-output.docx');
    tempPaths.push(outputPath);

    // Call existing domain logic unchanged
    const result = await applyEdits(inputPath, outputPath, editConfig, options);

    // Read result back to buffer
    const resultBuffer = await readFile(outputPath);

    return { resultBuffer, result };
  } finally {
    await cleanupTempFiles(tempPaths);
  }
}
```

### Pattern 2: Deterministic Temp File Cleanup

**What:** Every temp file created during request processing is tracked and cleaned up in a `finally` block, regardless of whether the request succeeds or fails.

**Why:** File-processing APIs are the most common source of disk space leaks. A crashed request that leaves temp files behind, multiplied by thousands of requests, fills disks. This is the number one operational pitfall.

**Confidence:** HIGH (universal pattern)

```javascript
// src/lib/tempFiles.mjs
import { writeFile, unlink, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

export async function createTempFile(buffer, extension = '.tmp') {
  const dir = await mkdtemp(join(tmpdir(), 'superdoc-'));
  const filePath = join(dir, `upload${extension}`);
  await writeFile(filePath, buffer);
  return filePath;
}

export async function cleanupTempFiles(paths) {
  for (const p of paths) {
    try {
      await unlink(p);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`Failed to clean up temp file: ${p}`, err.message);
      }
    }
  }
  // Also clean up the temp directories
}
```

### Pattern 3: Structured Error Responses

**What:** All errors (validation, auth, server errors) return consistent JSON structure.

**Why:** API consumers need machine-parseable errors. Inconsistent error formats are the second most common API design complaint.

**Confidence:** HIGH (universal pattern)

```javascript
// Every error response has this shape:
{
  "error": {
    "code": "VALIDATION_ERROR",    // machine-readable
    "message": "Edits JSON is missing required field: version",  // human-readable
    "details": [                   // optional, for validation errors
      { "field": "version", "message": "Required field missing" },
      { "editIndex": 2, "message": "Block b999 not found in document" }
    ]
  }
}

// HTTP status codes:
// 400 - Bad request (malformed multipart, missing fields, invalid JSON)
// 401 - Unauthorized (missing or invalid API key)
// 413 - Payload too large (file exceeds size limit)
// 422 - Unprocessable entity (valid request but edits fail validation)
// 500 - Internal server error (unexpected crash)
```

### Pattern 4: Request-Scoped Logging with Correlation IDs

**What:** Each request gets a unique ID. All log lines for that request include the ID.

**Why:** When debugging production issues, you need to trace a single request through all log lines. Without correlation IDs, logs from concurrent requests interleave.

**Confidence:** HIGH (Fastify has built-in `request.id` support)

```javascript
// Fastify generates request.id automatically
// Access via request.id in handlers, or configure genReqId for custom format
fastify.addHook('onRequest', async (request) => {
  request.log.info({ url: request.url, method: request.method }, 'request started');
});

fastify.addHook('onResponse', async (request, reply) => {
  request.log.info({ statusCode: reply.statusCode, elapsed: reply.elapsedTime }, 'request completed');
});
```

### Pattern 5: Graceful Shutdown

**What:** On SIGTERM/SIGINT, stop accepting new requests, wait for in-flight requests to complete (with timeout), then exit.

**Why:** Prevents data corruption from killed requests mid-processing. Critical for file processing where partial writes can produce corrupt DOCX files.

**Confidence:** HIGH (Fastify has built-in `fastify.close()` with connection draining)

```javascript
// src/server.mjs
const shutdown = async (signal) => {
  fastify.log.info(`${signal} received, starting graceful shutdown`);
  try {
    await fastify.close(); // Fastify drains connections
  } catch (err) {
    fastify.log.error(err, 'Error during shutdown');
    process.exit(1);
  }
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Processing Files in Memory Without Limits

**What:** Accepting arbitrarily large file uploads and holding the entire file in memory.

**Why bad:** SuperDoc already loads DOCX into JSDOM virtual DOM, which amplifies memory usage. A 5MB DOCX file can become 50-100MB in memory when parsed into a virtual DOM with ProseMirror state. Without limits, a few concurrent large file uploads can OOM the process.

**Instead:**
- Set `@fastify/multipart` file size limit (e.g., 50MB for the upload, configurable)
- Set request body size limit on the Fastify instance
- Monitor `process.memoryUsage()` and reject requests if heap is above threshold
- Consider a concurrent request limit (max N simultaneous document processing operations)

**Confidence:** HIGH (confirmed by codebase analysis -- `createHeadlessEditor` creates JSDOM instance + Editor per document)

### Anti-Pattern 2: Modifying Domain Modules to Accept HTTP Objects

**What:** Passing Fastify request objects or multipart streams directly into domain modules.

**Why bad:** Couples domain logic to HTTP framework. Makes modules untestable outside HTTP context. Breaks existing CLI usage. Creates dual maintenance burden.

**Instead:** The service layer is the adapter. Domain modules never know they're being called from an HTTP server. They receive buffers, file paths, and plain JavaScript objects.

### Anti-Pattern 3: Streaming DOCX Processing

**What:** Trying to stream DOCX bytes through SuperDoc to avoid buffering the entire file.

**Why bad:** SuperDoc requires the complete DOCX buffer to load (`Editor.loadXmlData(buffer, true)`). DOCX is a ZIP archive that cannot be processed in streaming fashion -- the zip central directory is at the end of the file. The existing architecture requires full-file buffering and this cannot be changed.

**Instead:** Accept that each request fully buffers the DOCX file. Manage concurrency and memory limits to control total memory usage.

**Confidence:** HIGH (confirmed by `editorFactory.mjs` line 37: `Editor.loadXmlData(buffer, true)`)

### Anti-Pattern 4: Shared Editor State Between Requests

**What:** Creating a single editor instance and reusing it across requests.

**Why bad:** Editor state is mutated during edit application (ProseMirror transactions). Sharing state between requests would cause data corruption. The existing code creates and destroys editors per operation.

**Instead:** Each request creates its own editor instance, processes, and destroys it. This is already the pattern in the CLI code and must be preserved.

**Confidence:** HIGH (confirmed by `editApplicator.mjs` -- editor created line 296, destroyed line 426)

---

## Key Architectural Decisions

### Decision 1: Fastify over Express

**Recommendation:** Use Fastify as the HTTP framework.

**Rationale:**
- Built-in JSON schema validation for request/response (eliminates need for separate validation library for the HTTP layer)
- Built-in request logging with pino (structured JSON logs)
- Built-in request ID generation
- Plugin system with `@fastify/multipart` for file uploads
- Better performance than Express (matters for file processing where HTTP overhead should be minimal)
- Built-in graceful shutdown with connection draining via `fastify.close()`
- ESM support (matches existing codebase which is 100% ESM)
- TypeScript-friendly decorators for DX even in JS

**Alternatives considered:**
- Express: More ecosystem, but no built-in validation, logging, or graceful shutdown. Would need additional packages for each.
- Hono: Newer, excellent for edge/serverless, but less mature ecosystem for traditional server deployment with file uploads.
- Node.js native `http`: Too low-level for this use case. Would reinvent routing, body parsing, validation.

**Confidence:** MEDIUM-HIGH (well-established framework comparison, but exact current version unverified)

### Decision 2: Temp Files over Pure Memory Processing

**Recommendation:** Write uploaded buffers to temp files, pass file paths to existing domain modules.

**Rationale:**
- `applyEdits()` expects `inputPath` and `outputPath` strings (confirmed by code inspection)
- `readDocument()` expects `inputPath` string
- Rewriting these to accept buffers would mean modifying tested production code
- `extractDocumentIRFromBuffer()` already exists for extraction -- use it directly
- Temp file approach adds ~5-10ms latency (SSD write+read) which is negligible compared to JSDOM/SuperDoc processing time (100ms+)
- Provides natural backpressure: if disk fills, new requests fail cleanly

**Exception:** For the `/read` endpoint, `extractDocumentIRFromBuffer()` already accepts a buffer directly. No temp file needed.

**Confidence:** HIGH (verified from code: `applyEdits` signature at editApplicator.mjs line 273, `extractDocumentIRFromBuffer` at irExtractor.mjs line 319)

### Decision 3: No Worker Threads for V1

**Recommendation:** Process requests on the main thread for V1. Add worker thread isolation in V2 if needed.

**Rationale:**
- SuperDoc/JSDOM may not be safely transferable to worker threads (JSDOM creates a virtual DOM that likely cannot be serialized across thread boundaries)
- Worker threads require transferring the DOCX buffer (copy or transfer), creating a new JSDOM instance in the worker, and serializing results back -- this is essentially the same work as main thread processing
- The real bottleneck is JSDOM/ProseMirror processing time, not thread blocking
- A simpler approach for V1: limit concurrent processing with a semaphore (max N concurrent document operations)
- If worker isolation becomes necessary (for crash isolation or true parallelism), it's an additive change that doesn't affect the service layer interface

**When to revisit:** If (a) a single document operation takes >5 seconds and blocks health check responses, or (b) crash isolation is needed because SuperDoc operations can segfault or corrupt process state.

**Confidence:** MEDIUM (training-data based reasoning about JSDOM/worker thread compatibility -- would benefit from testing)

### Decision 4: Concurrency Limiter (Semaphore)

**Recommendation:** Limit concurrent document processing operations to a configurable maximum (default: 4).

**Rationale:**
- Each document operation creates a JSDOM instance + SuperDoc editor + ProseMirror state
- Memory usage per operation: estimated 50-200MB depending on document size
- Server with 2GB RAM can safely handle 4-8 concurrent operations
- Without limiting, burst traffic can OOM the process
- A simple semaphore pattern is sufficient

```javascript
// src/lib/concurrency.mjs
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release() {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      this.queue.shift()();
    }
  }
}
```

**Confidence:** HIGH (standard pattern, memory concerns confirmed by codebase analysis)

---

## Directory Structure

```
superdoc-api/
  src/
    # --- NEW: HTTP Layer ---
    server.mjs              # Fastify instance creation, plugin registration, startup
    config.mjs              # Environment-based configuration (port, API keys, limits)
    routes/
      apply.mjs             # POST /apply route definition
      read.mjs              # POST /read route definition
      health.mjs            # GET /health route definition
    handlers/
      applyHandler.mjs      # Parse multipart, call service, format response
      readHandler.mjs       # Parse multipart, call service, format response
    services/
      applyService.mjs      # Adapter: buffer/tempfile -> applyEdits -> buffer
      readService.mjs       # Adapter: buffer -> extractDocumentIRFromBuffer -> JSON
    middleware/
      auth.mjs              # API key validation hook
      errors.mjs            # Global error handler
    lib/
      tempFiles.mjs         # Temp file creation and cleanup
      concurrency.mjs       # Semaphore for concurrent request limiting

    # --- EXISTING: Domain Modules (unchanged) ---
    editorFactory.mjs
    irExtractor.mjs
    editApplicator.mjs
    documentReader.mjs
    blockOperations.mjs
    editMerge.mjs
    chunking.mjs
    markdownEditsParser.mjs
    clauseParser.mjs
    fuzzyMatch.mjs
    idManager.mjs
    textUtils.mjs
    wordDiff.mjs

  superdoc-redline.mjs      # Existing CLI entry point (unchanged)
  package.json
```

**Key principle:** All new code lives in clearly separated directories (`routes/`, `handlers/`, `services/`, `middleware/`, `lib/`). The existing `src/*.mjs` domain modules are not modified.

---

## Middleware Stack (Request Lifecycle)

Order matters. Fastify processes hooks in registration order.

```
Request arrives
  |
  v
1. onRequest: Request logging (built-in pino)
  |
  v
2. onRequest: Auth middleware
   - Check Authorization: Bearer <key>
   - Skip for GET /health
   - Reject 401 if invalid
  |
  v
3. preValidation: Content-Type check
   - Ensure multipart/form-data for POST endpoints
   - Reject 415 if wrong content type
  |
  v
4. Route handler executes
   - Parse multipart fields
   - Validate request body
   - Acquire concurrency semaphore
   - Call service
   - Release semaphore
   - Format response
  |
  v
5. onResponse: Response logging (timing, status code)
  |
  v
6. onError: Global error handler
   - Catch unhandled errors
   - Format structured JSON error response
   - Ensure temp file cleanup
```

---

## Configuration

```javascript
// src/config.mjs
export const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',

  // Auth
  apiKeys: (process.env.API_KEYS || '').split(',').filter(Boolean),

  // Limits
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || String(50 * 1024 * 1024), 10), // 50MB
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '4', 10),
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '120000', 10), // 2 minutes

  // Defaults
  defaultAuthor: {
    name: process.env.DEFAULT_AUTHOR_NAME || 'AI Assistant',
    email: process.env.DEFAULT_AUTHOR_EMAIL || 'ai@example.com',
  },
};
```

---

## Scalability Considerations

| Concern | Low load (10 req/min) | Medium load (100 req/min) | High load (1000+ req/min) |
|---------|----------------------|--------------------------|--------------------------|
| **Memory** | Single process fine (~512MB) | Monitor heap, may need 2-4GB | Multiple processes/pods required |
| **Concurrency** | Semaphore max=4 sufficient | Increase to max=8-16 with more RAM | Horizontal scaling (multiple containers) |
| **Temp files** | Negligible disk usage | Monitor disk space, add periodic cleanup cron | RAM disk (tmpfs) for temp files |
| **CPU** | Single core sufficient | JSDOM/ProseMirror is CPU-bound, consider cluster mode | Worker processes or container replicas |
| **Approach** | Single Fastify process | Single process with tuned limits | Kubernetes/ECS with horizontal pod autoscaling |

**V1 target:** Low-to-medium load. Single process, semaphore-limited concurrency.

---

## Build Order (Dependencies Between Components)

The recommended implementation order, based on component dependencies:

### Phase 1: Skeleton + Health Check
**Build:** `server.mjs`, `config.mjs`, `routes/health.mjs`
**Why first:** Validates that Fastify starts, listens, and responds. Deployment target can be verified immediately. Zero dependency on domain modules.
**Depends on:** Nothing (greenfield)
**Validates:** Framework choice, ESM compatibility, basic server lifecycle

### Phase 2: Auth Middleware
**Build:** `middleware/auth.mjs`
**Why second:** Every subsequent endpoint needs auth. Build and test it once before adding real endpoints.
**Depends on:** Phase 1 (server exists to register hooks on)
**Validates:** Fastify hook system, environment variable configuration

### Phase 3: Error Handling
**Build:** `middleware/errors.mjs`
**Why third:** All subsequent endpoint development benefits from consistent error formatting. Debugging is easier when errors are structured from the start.
**Depends on:** Phase 1 (server exists)
**Validates:** Fastify error handler, structured error response format

### Phase 4: Read Endpoint (simpler path)
**Build:** `routes/read.mjs`, `handlers/readHandler.mjs`, `services/readService.mjs`
**Why before apply:** The read endpoint is simpler (no temp files for output, no edit parsing, buffer-based via `extractDocumentIRFromBuffer`). It validates the multipart upload parsing and service layer patterns without the complexity of temp file management.
**Depends on:** Phases 1-3, existing `irExtractor.mjs` (specifically `extractDocumentIRFromBuffer`)
**Validates:** Multipart upload parsing, service layer pattern, domain module integration, JSON response formatting

### Phase 5: Temp File Manager + Concurrency Limiter
**Build:** `lib/tempFiles.mjs`, `lib/concurrency.mjs`
**Why here:** The apply endpoint needs both. Build and test them as isolated utilities before integrating.
**Depends on:** Nothing (pure utilities)
**Validates:** Temp file lifecycle, cleanup guarantees, semaphore behavior

### Phase 6: Apply Endpoint (complex path)
**Build:** `routes/apply.mjs`, `handlers/applyHandler.mjs`, `services/applyService.mjs`
**Why last among endpoints:** Most complex endpoint. Requires multipart parsing (DOCX + edits), temp file management, domain module orchestration, and binary response formatting. All supporting infrastructure should be in place.
**Depends on:** Phases 1-5, existing `editApplicator.mjs`
**Validates:** Full request lifecycle, temp file cleanup, binary response streaming, edit validation error handling

### Phase 7: Graceful Shutdown + Production Hardening
**Build:** Shutdown handlers in `server.mjs`, request timeout configuration, memory monitoring
**Why last:** Operational concerns that don't affect functionality but are critical for production reliability.
**Depends on:** All phases (needs full system to test shutdown behavior)
**Validates:** Connection draining, in-flight request completion, temp file cleanup on shutdown

---

## Key Interface Contracts

### Service Layer Interfaces

These are the contracts between HTTP handlers and services. They define the boundary.

```javascript
// applyService interface
applyEditsFromBuffer(
  fileBuffer: Buffer,           // Raw DOCX bytes from upload
  editConfig: {                 // Parsed edit instructions
    version: string,
    edits: Edit[],
    author?: { name: string, email: string }
  },
  options?: {                   // Processing options
    trackChanges?: boolean,     // default: true
    strict?: boolean,           // default: false
    skipInvalid?: boolean,      // default: false
    allowReduction?: boolean,   // default: false
    author?: { name: string, email: string }
  }
) => Promise<{
  resultBuffer: Buffer,         // Output DOCX bytes
  result: ApplyResult           // Domain result (applied, skipped, warnings)
}>

// readService interface
readDocumentFromBuffer(
  fileBuffer: Buffer,           // Raw DOCX bytes from upload
  filename: string,             // Original filename for metadata
  options?: {
    format?: 'full' | 'outline' | 'blocks',
    maxTokens?: number,
    includeMetadata?: boolean
  }
) => Promise<DocumentIR>        // Structured document representation
```

### HTTP Response Contracts

```
POST /apply
  Success: 200, Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document
    Body: DOCX binary
    Headers: X-Applied-Count, X-Skipped-Count, X-Warning-Count
  Validation failure: 422, Content-Type: application/json
    Body: { error: { code, message, details } }

POST /read
  Success: 200, Content-Type: application/json
    Body: DocumentIR JSON
  Validation failure: 400, Content-Type: application/json
    Body: { error: { code, message } }

GET /health
  Success: 200, Content-Type: application/json
    Body: { status: "ok", version, uptime, concurrent: { active, max } }
```

---

## What This Architecture Does NOT Address (Deferred)

These are explicitly out of scope for V1 but noted for future consideration:

| Topic | Why Deferred | When to Revisit |
|-------|-------------|-----------------|
| **Worker thread isolation** | JSDOM transferability uncertain, adds complexity | If operations >5s block health checks |
| **Request queuing** | Semaphore provides simple backpressure | If need priority queues or job scheduling |
| **File storage / caching** | Stateless design is simpler and sufficient | If same document processed repeatedly |
| **Streaming responses** | DOCX must be fully generated before sending | Never (fundamental DOCX constraint) |
| **OpenAPI spec generation** | Nice for documentation but not blocking | After endpoints are stable |
| **Rate limiting** | Handled at infrastructure level (reverse proxy) | If deployed without reverse proxy |
| **HTTPS/TLS** | Handled at infrastructure level (load balancer) | If deployed without TLS termination |

---

## Sources

| Claim | Source | Confidence |
|-------|--------|------------|
| `applyEdits` takes file paths | Direct code inspection: `editApplicator.mjs` line 273 | HIGH |
| `extractDocumentIRFromBuffer` exists | Direct code inspection: `irExtractor.mjs` line 319 | HIGH |
| Editor created/destroyed per operation | Direct code inspection: `editApplicator.mjs` lines 296, 426 | HIGH |
| JSDOM + SuperDoc memory amplification | Codebase analysis: `editorFactory.mjs` creates JSDOM + Editor per call | HIGH |
| Fastify has built-in schema validation, pino logging, graceful shutdown | Training data (well-established, unlikely changed) | MEDIUM-HIGH |
| `@fastify/multipart` handles file uploads | Training data (official Fastify plugin) | MEDIUM-HIGH |
| Worker threads may not work with JSDOM | Training data (JSDOM uses C++ bindings via internal deps) | MEDIUM |
| Temp file write adds ~5-10ms on SSD | Training data (general I/O benchmark knowledge) | MEDIUM |
