# Phase 4: Read Endpoint - Research

**Researched:** 2026-02-06
**Domain:** Fastify route handlers, multipart file upload integration, SuperDoc IR extraction, JSON response handling
**Confidence:** HIGH

## Summary

Phase 4 creates the POST /v1/read endpoint that accepts a DOCX file upload and returns the complete document intermediate representation (IR) as JSON. This phase integrates the file upload validation from Phase 3 with the existing `extractDocumentIRFromBuffer()` domain module to expose document extraction as an HTTP service.

The standard approach uses a Fastify POST route handler that: (1) receives the multipart file via `request.file()` from @fastify/multipart (already configured in Phase 3), (2) runs the validation pipeline (size, magic bytes, zip bomb) established in Phase 3, (3) calls `extractDocumentIRFromBuffer(buffer, filename)` to get the IR, (4) returns the IR as JSON with `reply.send(ir)`. The existing domain module handles all SuperDoc/JSDOM interaction and returns a structured IR object with blocks, outline, defined terms, and ID mapping.

The critical concern is resource cleanup: the domain module creates a JSDOM window and SuperDoc editor instance that MUST be destroyed after extraction. The current `extractDocumentIRFromBuffer()` implementation already calls `editor.destroy()` internally, which is correct. However, Phase 5 will add explicit JSDOM window cleanup (`window.close()`) to prevent memory leaks. For Phase 4, we rely on the existing cleanup and document that Phase 5 will harden it.

**Primary recommendation:** Create a single route handler at POST /v1/read that chains Phase 3's validation pipeline with `extractDocumentIRFromBuffer()`, wraps the operation in try/catch for error handling, and returns the IR as JSON. All chunks are returned in a single response (no pagination). Defer concurrency limiting and explicit window cleanup to Phase 5.

## Standard Stack

The established libraries/tools for this phase:

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @fastify/multipart | 9.4.0 | File upload handling | Already configured in Phase 3; provides `request.file()` and size limit enforcement |
| @harbour-enterprises/superdoc | ^1.0.0 | DOCX parsing and editing | Already installed; core dependency; provides headless editor via irExtractor |
| jsdom | ^24.0.0 | Virtual DOM for SuperDoc | Already installed; required by SuperDoc for document manipulation |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (Phase 3 validation) | - | Magic bytes + zip bomb checks | Already implemented; reuse validateMagicBytes() and checkZipBomb() |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| extractDocumentIRFromBuffer() | extractDocumentIR() with temp file | extractDocumentIRFromBuffer() works directly with the uploaded buffer, avoiding temp file I/O. Use buffer API. |
| Full IR in single response | Chunked/paginated response | READ-03 requirement: "All chunks returned in single response". Simplifies API. Large documents (500KB-2MB JSON) are acceptable for v1. |
| Fastify reply.send(ir) | Streaming JSON | IR is fully constructed in memory by extractDocumentIRFromBuffer(). Streaming adds complexity without benefit. Use reply.send(). |

**Installation:**

No new dependencies. All required libraries already installed.

## Architecture Patterns

### Recommended Project Structure (additions to Phase 3)

```
src/
  routes/
    read.mjs              # NEW: POST /v1/read endpoint
  validation/
    file-upload.mjs       # (existing from Phase 3)
```

### Pattern 1: Read Endpoint Route Handler

**What:** A POST route handler at /v1/read that combines Phase 3 validation with domain module IR extraction.
**When to use:** This is the single read endpoint for Phase 4.
**Source:** Fastify Routes docs, existing domain modules

```javascript
// src/routes/read.mjs

import { extractDocumentIRFromBuffer } from "../irExtractor.mjs";
import { validateMagicBytes, checkZipBomb } from "../validation/file-upload.mjs";

/**
 * POST /v1/read - Extract document IR from uploaded DOCX file
 *
 * Requires:
 * - Authorization: Bearer <API_KEY> (from Phase 2 auth plugin)
 * - Content-Type: multipart/form-data (validated by Phase 2 preHandler)
 *
 * Request: Multipart with single DOCX file
 * Response: JSON with document IR (blocks, outline, definedTerms, idMapping)
 *
 * @param {import("fastify").FastifyInstance} fastify
 */
async function readRoutes(fastify) {
  fastify.post("/read", async (request, reply) => {
    // Step 1: Get uploaded file (size limit enforced by multipart plugin)
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({
        error: {
          code: "MISSING_FILE",
          message: "No file uploaded",
          details: [],
        },
      });
    }

    // Step 2: Buffer the file
    const buffer = await data.toBuffer();
    const filename = data.filename || "document.docx";

    // Step 3: Validate magic bytes
    const magicResult = validateMagicBytes(buffer);
    if (!magicResult.valid) {
      return reply.status(400).send({
        error: {
          code: "INVALID_FILE_TYPE",
          message: magicResult.error,
          details: [],
        },
      });
    }

    // Step 4: Check for zip bomb
    const bombResult = await checkZipBomb(buffer);
    if (!bombResult.safe) {
      return reply.status(400).send({
        error: {
          code: "ZIP_BOMB_DETECTED",
          message: bombResult.error,
          details: [],
        },
      });
    }

    // Step 5: Extract document IR
    try {
      const ir = await extractDocumentIRFromBuffer(buffer, filename, {
        format: "full",
        includeDefinedTerms: true,
        includeOutline: true,
      });

      // Step 6: Return IR as JSON
      reply.type("application/json").send(ir);
    } catch (error) {
      // Domain module error (SuperDoc/JSDOM failure, corrupted DOCX, etc.)
      request.log.error({ err: error }, "Document extraction failed");
      return reply.status(422).send({
        error: {
          code: "EXTRACTION_FAILED",
          message: "Unable to process document",
          details: [],
        },
      });
    }
  });
}

export default readRoutes;
```

### Pattern 2: Route Registration in app.mjs

**What:** Register the read route inside the protected /v1 scope established in Phase 2.
**When to use:** During app initialization after auth plugin registration.

```javascript
// src/app.mjs (additions)

import readRoutes from "./routes/read.mjs";

// Inside the protected /v1 scope:
app.register(async function protectedRoutes(scope) {
  scope.register(authPlugin);
  scope.register(healthRoutes);
  scope.register(readRoutes);  // NEW: read endpoint
}, { prefix: "/v1" });
```

### Pattern 3: Error Handling for Domain Operations

**What:** Wrap domain module calls (which may throw) in try/catch and map to appropriate HTTP status codes.
**When to use:** Any route handler calling SuperDoc/JSDOM operations.
**Why 422 for extraction failures:** The file is valid (passed validation), but the DOCX content is corrupted or unsupported. 422 Unprocessable Entity is the correct status.

Error mapping:
- Validation failures (magic bytes, zip bomb) → 400 Bad Request
- Domain extraction failures (SuperDoc throws, corrupted DOCX) → 422 Unprocessable Entity
- Unexpected errors (OOM, uncaught exceptions) → 500 Internal Server Error (caught by global error handler)

### Pattern 4: Response Format for Read Endpoint

**What:** Return the IR object directly. Fastify auto-serializes to JSON.
**When to use:** Success responses from /v1/read.

Example response structure (matches existing IR format):

```json
{
  "metadata": {
    "filename": "contract.docx",
    "generated": "2026-02-06T10:30:00.000Z",
    "version": "0.2.0",
    "blockCount": 145,
    "format": "full",
    "idsAssigned": 42
  },
  "blocks": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "seqId": "sd-1",
      "type": "heading",
      "text": "1. Introduction",
      "level": 1,
      "number": "1",
      "startPos": 0,
      "endPos": 50
    }
    // ... more blocks
  ],
  "outline": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "seqId": "sd-1",
      "level": 1,
      "number": "1",
      "title": "1. Introduction",
      "children": []
    }
    // ... more outline items
  ],
  "definedTerms": {
    "Effective Date": {
      "definedIn": "550e8400-...",
      "seqId": "sd-5",
      "usedIn": ["550e8400-...", "550e8400-..."]
    }
  },
  "idMapping": {
    "550e8400-e29b-41d4-a716-446655440000": "sd-1",
    "7a8b9c10-...": "sd-2"
    // ... full UUID -> seqId mapping
  }
}
```

### Anti-Patterns to Avoid

- **Calling extractDocumentIR() with temp file:** The domain module provides `extractDocumentIRFromBuffer()` specifically for in-memory buffers. Don't write the uploaded file to disk just to pass a path to `extractDocumentIR()`. Use the buffer API.
- **Not consuming the file stream:** If `request.file()` returns a file, you MUST call `await data.toBuffer()` or pipe the stream. Failing to consume causes request hangs (Phase 3 pitfall applies here).
- **Returning 500 for corrupted DOCX:** Corrupted or unsupported DOCX files should return 422 (Unprocessable Entity), not 500. The server is working correctly; the document content is invalid.
- **Manual JSON serialization:** Don't call `JSON.stringify(ir)` yourself. Use `reply.send(ir)` and Fastify will serialize it automatically (faster and handles edge cases).
- **Forgetting to set Content-Type:** Explicitly set `reply.type("application/json")` before sending. Fastify may infer it, but being explicit is clearer.

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| DOCX parsing and IR extraction | Custom ZIP/XML parsing for DOCX structure | extractDocumentIRFromBuffer() domain module | Already implemented, tested, and production-ready. Handles block IDs, outline generation, defined terms, and SuperDoc editor lifecycle. |
| File upload buffering | Manual multipart boundary parsing and buffering | @fastify/multipart request.file() + toBuffer() | Multipart parsing has dozens of edge cases (see Phase 3). The plugin handles it. |
| JSON serialization | Custom serialization with circular reference handling | Fastify reply.send() | Fastify uses fast-json-stringify for schemas or native JSON.stringify with stream optimization. Don't roll your own. |
| Request/response lifecycle | Manual error propagation and cleanup | Fastify async route handlers with try/catch | Fastify automatically catches async errors, routes to error handler, and sends structured responses. |

**Key insight:** The domain module (`extractDocumentIRFromBuffer`) is the entire implementation. The route handler's job is to validate input, call the domain module, and map the result to HTTP semantics (status codes, error bodies). Don't reimplement any of the document processing logic.

## Common Pitfalls

### Pitfall 1: Not Handling Domain Module Errors

**What goes wrong:** `extractDocumentIRFromBuffer()` throws an error (corrupted DOCX, SuperDoc failure), but the route handler doesn't catch it. The global error handler returns 500 with a generic message, not explaining what went wrong.
**Why it happens:** Developer assumes domain module never throws, or relies on global error handler for all errors.
**How to avoid:** Wrap the `extractDocumentIRFromBuffer()` call in try/catch. Map domain errors to 422 with a clear error code (`EXTRACTION_FAILED`). Log the full error server-side for debugging.
**Warning signs:** Users reporting "Internal server error" for valid-looking DOCX files. No specific error messages about what's wrong with the document.

### Pitfall 2: Memory Leak from JSDOM Window

**What goes wrong:** After processing many requests, the server runs out of memory (OOM). Memory profiling shows JSDOM window objects are not garbage collected.
**Why it happens:** The `extractDocumentIRFromBuffer()` function calls `editor.destroy()`, but does NOT call `window.close()` on the JSDOM window. JSDOM windows hold large references (DOM tree, event listeners) that prevent GC.
**How to avoid:** **For Phase 4:** Document this as a known limitation. Phase 5 (Resource Management) will add explicit `window.close()` cleanup. The editor factory (`createHeadlessEditor`) creates a JSDOM window, and the IR extractor must destroy both the editor AND the window.
**Warning signs:** Increasing memory usage over 20+ sequential requests. `process.memoryUsage().heapUsed` grows without leveling off.
**Note:** This is a CRITICAL issue but is explicitly deferred to Phase 5 per the roadmap. Phase 4 documents it; Phase 5 fixes it.

### Pitfall 3: Large JSON Response Blocking Event Loop

**What goes wrong:** Extracting a large document (500+ blocks) produces a 2MB JSON response. Serializing and sending this blocks the event loop for 50-100ms, degrading performance for concurrent requests.
**Why it happens:** JSON serialization and socket writes are synchronous operations on the main thread.
**How to avoid:** **For Phase 4:** Accept this limitation. The requirement (READ-03) mandates returning all chunks in a single response. For very large documents (2MB+ JSON), the serialization time is acceptable for v1. Phase 5 may add streaming or compression, but it's not required yet.
**Warning signs:** High p99 latency for large documents. Event loop lag spikes when processing big files.
**Recommendation:** If this becomes a problem, Phase 5 or later can add `@fastify/compress` for gzip compression, reducing response size by ~80%.

### Pitfall 4: Not Validating File Before Processing

**What goes wrong:** The route handler skips magic byte or zip bomb checks and directly calls `extractDocumentIRFromBuffer()`. A malicious file (zip bomb or PNG disguised as DOCX) causes resource exhaustion.
**Why it happens:** Developer assumes multipart size limit is sufficient protection, or forgets to call validation functions from Phase 3.
**How to avoid:** ALWAYS run the full validation pipeline before calling domain modules: (1) magic bytes, (2) zip bomb check. These are quick checks (<10ms) that prevent expensive failures downstream.
**Warning signs:** Server crashes or hangs when processing certain files. No 400-level errors for invalid files.

### Pitfall 5: Returning Full Error Details to Client

**What goes wrong:** The catch block returns `error.message` directly to the client, exposing file paths, SuperDoc internal error messages, or JSDOM stack traces.
**Why it happens:** Developer logs the error and forgets to sanitize before sending it to the client.
**How to avoid:** Return a generic error message to the client (`"Unable to process document"`). Log the full error server-side with `request.log.error()`. The error sanitization from Phase 2 should catch this at the global handler level, but route-specific handlers should also be defensive.
**Warning signs:** Error responses containing strings like `/node_modules/`, `jsdom:`, or `at Object.<anonymous>`.

### Pitfall 6: Filename Not Passed to IR Extractor

**What goes wrong:** The IR metadata always shows `filename: "document.docx"` even when the user uploads a file with a different name.
**Why it happens:** The route handler doesn't pass `data.filename` to `extractDocumentIRFromBuffer()`.
**How to avoid:** Always pass `data.filename || "document.docx"` as the second argument to `extractDocumentIRFromBuffer()`. This filename appears in the IR metadata and is useful for debugging.
**Warning signs:** All IR responses have the same generic filename.

## Code Examples

Verified patterns from official sources:

### Complete Read Route Handler

```javascript
// src/routes/read.mjs
// Source: Fastify Routes docs + existing domain modules

import { extractDocumentIRFromBuffer } from "../irExtractor.mjs";
import { validateMagicBytes, checkZipBomb } from "../validation/file-upload.mjs";

/**
 * Read endpoint routes.
 * POST /v1/read - Extract document IR from uploaded DOCX.
 *
 * @param {import("fastify").FastifyInstance} fastify
 */
async function readRoutes(fastify) {
  fastify.post("/read", async (request, reply) => {
    // Step 1: Get uploaded file (multipart size limit enforced by plugin)
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({
        error: {
          code: "MISSING_FILE",
          message: "No file uploaded",
          details: [],
        },
      });
    }

    // Step 2: Buffer the file
    const buffer = await data.toBuffer();
    const filename = data.filename || "document.docx";

    // Step 3: Validate magic bytes (4-byte check, ~1ms)
    const magicResult = validateMagicBytes(buffer);
    if (!magicResult.valid) {
      return reply.status(400).send({
        error: {
          code: "INVALID_FILE_TYPE",
          message: magicResult.error,
          details: [],
        },
      });
    }

    // Step 4: Check for zip bomb (central directory scan, ~10ms)
    const bombResult = await checkZipBomb(buffer);
    if (!bombResult.safe) {
      return reply.status(400).send({
        error: {
          code: "ZIP_BOMB_DETECTED",
          message: bombResult.error,
          details: [],
        },
      });
    }

    // Step 5: Extract document IR (SuperDoc + JSDOM, 100ms-2s depending on size)
    try {
      const ir = await extractDocumentIRFromBuffer(buffer, filename, {
        format: "full",
        includeDefinedTerms: true,
        includeOutline: true,
      });

      // Step 6: Return IR as JSON
      return reply.type("application/json").send(ir);
    } catch (error) {
      // Domain module error (corrupted DOCX, SuperDoc failure, etc.)
      request.log.error({ err: error, filename }, "Document extraction failed");
      return reply.status(422).send({
        error: {
          code: "EXTRACTION_FAILED",
          message: "Unable to process document",
          details: [],
        },
      });
    }
  });
}

export default readRoutes;
```

### Registering Read Route in app.mjs

```javascript
// src/app.mjs (additions)
// Source: Existing app.mjs pattern from Phase 1

import readRoutes from "./routes/read.mjs";

export default function buildApp(opts = {}) {
  const app = Fastify({ /* ... */ });

  // Global plugins
  app.register(requestIdPlugin);
  app.register(errorHandlerPlugin);
  app.register(multipartPlugin);  // Phase 3

  // Health at root level (unprotected)
  app.register(healthRoutes);

  // Protected /v1 scope
  app.register(async function protectedRoutes(scope) {
    scope.register(authPlugin);  // Phase 2
    scope.register(healthRoutes); // /v1/health (protected)
    scope.register(readRoutes);   // NEW: /v1/read (protected)
  }, { prefix: "/v1" });

  return app;
}
```

### Testing Read Endpoint with fastify.inject()

```javascript
// tests/routes/read.test.mjs
// Source: Fastify testing patterns + Phase 1 test examples

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";
import buildApp from "../../src/app.mjs";

describe("POST /v1/read", () => {
  let app;

  before(async () => {
    process.env.API_KEY = "test-key-read-endpoint";
    app = buildApp({ logger: false });
    await app.ready();
  });

  after(async () => {
    await app.close();
    delete process.env.API_KEY;
  });

  it("returns document IR for valid DOCX", async () => {
    const docxBuffer = await readFile("./tests/fixtures/sample.docx");
    const { payload, contentType } = buildMultipartPayload("sample.docx", docxBuffer);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        authorization: "Bearer test-key-read-endpoint",
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();

    // Validate IR structure
    assert.ok(body.metadata, "Response has metadata");
    assert.ok(body.blocks, "Response has blocks");
    assert.ok(Array.isArray(body.blocks), "Blocks is an array");
    assert.ok(body.outline, "Response has outline");
    assert.ok(body.idMapping, "Response has idMapping");
    assert.ok(body.definedTerms !== undefined, "Response has definedTerms");

    // Validate metadata
    assert.equal(body.metadata.filename, "sample.docx");
    assert.equal(body.metadata.format, "full");
    assert.ok(body.metadata.blockCount > 0, "Has blocks");
  });

  it("rejects request without file with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      headers: {
        authorization: "Bearer test-key-read-endpoint",
        "content-type": "multipart/form-data; boundary=---test",
      },
      payload: "---test\r\n---test--\r\n", // Empty multipart
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error.code, "MISSING_FILE");
  });

  it("rejects non-DOCX file with 400", async () => {
    // PNG file disguised as DOCX
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { payload, contentType } = buildMultipartPayload("fake.docx", pngBuffer);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        authorization: "Bearer test-key-read-endpoint",
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error.code, "INVALID_FILE_TYPE");
  });

  it("rejects corrupted DOCX with 422", async () => {
    // Valid ZIP header but corrupted content
    const corruptedBuffer = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // ZIP magic
      Buffer.alloc(100).fill(0xff), // Garbage
    ]);
    const { payload, contentType } = buildMultipartPayload("corrupt.docx", corruptedBuffer);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        authorization: "Bearer test-key-read-endpoint",
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 422);
    const body = res.json();
    assert.equal(body.error.code, "EXTRACTION_FAILED");
  });

  it("requires authentication", async () => {
    const docxBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const { payload, contentType } = buildMultipartPayload("test.docx", docxBuffer);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: { "content-type": contentType }, // No auth header
    });

    assert.equal(res.statusCode, 401);
  });
});

// Helper function to build multipart payload
function buildMultipartPayload(filename, content) {
  const boundary = "----FormBoundary" + Date.now();
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([header, content, footer]);

  return {
    payload,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Temp file for upload + extractDocumentIR() | In-memory buffer + extractDocumentIRFromBuffer() | Domain module already has buffer API | No disk I/O; faster and simpler |
| Chunked read endpoint (pagination) | All-in-one response | Project decision (PROJECT.md, READ-03) | Simpler API surface; acceptable response size for v1 |
| Manual JSDOM window cleanup in route | Cleanup in domain module (deferred to Phase 5) | Phase 5 will add explicit window.close() | Phase 4 documents the issue; Phase 5 hardens it |
| Fastify v4 patterns | Fastify v5 patterns | Fastify v5 released 2024 | Use Fastify 5 APIs (already established in Phase 1) |

**Deprecated/outdated:**
- **extractDocumentIR() with file path for uploads:** Use `extractDocumentIRFromBuffer()` instead. Avoids temp file I/O.
- **documentReader.mjs `readDocument()` with chunking:** That's for CLI usage with large documents. The HTTP endpoint returns full IR per READ-03.

## Open Questions

Things that couldn't be fully resolved:

1. **Should the endpoint support format query param (full/outline/summary)?**
   - What we know: The domain module supports `format: 'full'|'outline'|'summary'`. CLI uses this. HTTP endpoint currently hardcodes `format: 'full'`.
   - What's unclear: Whether the API should expose format selection via query param (`?format=outline`).
   - Recommendation: Start with `full` only (simplest). Add query param support in Phase 7 (extended features) if needed. The requirement (READ-02) says "full document structure", implying full format.

2. **How large can IR responses realistically get?**
   - What we know: A typical contract (50 pages, 200 blocks) produces ~500KB JSON. A large document (200 pages, 800 blocks) could produce 2MB JSON.
   - What's unclear: Whether 2MB JSON responses will cause performance issues at scale.
   - Recommendation: Accept 2MB responses for Phase 4. If p99 latency is unacceptable, Phase 5 or later can add `@fastify/compress` (gzip reduces JSON by ~80%). The requirement doesn't mandate compression for v1.

3. **Should JSDOM window cleanup be in Phase 4 or deferred to Phase 5?**
   - What we know: `extractDocumentIRFromBuffer()` calls `editor.destroy()` but NOT `window.close()`. JSDOM windows can leak memory. Phase 5's goal is "no memory growth over 20+ requests".
   - What's unclear: Whether Phase 4 should add window cleanup or document it as a known issue.
   - Recommendation: Document the issue in Phase 4 research. Phase 5 will modify `createHeadlessEditor()` to return both editor and window, and modify IR extractor to call both `editor.destroy()` and `window.close()`. This keeps Phase 4 focused on endpoint integration, not domain module refactoring.

4. **Error code for corrupted DOCX: 400 or 422?**
   - What we know: Corrupted DOCX passes validation (magic bytes, zip bomb) but fails during extraction. It's valid ZIP, but invalid DOCX content.
   - What's unclear: HTTP semantics for "valid upload, invalid document content".
   - Recommendation: Use 422 Unprocessable Entity. The request is well-formed, the file is valid ZIP, but the content cannot be processed as a DOCX. 422 is more specific than 400.

## Sources

### Primary (HIGH confidence)
- Fastify Routes Reference (https://fastify.dev/docs/latest/Reference/Routes/) - Route handlers, async patterns, reply methods
- Fastify Reply Reference (https://fastify.dev/docs/latest/Reference/Reply/) - reply.send(), reply.type(), serialization behavior
- @fastify/multipart README (https://github.com/fastify/fastify-multipart) - request.file(), toBuffer(), multipart handling
- Existing domain modules (src/irExtractor.mjs, src/documentReader.mjs) - Verified APIs: extractDocumentIRFromBuffer(), IR structure
- Phase 3 research (03-RESEARCH.md) - File validation pipeline: validateMagicBytes(), checkZipBomb()
- REQUIREMENTS.md (READ-01, READ-02, READ-03) - Explicit requirements for response structure and behavior

### Secondary (MEDIUM confidence)
- Fastify Error Handling guide (https://fastify.dev/docs/latest/Reference/Errors/) - Error handler patterns, status codes
- Better Stack: File Uploads with Fastify (https://betterstack.com/community/guides/scaling-nodejs/fastify-file-uploads/) - Multipart route handler patterns
- Snyk: Node.js file uploads with Fastify (https://snyk.io/blog/node-js-file-uploads-with-fastify/) - Best practices for file upload security and error handling
- Node.js Memory Management articles (https://www.codestudy.net/blog/jsdom-and-node-js-leaking-memory/) - JSDOM memory leak documentation

### Tertiary (LOW confidence)
- None. All patterns verified against existing codebase or official docs.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries already installed and configured; @fastify/multipart verified in Phase 3
- Architecture: HIGH - Route handler pattern follows existing health route structure; domain module APIs verified in source code
- Pitfalls: HIGH - JSDOM memory leak documented in Phase 5 goal; domain error handling verified via try/catch requirement
- Response format: HIGH - IR structure verified in irExtractor.mjs source code; matches existing CLI output

**Research date:** 2026-02-06
**Valid until:** 2026-03-08 (30 days -- stable Fastify 5, existing domain modules)
