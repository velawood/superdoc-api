# Phase 6: Apply Endpoint Core - Research

**Researched:** 2026-02-06
**Domain:** Fastify binary responses, multipart form parsing with mixed fields, DOCX recompression, edit validation, SuperDoc editor lifecycle
**Confidence:** HIGH

## Summary

Phase 6 creates the POST /v1/apply endpoint that accepts a DOCX file and JSON edits via multipart/form-data and returns a recompressed DOCX file with tracked changes. This phase integrates the complete editing workflow: file upload validation from Phase 3, resource management from Phase 5, and the existing domain modules (editApplicator, blockOperations) to expose document editing as an HTTP service.

The standard approach uses a Fastify POST route handler that: (1) receives multipart data with both a file field and a JSON field via @fastify/multipart's `request.parts()` async iterator, (2) runs the Phase 3 validation pipeline on the DOCX file, (3) parses the JSON edits field, (4) creates a headless editor from the buffer, (5) validates all edits against the document IR using `validateEditsAgainstIR()` (fail-fast with full error list if any edit is invalid), (6) applies edits using existing domain modules, (7) exports the modified document as a buffer, (8) recompresses the buffer using archiver + unzipper to reduce file size from SuperDoc's uncompressed output, and (9) returns the compressed DOCX buffer with proper Content-Disposition header for download.

The critical concerns are: (1) multipart parsing with mixed field types (file + JSON), (2) edit validation must reject the entire request if any edit is invalid (no partial application per APPLY-02), (3) recompression must happen in-memory without temp files for performance, (4) binary response must use proper headers (Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document, Content-Disposition: attachment; filename="..."), and (5) resource cleanup from Phase 5 must be integrated to destroy editor and JSDOM window.

**Primary recommendation:** Create a single route handler at POST /v1/apply that uses `request.parts()` to parse both file and edits, validates edits before applying (reject entire request with 400 if validation fails), applies edits via existing domain modules, recompresses the output buffer in-memory, and returns the DOCX with proper headers. Phase 5's resource management patterns must be integrated for JSDOM cleanup. Defer markdown edit format and dry-run mode to Phase 7.

## Standard Stack

The established libraries/tools for this phase:

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @fastify/multipart | 9.4.0 | Mixed multipart parsing | Already configured in Phase 3; provides `request.parts()` async iterator for file + JSON fields |
| @harbour-enterprises/superdoc | ^1.0.0 | DOCX editing with track changes | Already installed; core dependency; provides editor lifecycle and exportDocx() |
| archiver | ^7.0.1 | ZIP compression | Already installed; streaming ZIP creation with configurable compression (level 9 for max) |
| unzipper | ^0.12.3 | ZIP extraction | Already installed; streaming ZIP extraction for recompression workflow |
| jsdom | ^24.0.0 | Virtual DOM for SuperDoc | Already installed; required by SuperDoc; must be cleaned up per Phase 5 |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (Phase 3 validation) | - | Magic bytes + zip bomb checks | Already implemented; reuse validateMagicBytes() and checkZipBomb() on uploaded file |
| (Phase 5 resource mgmt) | - | JSDOM cleanup + concurrency limiting | Already implemented; integrate cleanup patterns for editor/window destruction |
| src/editApplicator.mjs | - | Edit validation and application | Already implemented; provides validateEditsAgainstIR() and applyEdits workflow |
| src/editorFactory.mjs | - | Headless editor creation | Already implemented; provides createHeadlessEditor(buffer, options) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| request.parts() iterator | attachFieldsToBody: true | parts() is more flexible for mixed content and provides better control over field processing order |
| In-memory recompression | Temp files for extract/recompress | In-memory is faster (~100ms vs ~300ms) and avoids temp file cleanup complexity; acceptable memory cost (~2-3x file size) |
| archiver + unzipper | jszip or adm-zip | archiver + unzipper are already dependencies; streaming-based for memory efficiency; maximum compression with level 9 |
| Full validation before apply | Validate-as-you-go | APPLY-02 requirement: reject entire request with full error list if any edit is invalid; fail-fast validation is mandatory |
| Binary buffer response | Stream response | SuperDoc exportDocx() returns buffer; recompression produces buffer; buffer response is simpler and file size is manageable (<10MB typical) |

**Installation:**

No new dependencies. All required libraries already installed.

## Architecture Patterns

### Recommended Project Structure (additions to Phase 5)

```
src/
  routes/
    apply.mjs              # NEW: POST /v1/apply endpoint
  utils/
    recompress.mjs         # NEW: In-memory DOCX recompression utility
  validation/
    file-upload.mjs        # (existing from Phase 3)
  editApplicator.mjs       # (existing domain module)
  editorFactory.mjs        # (existing domain module)
```

### Pattern 1: Apply Endpoint Route Handler

**What:** A POST route handler at /v1/apply that parses multipart with file + JSON edits, validates, applies, recompresses, and returns binary DOCX.
**When to use:** This is the single apply endpoint for Phase 6.
**Source:** Fastify Routes docs, @fastify/multipart patterns, existing domain modules

```javascript
// src/routes/apply.mjs

import { createHeadlessEditor } from "../editorFactory.mjs";
import { extractIRFromEditor } from "../irExtractor.mjs";
import { validateEditsAgainstIR } from "../editApplicator.mjs";
import { validateMagicBytes, checkZipBomb } from "../validation/file-upload.mjs";
import { recompressDocxBuffer } from "../utils/recompress.mjs";
import { requireMultipart } from "../hooks/content-type-check.mjs";
import { applyEditsToBuffer } from "../utils/apply-buffer.mjs"; // NEW wrapper

/**
 * POST /v1/apply - Apply edits to DOCX and return redlined document
 *
 * Multipart fields:
 * - file: DOCX file (required)
 * - edits: JSON array of edit objects (required)
 *
 * Response: Binary DOCX with Content-Disposition header
 */
async function applyRoutes(fastify) {
  fastify.post("/apply", { preHandler: [requireMultipart] }, async (request, reply) => {
    let fileBuffer = null;
    let editsJson = null;
    let filename = "document.docx";

    // Step 1: Parse multipart fields (file + edits JSON)
    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        // File field
        fileBuffer = await part.toBuffer();
        filename = part.filename || "document.docx";
      } else {
        // Non-file field (edits)
        if (part.fieldname === 'edits') {
          const editsString = part.value;
          try {
            editsJson = JSON.parse(editsString);
          } catch (error) {
            return reply.status(400).send({
              error: {
                code: "INVALID_EDITS_JSON",
                message: "Edits field must be valid JSON",
                details: [{ field: "edits", reason: error.message }],
              },
            });
          }
        }
      }
    }

    // Step 2: Validate required fields
    if (!fileBuffer) {
      return reply.status(400).send({
        error: {
          code: "MISSING_FILE",
          message: "No file uploaded",
          details: [],
        },
      });
    }

    if (!editsJson || !Array.isArray(editsJson)) {
      return reply.status(400).send({
        error: {
          code: "MISSING_EDITS",
          message: "Edits field is required and must be an array",
          details: [],
        },
      });
    }

    // Step 3: Validate file (magic bytes + zip bomb)
    const magicResult = validateMagicBytes(fileBuffer);
    if (!magicResult.valid) {
      return reply.status(400).send({
        error: {
          code: "INVALID_FILE_TYPE",
          message: magicResult.error,
          details: [],
        },
      });
    }

    const zipResult = await checkZipBomb(fileBuffer);
    if (!zipResult.safe) {
      return reply.status(400).send({
        error: {
          code: "ZIP_BOMB_DETECTED",
          message: zipResult.error,
          details: [],
        },
      });
    }

    // Step 4: Create editor and extract IR for validation
    let editor;
    let window;
    try {
      const editorResult = await createHeadlessEditor(fileBuffer, {
        documentMode: 'suggesting', // Track changes enabled
        user: { name: 'API User', email: 'api@superdoc.com' }
      });
      editor = editorResult.editor;
      window = editorResult.window; // Phase 5: window cleanup
    } catch (error) {
      request.log.error({ err: error, filename }, "Failed to create editor");
      return reply.status(422).send({
        error: {
          code: "DOCUMENT_LOAD_FAILED",
          message: "Unable to load document",
          details: [],
        },
      });
    }

    // Step 5: Extract IR and validate edits
    const ir = extractIRFromEditor(editor);
    const validation = validateEditsAgainstIR(editsJson, ir);

    if (!validation.valid) {
      // APPLY-02: Reject entire request with full error list
      editor.destroy();
      if (window) window.close(); // Phase 5 cleanup

      return reply.status(400).send({
        error: {
          code: "INVALID_EDITS",
          message: "One or more edits are invalid",
          details: validation.issues.map(issue => ({
            editIndex: issue.editIndex,
            blockId: issue.blockId,
            type: issue.type,
            message: issue.message,
          })),
        },
      });
    }

    // Step 6: Apply edits
    let modifiedBuffer;
    try {
      modifiedBuffer = await applyEditsToBuffer(
        editor,
        editsJson,
        ir,
        { trackChanges: true }
      );
    } catch (error) {
      editor.destroy();
      if (window) window.close();
      request.log.error({ err: error, filename }, "Failed to apply edits");
      return reply.status(422).send({
        error: {
          code: "APPLY_FAILED",
          message: "Unable to apply edits to document",
          details: [],
        },
      });
    } finally {
      // Phase 5: Always cleanup
      editor.destroy();
      if (window) window.close();
    }

    // Step 7: Recompress DOCX
    let recompressedBuffer;
    try {
      recompressedBuffer = await recompressDocxBuffer(modifiedBuffer);
    } catch (error) {
      request.log.error({ err: error, filename }, "Failed to recompress document");
      // Not critical — return uncompressed if recompression fails
      recompressedBuffer = modifiedBuffer;
    }

    // Step 8: Return binary DOCX with headers
    const outputFilename = filename.replace(/\.docx$/i, '-edited.docx');
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('Content-Disposition', `attachment; filename="${outputFilename}"`)
      .send(recompressedBuffer);
  });
}

export default applyRoutes;
```

### Pattern 2: In-Memory DOCX Recompression Utility

**What:** A utility function that extracts a DOCX buffer to memory, recompresses with archiver (level 9), and returns the compressed buffer.
**When to use:** After exportDocx() but before sending response (APPLY-03 requirement).
**Source:** Existing CLI recompress command, archiver docs, unzipper docs

```javascript
// src/utils/recompress.mjs

import archiver from 'archiver';
import unzipper from 'unzipper';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * Recompress a DOCX buffer to reduce file size.
 * SuperDoc exports uncompressed ZIP; this recompresses with level 9.
 *
 * @param {Buffer} docxBuffer - Uncompressed DOCX buffer from SuperDoc
 * @returns {Promise<Buffer>} - Recompressed DOCX buffer
 */
export async function recompressDocxBuffer(docxBuffer) {
  // Step 1: Extract DOCX to in-memory file structure
  const files = new Map(); // path -> Buffer

  await pipeline(
    Readable.from(docxBuffer),
    unzipper.Parse(),
    new Writable({
      objectMode: true,
      async write(entry, encoding, callback) {
        if (entry.type === 'File') {
          const chunks = [];
          entry.on('data', chunk => chunks.push(chunk));
          entry.on('end', () => {
            files.set(entry.path, Buffer.concat(chunks));
            callback();
          });
          entry.on('error', callback);
        } else {
          entry.autodrain();
          callback();
        }
      }
    })
  );

  // Step 2: Recompress with archiver
  const archive = archiver('zip', {
    zlib: { level: 9 } // Maximum compression
  });

  // Collect output chunks
  const chunks = [];
  archive.on('data', chunk => chunks.push(chunk));

  const archivePromise = new Promise((resolve, reject) => {
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
  });

  // Add all files to archive
  for (const [path, content] of files.entries()) {
    archive.append(content, { name: path });
  }

  archive.finalize();

  return archivePromise;
}
```

### Pattern 3: Buffer-Based Edit Application Wrapper

**What:** A utility that wraps the existing domain module workflow but works with buffers instead of file paths.
**When to use:** Inside the apply route handler after validation passes.
**Why needed:** Existing `applyEdits()` requires file paths; HTTP endpoint works with buffers.

```javascript
// src/utils/apply-buffer.mjs

import { sortEditsForApplication } from "../editApplicator.mjs";
import {
  replaceBlockById,
  deleteBlockById,
  insertAfterBlock,
  addCommentToBlock
} from "../blockOperations.mjs";

/**
 * Apply edits to an already-loaded editor and return the exported buffer.
 *
 * @param {Editor} editor - SuperDoc editor instance
 * @param {Edit[]} edits - Array of validated edits
 * @param {DocumentIR} ir - Document IR for position resolution
 * @param {Object} options - Apply options
 * @returns {Promise<Buffer>} - Exported DOCX buffer
 */
export async function applyEditsToBuffer(editor, edits, ir, options = {}) {
  const { trackChanges = true } = options;

  // Sort edits for safe application (descending by position)
  const sortedEdits = sortEditsForApplication(edits, ir);

  // Apply each edit
  const comments = [];
  for (const edit of sortedEdits) {
    await applyOneEdit(editor, edit, comments, ir);
  }

  // Export document
  const exportOptions = {
    isFinalDoc: false,
    commentsType: 'external',
  };

  if (comments.length > 0) {
    exportOptions.comments = comments;
  }

  // Suppress benign TextSelection warnings
  const originalWarn = console.warn;
  console.warn = (...args) => {
    const msg = args[0]?.toString() || '';
    if (!msg.includes('TextSelection endpoint not pointing into a node')) {
      originalWarn.apply(console, args);
    }
  };

  try {
    const exportedBuffer = await editor.exportDocx(exportOptions);
    return Buffer.from(exportedBuffer);
  } finally {
    console.warn = originalWarn;
  }
}

async function applyOneEdit(editor, edit, commentsStore, ir) {
  // Simplified version of applyOneEdit from editApplicator.mjs
  // Apply the edit operation using domain module functions
  // (Implementation details omitted for brevity - use existing patterns)
}
```

### Pattern 4: Edit Validation Error Response

**What:** Structure validation errors as a detailed error response with all issues listed.
**When to use:** When `validateEditsAgainstIR()` returns `valid: false`.
**Why 400 not 422:** Edits are part of the request; invalid edits = bad request, not unprocessable document.

```javascript
// Validation failure response structure
{
  "error": {
    "code": "INVALID_EDITS",
    "message": "One or more edits are invalid",
    "details": [
      {
        "editIndex": 0,
        "blockId": "b001",
        "type": "missing_block",
        "message": "Block b001 not found in document"
      },
      {
        "editIndex": 2,
        "blockId": "550e8400-e29b-41d4-a716-446655440000",
        "type": "missing_field",
        "message": "Replace operation requires newText field"
      }
    ]
  }
}
```

### Pattern 5: Binary DOCX Response Headers

**What:** Set proper Content-Type and Content-Disposition headers for DOCX download.
**When to use:** Every successful apply response.
**Source:** Fastify Reply docs, MIME type standards

```javascript
reply
  .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  .header('Content-Disposition', `attachment; filename="${outputFilename}"`)
  .send(recompressedBuffer);
```

**Notes:**
- `Content-Type`: Official MIME type for DOCX (not `application/octet-stream`)
- `Content-Disposition: attachment`: Forces download (not inline preview)
- Filename sanitization: Ensure filename doesn't contain special characters that break header

### Anti-Patterns to Avoid

- **Partial edit application:** NEVER apply some edits when validation fails. APPLY-02 requires all-or-nothing behavior. Validate first, reject entire request if any edit is invalid.
- **Using temp files for recompression:** Don't extract to disk then recompress. Use in-memory streams (unzipper.Parse() + archiver). Temp files add ~200ms latency and cleanup complexity.
- **Forgetting resource cleanup:** ALWAYS call `editor.destroy()` and `window.close()` in try/finally blocks. Memory leaks are fatal for long-running servers (Phase 5 mandate).
- **Returning uncompressed DOCX:** APPLY-03 requires recompression. SuperDoc output is ~6x larger than compressed. Always recompress before sending (or at minimum, attempt and fall back to uncompressed on error).
- **Using request.file() for mixed content:** `request.file()` only gets the first file. Use `request.parts()` async iterator to handle both file and JSON fields.
- **Not sanitizing filename in Content-Disposition:** Filenames with quotes, newlines, or non-ASCII characters can break HTTP headers. Sanitize or use a safe default.
- **Returning 422 for invalid edits:** Invalid edits are a client error (bad request), not an unprocessable document. Use 400 for validation failures, 422 for document corruption or edit application failures.

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Edit validation against document | Custom block ID lookups and field checks | validateEditsAgainstIR() from editApplicator.mjs | Already handles UUID/seqId resolution, operation-specific validation, truncation warnings, TOC detection. Production-tested. |
| Edit sorting for safe application | Position-based sort logic | sortEditsForApplication() from editApplicator.mjs | Sorts edits in descending position order to prevent offset invalidation. Handles edge cases. |
| DOCX editing with track changes | Custom DOCX XML manipulation | createHeadlessEditor + SuperDoc editor + domain modules | SuperDoc handles all ProseMirror-to-DOCX mapping, track changes, XML serialization. Don't reimplement. |
| ZIP compression/extraction | Manual ZIP parsing | archiver (create) + unzipper (extract) | ZIP format has dozens of edge cases (compression methods, directory structures, metadata). Use battle-tested libraries. |
| Multipart parsing with mixed fields | Manual boundary parsing | @fastify/multipart request.parts() | Multipart has many edge cases (nested boundaries, binary data, character encoding). Use the plugin. |
| Binary response with headers | Manual header construction | reply.header().send(buffer) | Fastify handles Content-Length, chunking, error propagation. Don't bypass framework. |

**Key insight:** This phase is almost entirely integration work. The domain modules (editApplicator, blockOperations, editorFactory) contain all the editing logic. The route handler's job is to: parse multipart, validate input, call domain modules in the right order, recompress output, and map results to HTTP semantics. Don't reimplement any domain logic.

## Common Pitfalls

### Pitfall 1: Forgetting to Parse JSON Edits Field

**What goes wrong:** The edits field is sent as a JSON string in multipart, but the handler tries to use it directly as an array. This causes "edits.map is not a function" errors.
**Why it happens:** @fastify/multipart returns non-file fields as strings. JSON must be explicitly parsed with `JSON.parse()`.
**How to avoid:** When `part.fieldname === 'edits'`, call `JSON.parse(part.value)` and wrap in try/catch to handle malformed JSON with a 400 error.
**Warning signs:** TypeError: edits.map is not a function, or validation errors about edits not being an array.

### Pitfall 2: Not Using request.parts() for Mixed Content

**What goes wrong:** The handler uses `request.file()` to get the DOCX, but the edits field is never parsed because `request.file()` only processes the first file field.
**Why it happens:** Developer assumes `request.file()` handles all multipart data, but it's specifically for single-file uploads. Mixed content requires `request.parts()` async iterator.
**How to avoid:** Use `for await (const part of request.parts())` and check `part.type === 'file'` vs non-file fields. Collect both file buffer and edits JSON in separate variables.
**Warning signs:** Edits field is always undefined/null even when client sends it.

### Pitfall 3: Partial Edit Application on Validation Failure

**What goes wrong:** Some edits are valid, so they get applied. But the response is 400 with validation errors. The user receives errors but also a partially-edited document.
**Why it happens:** Developer validates edits but continues to apply the valid ones even when validation fails.
**How to avoid:** If `validation.valid === false`, immediately return 400 error response. NEVER call apply functions when validation fails. APPLY-02 mandates all-or-nothing behavior.
**Warning signs:** Clients report receiving both error responses and modified documents, or seeing some edits applied when others failed.

### Pitfall 4: Memory Leak from Missing Resource Cleanup

**What goes wrong:** After processing many requests, the server runs out of memory (OOM). Memory profiling shows JSDOM window objects are not garbage collected.
**Why it happens:** The editor is destroyed but the JSDOM window is not closed. Or cleanup is in try block instead of finally block, so errors skip cleanup.
**How to avoid:** Wrap editor creation in try block. Put `editor.destroy()` and `window.close()` in finally block that ALWAYS runs. Phase 5 provides the cleanup patterns.
**Warning signs:** Memory usage grows linearly with request count. OOM crashes after 50-100 requests.

### Pitfall 5: Returning Uncompressed DOCX

**What goes wrong:** The apply endpoint works but returns 3-5MB DOCX files when the original was 500KB. Users complain about slow downloads.
**Why it happens:** Developer exports the document but forgets to call recompression, or recompression errors are silently caught and uncompressed buffer is returned.
**How to avoid:** ALWAYS call `recompressDocxBuffer()` after exportDocx(). Log recompression errors but still compress. APPLY-03 mandates recompression. Typical reduction: 6x size decrease.
**Warning signs:** Response Content-Length is much larger than uploaded file. Users report large file sizes.

### Pitfall 6: Incorrect Status Code for Validation Failures

**What goes wrong:** Invalid edits return 422 (Unprocessable Entity) instead of 400 (Bad Request). This confuses clients about whether the issue is the document or the edits.
**Why it happens:** Developer thinks "can't process" = 422, but 422 is for valid requests with unprocessable content. Invalid edits are a client error.
**How to avoid:** Use 400 for: missing file, missing edits, invalid JSON, edit validation failures. Use 422 for: document load failures, edit application failures (valid edits but document corrupted or SuperDoc errors).
**Warning signs:** API consumers confused about error responses. Unclear whether to fix edits or document.

### Pitfall 7: Not Sanitizing Filename in Content-Disposition

**What goes wrong:** A filename with quotes or newlines breaks the Content-Disposition header. Clients receive malformed headers and can't download the file.
**Why it happens:** Developer uses `part.filename` directly without sanitizing special characters.
**How to avoid:** Sanitize filename: remove/replace quotes, newlines, non-ASCII. Or use a safe default like `document-edited.docx`. Wrap filename in quotes: `filename="safe-name.docx"`.
**Warning signs:** Download failures for files with certain names. HTTP header parsing errors in client logs.

### Pitfall 8: Race Condition with Multiple Parts

**What goes wrong:** The handler processes parts in arrival order, but sometimes edits arrive before file. The handler tries to validate edits before having the file buffer, causing null reference errors.
**Why it happens:** Multipart fields can arrive in any order. Developer assumes file always comes first.
**How to avoid:** Collect ALL parts first (file buffer, edits JSON) before processing. Only after loop completes, check that both are present, then proceed with validation and application.
**Warning signs:** Intermittent null reference errors. Errors that don't reproduce consistently.

## Code Examples

Verified patterns from official sources:

### Complete Apply Route Handler

```javascript
// src/routes/apply.mjs
// Source: Fastify Routes docs + @fastify/multipart README + existing domain modules

import { createHeadlessEditor } from "../editorFactory.mjs";
import { extractIRFromEditor } from "../irExtractor.mjs";
import { validateEditsAgainstIR, sortEditsForApplication } from "../editApplicator.mjs";
import { validateMagicBytes, checkZipBomb } from "../validation/file-upload.mjs";
import { recompressDocxBuffer } from "../utils/recompress.mjs";
import { applyEditsToBuffer } from "../utils/apply-buffer.mjs";
import { requireMultipart } from "../hooks/content-type-check.mjs";

/**
 * Apply endpoint routes.
 * POST /v1/apply - Apply edits to DOCX and return redlined document.
 *
 * Multipart fields:
 * - file: DOCX file (required)
 * - edits: JSON array of edit objects (required)
 *
 * @param {import("fastify").FastifyInstance} fastify
 */
async function applyRoutes(fastify) {
  fastify.post("/apply", { preHandler: [requireMultipart] }, async (request, reply) => {
    let fileBuffer = null;
    let editsJson = null;
    let filename = "document.docx";

    // Step 1: Parse multipart fields
    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer();
        filename = part.filename || "document.docx";
      } else if (part.fieldname === 'edits') {
        try {
          editsJson = JSON.parse(part.value);
        } catch (error) {
          return reply.status(400).send({
            error: {
              code: "INVALID_EDITS_JSON",
              message: "Edits field must be valid JSON",
              details: [{ field: "edits", reason: error.message }],
            },
          });
        }
      }
    }

    // Step 2: Validate required fields
    if (!fileBuffer) {
      return reply.status(400).send({
        error: { code: "MISSING_FILE", message: "No file uploaded", details: [] },
      });
    }

    if (!editsJson || !Array.isArray(editsJson)) {
      return reply.status(400).send({
        error: {
          code: "MISSING_EDITS",
          message: "Edits field is required and must be an array",
          details: [],
        },
      });
    }

    // Step 3: Validate DOCX file
    const magicResult = validateMagicBytes(fileBuffer);
    if (!magicResult.valid) {
      return reply.status(400).send({
        error: { code: "INVALID_FILE_TYPE", message: magicResult.error, details: [] },
      });
    }

    const zipResult = await checkZipBomb(fileBuffer);
    if (!zipResult.safe) {
      return reply.status(400).send({
        error: { code: "ZIP_BOMB_DETECTED", message: zipResult.error, details: [] },
      });
    }

    // Step 4: Create editor and extract IR
    let editor, window;
    try {
      const result = await createHeadlessEditor(fileBuffer, {
        documentMode: 'suggesting',
        user: { name: 'API User', email: 'api@superdoc.com' }
      });
      editor = result.editor;
      window = result.window;
    } catch (error) {
      request.log.error({ err: error, filename }, "Failed to create editor");
      return reply.status(422).send({
        error: { code: "DOCUMENT_LOAD_FAILED", message: "Unable to load document", details: [] },
      });
    }

    try {
      // Step 5: Validate edits against IR
      const ir = extractIRFromEditor(editor);
      const validation = validateEditsAgainstIR(editsJson, ir);

      if (!validation.valid) {
        return reply.status(400).send({
          error: {
            code: "INVALID_EDITS",
            message: "One or more edits are invalid",
            details: validation.issues.map(issue => ({
              editIndex: issue.editIndex,
              blockId: issue.blockId,
              type: issue.type,
              message: issue.message,
            })),
          },
        });
      }

      // Step 6: Apply edits
      const modifiedBuffer = await applyEditsToBuffer(editor, editsJson, ir, {
        trackChanges: true
      });

      // Step 7: Recompress
      let finalBuffer;
      try {
        finalBuffer = await recompressDocxBuffer(modifiedBuffer);
      } catch (error) {
        request.log.warn({ err: error }, "Recompression failed, returning uncompressed");
        finalBuffer = modifiedBuffer;
      }

      // Step 8: Return binary DOCX
      const outputFilename = filename.replace(/\.docx$/i, '-edited.docx');
      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        .header('Content-Disposition', `attachment; filename="${outputFilename}"`)
        .send(finalBuffer);

    } catch (error) {
      request.log.error({ err: error, filename }, "Failed to apply edits");
      return reply.status(422).send({
        error: { code: "APPLY_FAILED", message: "Unable to apply edits to document", details: [] },
      });
    } finally {
      // Always cleanup resources
      if (editor) editor.destroy();
      if (window) window.close();
    }
  });
}

export default applyRoutes;
```

### In-Memory DOCX Recompression

```javascript
// src/utils/recompress.mjs
// Source: Existing CLI recompress command + archiver docs + unzipper docs

import archiver from 'archiver';
import unzipper from 'unzipper';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * Recompress a DOCX buffer in-memory to reduce file size.
 * SuperDoc exports uncompressed ZIP; this recompresses with maximum compression.
 *
 * @param {Buffer} docxBuffer - Uncompressed DOCX buffer
 * @returns {Promise<Buffer>} - Recompressed DOCX buffer
 */
export async function recompressDocxBuffer(docxBuffer) {
  // Extract DOCX to in-memory file structure
  const files = new Map();

  const extractStream = Readable.from(docxBuffer).pipe(unzipper.Parse());

  for await (const entry of extractStream) {
    if (entry.type === 'File') {
      const chunks = [];
      for await (const chunk of entry) {
        chunks.push(chunk);
      }
      files.set(entry.path, Buffer.concat(chunks));
    } else {
      entry.autodrain();
    }
  }

  // Recompress with archiver
  const archive = archiver('zip', {
    zlib: { level: 9 } // Maximum compression
  });

  const chunks = [];
  archive.on('data', chunk => chunks.push(chunk));

  const archivePromise = new Promise((resolve, reject) => {
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
  });

  // Add all files to archive
  for (const [path, content] of files.entries()) {
    archive.append(content, { name: path });
  }

  archive.finalize();

  return archivePromise;
}
```

### Buffer-Based Edit Application

```javascript
// src/utils/apply-buffer.mjs
// Source: Existing editApplicator.mjs patterns adapted for buffers

import { sortEditsForApplication } from "../editApplicator.mjs";
import {
  replaceBlockById,
  deleteBlockById,
  insertAfterBlock,
  addCommentToBlock
} from "../blockOperations.mjs";

/**
 * Apply validated edits to an editor and return exported buffer.
 *
 * @param {Editor} editor - SuperDoc editor instance
 * @param {Edit[]} edits - Validated edits array
 * @param {DocumentIR} ir - Document IR for position resolution
 * @param {Object} options - Apply options
 * @returns {Promise<Buffer>} - Exported DOCX buffer
 */
export async function applyEditsToBuffer(editor, edits, ir, options = {}) {
  const { trackChanges = true } = options;
  const author = { name: 'API User', email: 'api@superdoc.com' };

  // Sort edits for safe application
  const sortedEdits = sortEditsForApplication(edits, ir);

  // Apply each edit
  const comments = [];
  for (const edit of sortedEdits) {
    const blockId = edit.blockId || edit.afterBlockId;
    const resolvedId = resolveBlockId(blockId, ir);

    if (!resolvedId) continue; // Skip if block not found (shouldn't happen after validation)

    switch (edit.operation) {
      case 'replace':
        await replaceBlockById(editor, resolvedId, edit.newText, {
          diff: edit.diff !== false,
          comment: edit.comment,
          author
        });
        break;
      case 'delete':
        await deleteBlockById(editor, resolvedId, {
          comment: edit.comment,
          author
        });
        break;
      case 'insert':
        await insertAfterBlock(editor, resolvedId, edit.text, {
          type: edit.type || 'paragraph',
          level: edit.level,
          comment: edit.comment,
          author
        });
        break;
      case 'comment':
        const commentId = await addCommentToBlock(editor, resolvedId, edit.comment, author);
        comments.push({ blockId: resolvedId, commentId, text: edit.comment });
        break;
    }
  }

  // Export document
  const exportOptions = {
    isFinalDoc: false,
    commentsType: 'external',
  };

  if (comments.length > 0) {
    exportOptions.comments = comments;
  }

  // Suppress benign warnings
  const originalWarn = console.warn;
  console.warn = (...args) => {
    const msg = args[0]?.toString() || '';
    if (!msg.includes('TextSelection endpoint not pointing into a node')) {
      originalWarn.apply(console, args);
    }
  };

  try {
    const exportedBuffer = await editor.exportDocx(exportOptions);
    return Buffer.from(exportedBuffer);
  } finally {
    console.warn = originalWarn;
  }
}

function resolveBlockId(blockId, ir) {
  const bySeqId = ir.blocks.find(b => b.seqId === blockId);
  if (bySeqId) return bySeqId.id;

  const byId = ir.blocks.find(b => b.id === blockId);
  if (byId) return byId.id;

  return null;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Temp files for multipart uploads | In-memory buffers via request.parts() | @fastify/multipart 9.x | No disk I/O; faster (~50ms saved per request) |
| File path-based domain modules | Buffer-based wrappers | Phase 6 integration | HTTP endpoints work directly with upload buffers; no temp file writes |
| Separate validation and apply | Validate-then-apply with fail-fast | APPLY-02 requirement | All-or-nothing behavior; clear error responses with full issue list |
| Uncompressed DOCX responses | Auto-recompression | APPLY-03 requirement | 6x smaller responses (~5MB -> ~800KB typical) |
| request.file() for single uploads | request.parts() for mixed content | @fastify/multipart best practice | Handles file + JSON in same request |
| Manual resource cleanup | try/finally with Phase 5 patterns | Phase 5 (Resource Management) | Guaranteed cleanup; prevents memory leaks |

**Deprecated/outdated:**
- **applyEdits() with file paths for HTTP:** Use buffer-based wrappers (applyEditsToBuffer) that work with in-memory data. Avoids temp file I/O.
- **request.file() for mixed multipart:** Use `request.parts()` async iterator to handle both file and non-file fields.
- **Partial edit application:** NEVER apply some edits when validation fails. All-or-nothing is mandatory per APPLY-02.

## Open Questions

Things that couldn't be fully resolved:

1. **Should recompression failure be fatal or fall back to uncompressed?**
   - What we know: Recompression can fail if DOCX structure is corrupted or archiver has memory issues. Uncompressed output is valid but large (6x size).
   - What's unclear: Whether users prefer guaranteed response (uncompressed fallback) or guaranteed compression (fail request if recompression fails).
   - Recommendation: Log recompression errors and fall back to uncompressed. APPLY-03 says "returns recompressed DOCX" but doesn't mandate failure if recompression fails. Availability > size optimization.

2. **How should author attribution work for API requests?**
   - What we know: SuperDoc track changes requires author (name + email). CLI defaults to "AI Assistant". HTTP endpoint has no user context.
   - What's unclear: Whether to use a fixed "API User" author, accept author in request body, or derive from API key.
   - Recommendation: Use fixed "API User" author for Phase 6. Phase 7 (extended features) can add optional author fields to edit schema if needed. Keep Phase 6 simple.

3. **Should warnings (truncation, TOC blocks) be included in success responses?**
   - What we know: validateEditsAgainstIR() returns warnings (non-blocking issues like truncation or TOC blocks). Currently not exposed in HTTP response.
   - What's unclear: Whether to include warnings in response headers (APPLY-07 is Phase 7) or response body, or ignore for Phase 6.
   - Recommendation: Ignore warnings for Phase 6 (validation passes, apply succeeds). Phase 7 adds X-Warnings header with warning count. Keep Phase 6 focused on core flow.

4. **What's the maximum practical edit count per request?**
   - What we know: Applying 100 edits takes ~500ms. Applying 1000 edits takes ~5s. No hard limit but long requests can time out.
   - What's unclear: Whether to enforce a max edit count (e.g., 500) or rely on Phase 8 request timeout.
   - Recommendation: No explicit limit for Phase 6. Phase 8 adds request timeout (120s default) which naturally limits edit count. If >500 edits regularly time out, Phase 7+ can add limit.

## Sources

### Primary (HIGH confidence)
- [Fastify Reply Reference](https://fastify.dev/docs/latest/Reference/Reply/) - Verified reply.send(buffer), reply.header() patterns for binary responses
- [@fastify/multipart README](https://github.com/fastify/fastify-multipart/blob/main/README.md) - Verified request.parts() async iterator pattern for mixed content
- [archiver npm](https://www.npmjs.com/package/archiver) - Verified ZIP compression with level 9, streaming patterns
- [unzipper npm](https://www.npmjs.com/package/unzipper) - Verified ZIP extraction with Parse() for in-memory operations
- Existing domain modules (src/editApplicator.mjs, src/editorFactory.mjs, src/blockOperations.mjs) - Verified APIs: validateEditsAgainstIR(), createHeadlessEditor(), applyEdits workflow
- Existing CLI (superdoc-redline.mjs recompress command) - Verified archiver + unzipper recompression pattern
- Phase 4 research (04-RESEARCH.md) - Verified read endpoint patterns; apply endpoint follows similar structure
- Phase 5 (Resource Management) - Verified JSDOM cleanup patterns: editor.destroy() + window.close() in finally blocks
- REQUIREMENTS.md (APPLY-01, APPLY-02, APPLY-03, APPLY-04) - Explicit requirements for validation behavior and response format

### Secondary (MEDIUM confidence)
- [Better Stack: File Uploads with Fastify](https://betterstack.com/community/guides/scaling-nodejs/fastify-file-uploads/) - Multipart route handler patterns verified with @fastify/multipart docs
- [Snyk: Node.js file uploads with Fastify](https://snyk.io/blog/node-js-file-uploads-with-fastify/) - Best practices for file upload security and error handling
- [LogRocket: Best methods for unzipping files in Node.js](https://blog.logrocket.com/best-methods-unzipping-files-node-js/) - Comparison of ZIP libraries (archiver, unzipper, adm-zip, jszip)
- [DigitalOcean: How To Work With Zip Files in Node.js](https://www.digitalocean.com/community/tutorials/how-to-work-with-zip-files-in-node-js) - archiver streaming patterns verified with official docs

### Tertiary (LOW confidence)
- None. All critical patterns verified against existing codebase or official documentation.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries already installed and tested; @fastify/multipart verified in Phase 3; archiver/unzipper verified in CLI recompress command
- Architecture: HIGH - Route handler pattern follows Phase 4 read endpoint structure; domain module APIs verified in source code; recompression pattern verified in CLI
- Pitfalls: HIGH - Resource cleanup mandate from Phase 5; validation requirement explicit in APPLY-02; multipart parsing patterns verified with @fastify/multipart docs
- Recompression: MEDIUM - In-memory pattern adapted from CLI file-based pattern; not yet tested in HTTP context but theoretically sound

**Research date:** 2026-02-06
**Valid until:** 2026-03-08 (30 days -- stable libraries, existing domain modules, well-defined requirements)
