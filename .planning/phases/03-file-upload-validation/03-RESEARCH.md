# Phase 3: File Upload Validation - Research

**Researched:** 2026-02-06
**Domain:** File upload handling, binary validation, zip bomb detection (Fastify 5 + multipart)
**Confidence:** HIGH

## Summary

Phase 3 adds three layers of file upload protection: size limiting (50MB default), DOCX magic byte validation (PK\x03\x04 ZIP header), and zip bomb detection (decompressed-to-compressed ratio check). All three must reject before any document processing begins.

The standard approach is to use `@fastify/multipart` 9.4.0 (Fastify 5 compatible since v9.0.1) for multipart handling with its built-in `limits.fileSize` enforcement that automatically throws `RequestFileTooLargeError` with HTTP 413. Magic byte validation is a simple 4-byte check on the uploaded buffer -- no library needed. Zip bomb detection uses the already-installed `unzipper` 0.12.3's `Open.buffer()` to read the ZIP central directory and sum `uncompressedSize` fields without decompressing, rejecting when the ratio exceeds a configurable threshold (default 100:1).

The project already has `unzipper@0.12.3` installed (used by the CLI's recompress command), so the only new dependency is `@fastify/multipart@9.4.0`. The validation pipeline is: (1) multipart parsing with size limit, (2) magic byte check on buffer, (3) central directory ratio check. All three are pre-processing guards that run before any SuperDoc/JSDOM work.

**Primary recommendation:** Use `@fastify/multipart` with `attachFieldsToBody: false` and `req.file()` in route handlers. Chain three validation steps on the uploaded buffer: size (handled by multipart plugin), magic bytes (4-byte inline check), and zip bomb ratio (unzipper central directory scan). Wrap all three in a reusable validation module.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @fastify/multipart | 9.4.0 | Multipart form-data parsing, file upload handling | Official Fastify plugin; Fastify 5 compatible since v9.0.1; built-in fileSize limit enforcement with 413 errors; uses @fastify/busboy |
| unzipper | 0.12.3 | ZIP central directory reading for zip bomb detection | Already installed in project; `Open.buffer()` reads central directory metadata (compressedSize, uncompressedSize) without decompressing; used by CLI recompress |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none needed) | - | - | Magic byte check is 4 bytes -- inline code, no library |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Inline 4-byte magic check | `file-type` npm package | file-type is 400+ file types with ESM-only import; massive overkill for checking 4 bytes. Use inline check. |
| `unzipper` Open.buffer() for zip bomb | `@ronomon/pure` | @ronomon/pure is a C native addon (66% C code), last published 5 years ago, risky on modern Node.js. unzipper is already installed and pure JS. |
| `unzipper` Open.buffer() for zip bomb | `yauzl` | yauzl provides validateEntrySizes but no built-in ratio check. Would be a new dependency for same manual ratio logic. |
| @fastify/multipart req.file() | @fastify/multipart attachFieldsToBody | attachFieldsToBody accumulates entire file in memory via body parser. req.file() gives more control over when buffering happens and keeps validation explicit. |

**Installation:**

```bash
npm install @fastify/multipart
```

No other new dependencies needed. `unzipper` is already in package.json.

## Architecture Patterns

### Recommended Project Structure

```
src/
  plugins/
    multipart.mjs           # @fastify/multipart registration with size limits
  validation/
    file-upload.mjs          # Validation pipeline: magic bytes + zip bomb check
  routes/
    health.mjs               # (existing)
```

### Pattern 1: Multipart Plugin Registration with Size Limits

**What:** Register `@fastify/multipart` globally with a 50MB fileSize limit (configurable via env var). The plugin automatically throws `RequestFileTooLargeError` (HTTP 413) when exceeded.
**When to use:** Register once at app startup, before route registration.

```javascript
// src/plugins/multipart.mjs
import fp from "fastify-plugin";
import multipart from "@fastify/multipart";

const DEFAULT_FILE_SIZE_LIMIT = 50 * 1024 * 1024; // 50MB

async function multipartPlugin(fastify, opts) {
  const fileSizeLimit = parseInt(
    process.env.MAX_FILE_SIZE || DEFAULT_FILE_SIZE_LIMIT,
    10
  );

  fastify.register(multipart, {
    limits: {
      fileSize: fileSizeLimit,
      files: 1,        // Only one file per request
      fields: 10,      // Reasonable field limit
    },
    // throwFileSizeLimit defaults to true -- automatically throws
    // RequestFileTooLargeError (413) when fileSize exceeded
  });
}

export default fp(multipartPlugin, { name: "multipart" });
```

### Pattern 2: Magic Byte Validation (Inline, No Library)

**What:** Check that the first 4 bytes of the uploaded buffer are `PK\x03\x04` (ZIP local file header signature). DOCX files are ZIP archives, so this is the correct magic number.
**When to use:** After receiving the file buffer, before any ZIP/DOCX processing.

```javascript
// src/validation/file-upload.mjs

const ZIP_MAGIC = Buffer.from([0x50, 0x4B, 0x03, 0x04]); // PK\x03\x04

/**
 * Validate that a buffer starts with ZIP magic bytes (PK\x03\x04).
 * DOCX files are ZIP archives, so they MUST start with this signature.
 *
 * @param {Buffer} buffer - The uploaded file buffer
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateMagicBytes(buffer) {
  if (buffer.length < 4) {
    return { valid: false, error: "File too small to be a valid DOCX" };
  }
  if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    return {
      valid: false,
      error: "Invalid file format: not a ZIP/DOCX file (bad magic bytes)",
    };
  }
  return { valid: true };
}
```

### Pattern 3: Zip Bomb Detection via Central Directory Scan

**What:** Use `unzipper`'s `Open.buffer()` to read the ZIP central directory (metadata only, no decompression). Sum all `uncompressedSize` values and compare to the buffer's compressed size. Reject if the ratio exceeds a configurable threshold.
**When to use:** After magic byte validation passes, before passing the file to SuperDoc/JSDOM.

```javascript
// src/validation/file-upload.mjs (continued)
import { Open } from "unzipper";

const DEFAULT_MAX_RATIO = 100; // 100:1 decompressed:compressed
const DEFAULT_MAX_DECOMPRESSED = 500 * 1024 * 1024; // 500MB absolute max

/**
 * Check for zip bomb by reading central directory metadata.
 * Does NOT decompress any data -- reads only entry headers.
 *
 * @param {Buffer} buffer - The uploaded file buffer (already validated as ZIP)
 * @param {object} [opts] - Options
 * @param {number} [opts.maxRatio=100] - Max allowed decompressed:compressed ratio
 * @param {number} [opts.maxDecompressedSize] - Absolute max decompressed size in bytes
 * @returns {Promise<{ safe: boolean, error?: string, ratio?: number, totalUncompressed?: number }>}
 */
export async function checkZipBomb(buffer, opts = {}) {
  const maxRatio = opts.maxRatio || DEFAULT_MAX_RATIO;
  const maxDecompressed = opts.maxDecompressedSize || DEFAULT_MAX_DECOMPRESSED;

  const directory = await Open.buffer(buffer);
  let totalUncompressed = 0;

  for (const file of directory.files) {
    totalUncompressed += file.uncompressedSize || 0;
  }

  const ratio = buffer.length > 0 ? totalUncompressed / buffer.length : 0;

  if (totalUncompressed > maxDecompressed) {
    return {
      safe: false,
      error: `Decompressed size (${totalUncompressed} bytes) exceeds maximum allowed (${maxDecompressed} bytes)`,
      ratio,
      totalUncompressed,
    };
  }

  if (ratio > maxRatio) {
    return {
      safe: false,
      error: `Compression ratio ${ratio.toFixed(1)}:1 exceeds maximum allowed ${maxRatio}:1`,
      ratio,
      totalUncompressed,
    };
  }

  return { safe: true, ratio, totalUncompressed };
}
```

### Pattern 4: Route Handler with Validation Pipeline

**What:** Upload route handler that calls `req.file()`, buffers the file, then runs validation pipeline.
**When to use:** Every route that accepts file uploads.

```javascript
// Example route handler (Phase 4 will use this pattern)
async function uploadHandler(request, reply) {
  // Step 1: Get the multipart file (size limit enforced by plugin)
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

  // Step 3: Magic byte validation
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

  // Step 4: Zip bomb check
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

  // File is safe -- proceed with document processing
  // ...
}
```

### Pattern 5: Error Handler Integration for Multipart Errors

**What:** The existing error handler in `src/plugins/error-handler.mjs` already handles errors by status code. `@fastify/multipart` errors have `statusCode` set (413 for size limits, 406 for invalid content type). These will be caught automatically by the existing error handler and returned as structured JSON.
**When to use:** No changes needed to the error handler -- it already forwards `error.statusCode` and `error.message` for non-500 errors.

The existing error handler code:
```javascript
const statusCode = error.statusCode || 500;
reply.status(statusCode).send({
  error: {
    code: error.code || "INTERNAL_ERROR",
    message: statusCode >= 500
      ? "An internal server error occurred"
      : error.message,
    details: [],
  },
});
```

This will produce structured 413 responses for `RequestFileTooLargeError` because the error has `statusCode: 413` and `error.message: "request file too large"`. The error code will be `FST_FILES_LIMIT` or similar from the @fastify/error codes.

### Anti-Patterns to Avoid

- **Checking Content-Length header for size validation:** Content-Length can be spoofed or absent. The multipart plugin enforces size at the stream level, counting actual bytes. Never trust Content-Length alone.
- **Using `file-type` library for a 4-byte check:** The file-type package supports 400+ formats and is pure ESM with complex detection logic. Checking `PK\x03\x04` is 4 bytes. Use inline code.
- **Decompressing files to check for zip bombs:** The entire point is to detect bombs BEFORE decompression. Read the ZIP central directory metadata (uncompressedSize fields) without decompressing. unzipper's `Open.buffer()` does exactly this.
- **Using `attachFieldsToBody: true` for file uploads:** This accumulates the entire file in memory through the body parser path, bypassing explicit control over the validation pipeline. Use `req.file()` + `toBuffer()` for explicit flow.
- **Trusting file extensions:** A file named `.docx` might be a PNG or executable. Always validate magic bytes, never rely on the filename extension.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File size enforcement | Custom Content-Length checking or stream byte counting | @fastify/multipart `limits.fileSize` | Plugin handles stream-level counting, truncation detection, and throws 413 automatically. Edge cases around chunked transfer encoding, partial reads, and connection drops are handled. |
| Multipart form parsing | Custom multipart boundary parsing | @fastify/multipart (uses @fastify/busboy) | Multipart parsing has dozens of edge cases (boundary detection, quoted parameters, nested MIME parts, encoding). Busboy is battle-tested. |
| ZIP central directory reading | Custom binary parsing of ZIP format | `unzipper` Open.buffer() | ZIP format has ZIP64 extensions, variable-length fields, and encoding edge cases. unzipper handles all of this. |

**Key insight:** File upload validation looks simple but has many edge cases. The size check is stream-level (not header-level), magic byte check is binary (not string comparison), and zip bomb check requires understanding the ZIP central directory format. Use established libraries for parsing, but the validation logic itself (ratio check, magic byte comparison) is simple enough to be inline.

## Common Pitfalls

### Pitfall 1: multipart fileSize limit silently truncates instead of throwing

**What goes wrong:** The file is silently truncated to the limit size, and the route handler processes a partial file.
**Why it happens:** Older versions of @fastify/multipart (pre-v7) would set `file.truncated = true` but not throw. The `throwFileSizeLimit` option defaults to `true` in current versions, but if explicitly set to `false`, truncation is silent.
**How to avoid:** Do NOT set `throwFileSizeLimit: false`. Leave it at the default `true`. The plugin will throw `RequestFileTooLargeError` (413) automatically.
**Warning signs:** Corrupted/partial DOCX files being processed, no 413 errors in logs.

### Pitfall 2: Stream not consumed causes hanging request

**What goes wrong:** Route handler calls `req.file()` but never reads the file stream, causing the request to hang indefinitely.
**Why it happens:** @fastify/multipart note: "if the file stream is not consumed, the promise will never fulfill." The multipart parser waits for the stream to be drained.
**How to avoid:** Always call `await data.toBuffer()` or pipe the stream. If validation fails early (e.g., magic bytes on first 4 bytes), still consume/discard the rest of the stream.
**Warning signs:** Requests timing out, connection hangs.

### Pitfall 3: ZIP central directory reports wrong uncompressedSize (adversarial)

**What goes wrong:** An attacker crafts a ZIP file where the central directory lies about uncompressedSize (reports small size, actual decompressed data is huge).
**Why it happens:** The ZIP central directory metadata is not cryptographically signed. An attacker can edit the metadata to bypass ratio checks.
**How to avoid:** The ratio check on central directory metadata catches MOST zip bombs (including the classic ones and Fifield's improved zip bomb). For the adversarial case where metadata lies, the actual decompression in Phase 5 (resource management) should enforce a decompressed-byte-counting limit. The central directory check is a fast first pass, not the only defense.
**Warning signs:** High memory usage during DOCX processing despite passing zip bomb check.

### Pitfall 4: Fastify bodyLimit vs multipart fileSize conflict

**What goes wrong:** Fastify's global `bodyLimit` (default 1MB) rejects requests before @fastify/multipart can parse them.
**Why it happens:** @fastify/multipart registers its own content-type parser for `multipart/form-data`, but Fastify's bodyLimit may apply at the framework level first, especially for Content-Length checks.
**How to avoid:** When registering @fastify/multipart, the plugin handles its own content-type parsing and body limits independently. However, to be safe, set the Fastify `bodyLimit` at least as high as your `fileSize` limit, or configure it specifically for the multipart parser. Test with files near and above the limit.
**Warning signs:** Getting generic "request entity too large" errors instead of @fastify/multipart's `RequestFileTooLargeError`.

### Pitfall 5: unzipper Open.buffer() fails on invalid ZIP

**What goes wrong:** `Open.buffer()` throws an unhandled error when given a buffer that passes the 4-byte magic check but is not a valid ZIP file.
**Why it happens:** The magic bytes only verify the first 4 bytes. A file could have `PK\x03\x04` at the start but be corrupted or truncated.
**How to avoid:** Wrap the `Open.buffer()` call in try/catch. If it throws, return a validation error ("corrupted or invalid ZIP/DOCX file").
**Warning signs:** Unhandled promise rejections, 500 errors instead of 400 errors.

### Pitfall 6: Missing file field in multipart request

**What goes wrong:** Client sends a multipart request but the file field is missing or named differently than expected.
**Why it happens:** `req.file()` returns the first file part. If no file part exists, it returns undefined/null.
**How to avoid:** Check for null/undefined result from `req.file()` and return 400 with a clear error message.
**Warning signs:** TypeError: Cannot read properties of null.

## Code Examples

### Complete Multipart Plugin Registration

```javascript
// src/plugins/multipart.mjs
// Source: @fastify/multipart README + npm registry v9.4.0
import fp from "fastify-plugin";
import multipart from "@fastify/multipart";

const DEFAULT_FILE_SIZE_LIMIT = 50 * 1024 * 1024; // 50MB

async function multipartPlugin(fastify, opts) {
  const fileSizeLimit = parseInt(
    process.env.MAX_FILE_SIZE || String(DEFAULT_FILE_SIZE_LIMIT),
    10
  );

  await fastify.register(multipart, {
    limits: {
      fileSize: fileSizeLimit,
      files: 1,
      fields: 10,
      headerPairs: 100,
    },
    // throwFileSizeLimit: true is the default -- throws RequestFileTooLargeError (413)
  });
}

export default fp(multipartPlugin, { name: "multipart" });
```

### Complete Validation Module

```javascript
// src/validation/file-upload.mjs
import { Open } from "unzipper";

const ZIP_MAGIC = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
const DEFAULT_MAX_RATIO = 100;
const DEFAULT_MAX_DECOMPRESSED = 500 * 1024 * 1024; // 500MB

/**
 * Validate ZIP magic bytes (PK\x03\x04).
 */
export function validateMagicBytes(buffer) {
  if (buffer.length < 4) {
    return { valid: false, error: "File too small to be a valid DOCX" };
  }
  if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    return {
      valid: false,
      error: "Invalid file format: not a ZIP/DOCX file (bad magic bytes)",
    };
  }
  return { valid: true };
}

/**
 * Check for zip bomb via central directory metadata scan.
 * Does NOT decompress any data.
 */
export async function checkZipBomb(buffer, opts = {}) {
  const maxRatio = opts.maxRatio || DEFAULT_MAX_RATIO;
  const maxDecompressed = opts.maxDecompressedSize || DEFAULT_MAX_DECOMPRESSED;

  let directory;
  try {
    directory = await Open.buffer(buffer);
  } catch (err) {
    return {
      safe: false,
      error: "Corrupted or invalid ZIP/DOCX file",
    };
  }

  let totalUncompressed = 0;
  for (const file of directory.files) {
    totalUncompressed += file.uncompressedSize || 0;
  }

  const ratio = buffer.length > 0 ? totalUncompressed / buffer.length : 0;

  if (totalUncompressed > maxDecompressed) {
    return {
      safe: false,
      error: `Decompressed size exceeds maximum allowed`,
      ratio,
      totalUncompressed,
    };
  }

  if (ratio > maxRatio) {
    return {
      safe: false,
      error: `Suspicious compression ratio detected`,
      ratio,
      totalUncompressed,
    };
  }

  return { safe: true, ratio, totalUncompressed };
}
```

### Testing Multipart Uploads with fastify.inject()

```javascript
// Source: @fastify/multipart README, Fastify inject docs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import buildApp from "../src/app.mjs";

// Helper to build multipart body for fastify.inject()
function buildMultipartPayload(filename, content, fieldName = "file") {
  const boundary = "----FormBoundary" + Date.now();
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;

  // For binary content, need to concatenate Buffer properly
  const header = Buffer.from(body);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([header, content, footer]);

  return {
    payload,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("File upload validation", () => {
  it("rejects files exceeding size limit with 413", async () => {
    const app = buildApp({ logger: false });
    // Register a test upload route
    app.post("/test-upload", async (request) => {
      const file = await request.file();
      const buffer = await file.toBuffer();
      return { size: buffer.length };
    });

    const bigContent = Buffer.alloc(60 * 1024 * 1024); // 60MB > 50MB limit
    const { payload, contentType } = buildMultipartPayload(
      "big.docx",
      bigContent
    );

    const response = await app.inject({
      method: "POST",
      url: "/test-upload",
      payload,
      headers: { "content-type": contentType },
    });

    assert.strictEqual(response.statusCode, 413);
  });
});
```

### Creating Test Fixtures for Magic Byte Validation

```javascript
// Valid DOCX-like file (starts with PK header)
const validZipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const validDocxMinimal = Buffer.concat([
  validZipHeader,
  Buffer.alloc(100), // Padding to make it a plausible file
]);

// Invalid file (PNG header)
const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngRenamedToDocx = Buffer.concat([pngHeader, Buffer.alloc(100)]);

// Too small file
const tinyFile = Buffer.from([0x50, 0x4b]); // Only 2 bytes
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| @fastify/multipart v8.x (Fastify 4) | @fastify/multipart v9.x (Fastify 5) | v9.0.1 (Oct 2024) | Must use v9.x for Fastify 5 compatibility |
| `throwFileSizeLimit: false` + manual truncated check | `throwFileSizeLimit: true` (default) + automatic 413 | @fastify/multipart v7+ | No need to manually check file.truncated; plugin throws automatically |
| Native C addon for zip bomb detection (@ronomon/pure) | Pure JS central directory scan (unzipper) | N/A | Avoids native compilation issues; unzipper already in project |
| `busboy` (standalone) | `@fastify/busboy` (maintained fork) | 2023 | @fastify/multipart uses @fastify/busboy internally; original busboy is no longer maintained by its author |

**Deprecated/outdated:**
- `fastify-multipart` (without @fastify scope): Renamed to `@fastify/multipart`. Use the scoped package.
- `busboy`: The original busboy package had a disputed/hostile maintainer situation. @fastify/busboy is the actively maintained fork used by @fastify/multipart.

## Open Questions

1. **What HTTP status code for zip bomb detection?**
   - What we know: The success criteria says "detected and rejected before full decompression" but does not specify the HTTP status code.
   - What's unclear: Should it be 400 (bad request), 413 (payload too large), or 422 (unprocessable entity)?
   - Recommendation: Use 400 with error code `ZIP_BOMB_DETECTED`. The file is not "too large" (it passed the size check); it is malicious/malformed. 400 is more appropriate than 413 for this case.

2. **unzipper CJS vs ESM**
   - What we know: unzipper 0.12.3 is CJS (`require()`). The project uses ESM (`import`).
   - What's unclear: Whether `import { Open } from "unzipper"` works cleanly or needs `import unzipper from "unzipper"; const { Open } = unzipper;`.
   - Recommendation: Test the import pattern during implementation. Node.js ESM can import CJS modules via default import. Use `import unzipper from "unzipper"; const Open = unzipper.Open;` if named imports fail.

3. **Configurable ratio threshold**
   - What we know: We chose 100:1 as default max ratio. Normal DOCX files have ratios of 2:1 to 20:1 (text compresses moderately in ZIP).
   - What's unclear: Whether 100:1 is the right threshold. It should be high enough to not reject legitimate large DOCX files but low enough to catch bombs.
   - Recommendation: Make it configurable via environment variable (e.g., `ZIP_BOMB_RATIO=100`). Default 100:1 is safe -- DEFLATE compression cannot exceed ~1032:1 ratio, so legitimate files will always be well under 100:1.

4. **Interaction between Fastify bodyLimit and multipart fileSize**
   - What we know: @fastify/multipart registers a custom content type parser for multipart/form-data. Fastify's default bodyLimit is 1MB.
   - What's unclear: Whether Fastify's bodyLimit applies before the multipart parser kicks in, potentially rejecting 50MB files at the framework level.
   - Recommendation: Test this during implementation. If needed, set Fastify's bodyLimit to match or exceed the multipart fileSize limit. The multipart plugin may handle this internally.

## Sources

### Primary (HIGH confidence)
- @fastify/multipart README (https://github.com/fastify/fastify-multipart/blob/main/README.md) - Plugin API, limits configuration, error types, file access methods
- @fastify/multipart source (https://github.com/fastify/fastify-multipart/blob/main/index.js) - Error definitions verified: RequestFileTooLargeError (413), PartsLimitError (413), FilesLimitError (413), throwFileSizeLimit default true
- @fastify/multipart releases (https://github.com/fastify/fastify-multipart/releases) - v9.0.1 added Fastify 5 compat, v9.4.0 latest
- unzipper source (node_modules/unzipper/lib/Open/directory.js) - Central directory parsing verified: compressedSize and uncompressedSize fields at lines 196-197
- unzipper README (https://github.com/ZJONSSON/node-unzipper) - Open.buffer() API confirmed, central directory reading
- ZIP file format spec (https://en.wikipedia.org/wiki/ZIP_(file_format)) - Magic bytes PK\x03\x04 = 0x504B0304 confirmed

### Secondary (MEDIUM confidence)
- @fastify/multipart issue #196 (https://github.com/fastify/fastify-multipart/issues/196) - fileSize truncation behavior history, fixed in v7+
- @ronomon/pure (https://github.com/ronomon/pure) - Zip bomb detection approach (decided against due to native addon, 5yr stale)
- yauzl issue #13 (https://github.com/thejoshwolfe/yauzl/issues/13) - Zip bomb prevention heuristic discussion

### Tertiary (LOW confidence)
- Compression ratio upper bound (DEFLATE max ~1032:1) - from David Fifield's zip bomb research (https://www.bamsoftware.com/hacks/zipbomb/), not independently verified against spec

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - @fastify/multipart v9.4.0 verified via npm + GitHub releases; unzipper already in project
- Architecture: HIGH - Validation pipeline pattern (size -> magic bytes -> zip bomb) is straightforward and verified against library APIs
- Pitfalls: HIGH - Key pitfalls (stream not consumed, bodyLimit conflict, truncation behavior) verified via official docs and GitHub issues
- Zip bomb detection: MEDIUM - Central directory ratio check is a well-known heuristic but adversarial metadata is a known limitation. Sufficient as first-pass defense.

**Research date:** 2026-02-06
**Valid until:** 2026-03-08 (30 days -- @fastify/multipart is stable, unzipper is stable)
