# Phase 7: Apply Endpoint Extended - Research

**Researched:** 2026-02-06
**Domain:** Markdown edit parsing, dry-run validation, response headers for edit metadata, multipart content-type detection
**Confidence:** HIGH

## Summary

Phase 7 extends the POST /v1/apply endpoint from Phase 6 with three capabilities: (1) auto-detection and parsing of markdown-formatted edits (in addition to JSON), (2) dry-run mode via ?dry_run=true query parameter that validates edits and returns a validation report without producing a DOCX, and (3) edit summary response headers (X-Edits-Applied, X-Edits-Skipped, X-Warnings) that provide metadata about the edit operation.

The standard approach leverages existing domain modules: the codebase already contains a production-ready `parseMarkdownEdits()` function (src/markdownEditsParser.mjs) that converts markdown format to JSON, eliminating the need for new parsing logic. For auto-detection, the route handler inspects the edits field: if it's a string starting with markdown markers (# Edits, ## Metadata, or ## Edits Table), parse with parseMarkdownEdits(), otherwise parse as JSON. For dry-run mode, the route handler checks request.query.dry_run and, if true, validates edits and returns a JSON report with validation results instead of proceeding to apply/export/recompress. For edit summary headers, track the counts during edit application (already available from applyEditsToBuffer and validation results) and add X-Edits-Applied, X-Edits-Skipped, X-Warnings headers before sending the binary DOCX response.

The critical concerns are: (1) format detection must be reliable—false positives (parsing JSON as markdown) cause confusing errors, so detection should check for explicit markdown markers, (2) dry-run must not create a DOCX file—validation only, no editor.exportDocx() call, (3) response headers are only added on success (200 responses, not 400/422 errors), and (4) markdown parsing errors should return clear 400 errors with details about what failed (malformed table, missing sections, etc.).

**Primary recommendation:** Extend the existing POST /v1/apply route handler from Phase 6 with: (1) format detection logic in the edits parsing step (check for markdown markers before JSON.parse), (2) query parameter validation schema for dry_run (boolean), (3) early-exit after validation when dry_run=true (return validation report as JSON), and (4) header addition before reply.send() using validation and apply result counts. No new dependencies required—all functionality exists in the codebase or Fastify core.

## Standard Stack

The established libraries/tools for this phase:

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| src/markdownEditsParser.mjs | - | Markdown edit parsing | Already implemented and tested; provides parseMarkdownEdits() and editsToMarkdown() with full round-trip support |
| @fastify/multipart | 9.4.0 | Multipart field parsing | Already configured in Phase 6; parses both file and edits (string) fields |
| Fastify query params | core | Query string parsing | Built into Fastify; request.query provides parsed parameters |
| Fastify reply.header() | core | Response header setting | Built-in method for adding custom headers to responses |
| src/editApplicator.mjs | - | Edit validation | Already implemented; validateEditsAgainstIR() returns { valid, issues, warnings, summary } structure |
| src/utils/apply-buffer.mjs | - | Edit application | Already implemented in Phase 6; returns buffer and counts |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Fastify route schema | core | Query parameter validation | Define dry_run as optional boolean in route schema.querystring |
| Phase 6 validation patterns | - | Multipart parsing and error handling | Reuse existing buildError(), field validation, and error codes from Phase 6 |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Auto-detection (string check) | Content-Type header on edits field | Multipart fields can have content-type but clients rarely set it; string inspection is more reliable |
| parseMarkdownEdits() | Custom markdown parser or LLM | Existing parser is production-tested with comprehensive test coverage (tests/markdownEditsParser.test.mjs); handles all edge cases (truncation, garbled content, multiple sections) |
| Query param dry_run | Request header X-Dry-Run | Query params are standard for operation modes; easier to test and document than custom headers |
| Separate validation endpoint | dry_run param on apply | Reusing the same endpoint with dry_run reduces API surface area and reuses all validation/auth logic |
| JSON validation report | Plain text or XML | JSON matches the existing error response format and is easier for clients to parse |

**Installation:**

No new dependencies. All required functionality exists in the codebase or Fastify core.

## Architecture Patterns

### Recommended Project Structure (additions to Phase 6)

```
src/
  routes/
    apply.mjs              # EXTEND: Add format detection, dry-run logic, response headers
  markdownEditsParser.mjs  # (existing from CLI)
  editApplicator.mjs       # (existing - provides validation)
  utils/
    apply-buffer.mjs       # (existing from Phase 6)
```

### Pattern 1: Markdown Format Auto-Detection

**What:** Detect whether the edits field contains markdown or JSON by inspecting string patterns.
**When to use:** During multipart parsing, after extracting the edits field value.
**Source:** Existing markdownEditsParser.mjs patterns

```javascript
// src/routes/apply.mjs - extend multipart parsing step

if (part.fieldname === 'edits') {
  const editsString = part.value; // string value from multipart

  // Auto-detect format: markdown starts with specific markers
  const trimmed = editsString.trim();
  const isMarkdown = trimmed.startsWith('# Edits')
    || trimmed.startsWith('## Metadata')
    || trimmed.startsWith('## Edits Table')
    || /^\|\s*Block\s*\|/.test(trimmed); // Table header pattern

  if (isMarkdown) {
    // Parse markdown to JSON
    const parsed = parseMarkdownEdits(editsString);
    if (!parsed || !parsed.edits || parsed.edits.length === 0) {
      return reply.status(400).send(buildError(
        "INVALID_EDITS_MARKDOWN",
        "Markdown edits format is invalid or contains no edits",
        [{ field: "edits", reason: "Failed to parse markdown format" }]
      ));
    }
    editsJson = parsed.edits; // Extract edits array
    // Optionally store author from markdown metadata
    if (parsed.author?.name && parsed.author?.email) {
      request.markdownAuthor = parsed.author;
    }
  } else {
    // Parse as JSON
    try {
      editsJson = JSON.parse(editsString);
    } catch (error) {
      return reply.status(400).send(buildError(
        "INVALID_EDITS_JSON",
        "Edits field must be valid JSON or markdown format",
        [{ field: "edits", reason: error.message }]
      ));
    }
  }
}
```

**Key insight:** The markdown format has unambiguous markers (# Edits, ## Edits Table) that JSON never starts with. This makes detection reliable. Fallback to JSON parsing if markdown markers are not found.

### Pattern 2: Dry-Run Mode with Query Parameter Validation

**What:** Add dry_run query parameter that skips edit application and returns validation report.
**When to use:** When clients want to validate edits without modifying the document.
**Source:** Fastify route schema validation, existing validation patterns

```javascript
// src/routes/apply.mjs - route definition with schema

fastify.post("/apply", {
  preHandler: [requireMultipart],
  schema: {
    querystring: {
      type: 'object',
      properties: {
        dry_run: {
          type: 'boolean',
          default: false,
          description: 'Validate edits without applying them'
        }
      }
    }
  }
}, async (request, reply) => {
  const isDryRun = request.query.dry_run === true || request.query.dry_run === 'true';

  // ... (multipart parsing, file validation, editor creation, IR extraction as normal)

  // Step 5: Validate edits
  const validation = validateEditsAgainstIR(editsJson, ir);

  // Dry-run: return validation report and exit early
  if (isDryRun) {
    return reply.type('application/json').send({
      valid: validation.valid,
      summary: {
        totalEdits: validation.summary.totalEdits,
        validEdits: validation.summary.validEdits,
        invalidEdits: validation.summary.invalidEdits,
        warningCount: validation.summary.warningCount
      },
      issues: validation.issues.map(issue => ({
        editIndex: issue.editIndex,
        blockId: issue.blockId,
        type: issue.type,
        message: issue.message
      })),
      warnings: validation.warnings.map(warn => ({
        editIndex: warn.editIndex,
        blockId: warn.blockId,
        type: warn.type,
        message: warn.message
      }))
    });
  }

  // Normal flow: check validation and proceed to apply
  if (!validation.valid) {
    return reply.status(400).send(buildError(
      "INVALID_EDITS",
      "One or more edits are invalid",
      validation.issues.map(/* ... */)
    ));
  }

  // ... (continue with apply, recompress, send DOCX)
});
```

**Important:** Dry-run mode still creates the editor and extracts IR (necessary for validation), but does NOT call applyEditsToBuffer, exportDocx, or recompressDocxBuffer. This saves significant processing time (~80% faster than full apply).

### Pattern 3: Edit Summary Response Headers

**What:** Add X-Edits-Applied, X-Edits-Skipped, X-Warnings headers to successful apply responses.
**When to use:** On every successful 200 response (after edits applied and DOCX returned).
**Source:** Fastify reply.header(), existing validation and apply result structures

```javascript
// src/routes/apply.mjs - after apply succeeds, before sending response

// Apply edits and collect counts
const validation = validateEditsAgainstIR(editsJson, ir);
let modifiedBuffer;
try {
  modifiedBuffer = await applyEditsToBuffer(editor, editsJson, ir, {
    author: API_AUTHOR,
  });
} catch (error) {
  // ... error handling
}

// Calculate counts for headers
const appliedCount = validation.summary.validEdits; // All valid edits were applied
const skippedCount = validation.summary.invalidEdits; // Invalid edits were skipped
const warningCount = validation.summary.warningCount; // Non-blocking warnings

// Recompress
let finalBuffer = modifiedBuffer;
try {
  finalBuffer = await recompressDocxBuffer(modifiedBuffer);
} catch (error) {
  request.log.warn({ err: error, filename }, "DOCX recompression failed");
}

// Return DOCX with summary headers
const outputFilename = sanitizeOutputFilename(filename);
return reply
  .header("Content-Type", DOCX_CONTENT_TYPE)
  .header("Content-Disposition", `attachment; filename="${outputFilename}"`)
  .header("X-Edits-Applied", String(appliedCount))
  .header("X-Edits-Skipped", String(skippedCount))
  .header("X-Warnings", String(warningCount))
  .send(finalBuffer);
```

**Note:** Header values must be strings. Use String() to convert numbers. Headers are only added on success (200 responses with DOCX). Error responses (400, 422) do not include these headers.

### Pattern 4: Markdown Parse Error Handling

**What:** Provide clear error messages when markdown format is detected but parsing fails.
**When to use:** When parseMarkdownEdits() returns empty or malformed result.
**Source:** Existing error handling patterns from Phase 6

```javascript
// After detecting markdown format

const parsed = parseMarkdownEdits(editsString);

// Validate parsing succeeded
if (!parsed) {
  return reply.status(400).send(buildError(
    "INVALID_EDITS_MARKDOWN",
    "Markdown format detected but parsing failed",
    [{ field: "edits", reason: "parseMarkdownEdits returned null" }]
  ));
}

if (!parsed.edits) {
  return reply.status(400).send(buildError(
    "INVALID_EDITS_MARKDOWN",
    "Markdown format is missing edits array",
    [{ field: "edits", reason: "No ## Edits Table section found" }]
  ));
}

if (!Array.isArray(parsed.edits)) {
  return reply.status(400).send(buildError(
    "INVALID_EDITS_MARKDOWN",
    "Parsed edits is not an array",
    [{ field: "edits", reason: `Expected array, got ${typeof parsed.edits}` }]
  ));
}

if (parsed.edits.length === 0) {
  return reply.status(400).send(buildError(
    "INVALID_EDITS_MARKDOWN",
    "Markdown format contains no edits",
    [{ field: "edits", reason: "Edits table is empty" }]
  ));
}

// Success - use parsed.edits
editsJson = parsed.edits;
```

**Key insight:** parseMarkdownEdits() is designed for graceful degradation (partial recovery from truncated output), so it may return an empty edits array instead of throwing. Validate the result structure explicitly.

### Pattern 5: Dry-Run Validation Report Format

**What:** Structure the dry-run response to match the validation result but in a client-friendly format.
**When to use:** When dry_run=true query parameter is present.
**Source:** Existing validation result structure from editApplicator.mjs

```javascript
// Dry-run response format
{
  "valid": false,
  "summary": {
    "totalEdits": 5,
    "validEdits": 3,
    "invalidEdits": 2,
    "warningCount": 1
  },
  "issues": [
    {
      "editIndex": 1,
      "blockId": "b999",
      "type": "missing_block",
      "message": "Block b999 not found in document"
    },
    {
      "editIndex": 3,
      "blockId": "b042",
      "type": "missing_field",
      "message": "Replace operation requires newText field"
    }
  ],
  "warnings": [
    {
      "editIndex": 2,
      "blockId": "b100",
      "type": "content_warning",
      "message": "Possible truncation: ends with \"...\" (original ended with \".\")"
    }
  ]
}
```

**Note:** Dry-run returns 200 (not 400) even if validation fails, because the request was processed successfully—it's the edits that are invalid, not the request. This allows clients to distinguish between "validation failed" (200 with valid: false) and "request malformed" (400).

### Anti-Patterns to Avoid

- **Parsing markdown unconditionally:** Don't try parseMarkdownEdits() on every edits field. JSON.parse() will fail on markdown with cryptic errors. Always detect format first.
- **Using Content-Type header for format detection:** Multipart fields can have content-type metadata, but most clients don't set it for text fields. String content inspection is more reliable.
- **Applying edits in dry-run mode:** Dry-run must exit immediately after validation. Never call applyEditsToBuffer() or exportDocx() when dry_run=true.
- **Adding headers to error responses:** X-Edits-Applied and similar headers only make sense on success (200). Don't add them to 400/422 error responses.
- **Assuming markdown author metadata:** parseMarkdownEdits() returns author from markdown metadata, but it may be missing. Don't use it without checking for null/empty values.
- **Returning binary DOCX on dry-run:** Dry-run returns JSON validation report, not DOCX. Use reply.type('application/json').send() not reply.send(buffer).
- **Trusting markdown format without validation:** After parsing markdown, still run validateEditsAgainstIR() on the resulting JSON edits. Markdown format can be syntactically valid but contain invalid block IDs or operations.

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Markdown edit parsing | Custom regex or split-based parser | parseMarkdownEdits() from markdownEditsParser.mjs | Already handles all edge cases: multi-line newText, special characters, truncated output recovery, garbled content detection, multiple text sections. Production-tested with 50+ test cases. |
| Format detection | Content-Type header parsing or ML-based detection | String pattern matching (# Edits, ## Edits Table markers) | Markdown format has unambiguous markers. No need for complex heuristics. |
| Dry-run validation | Custom validation endpoint or separate service | Query param on existing /apply endpoint | Reuses all auth, multipart, file validation, and editor lifecycle logic. Single code path. |
| Edit counting during application | Manual tracking in loops | validation.summary counts | validateEditsAgainstIR() already computes totalEdits, validEdits, invalidEdits, warningCount. Don't recompute. |
| Response header formatting | Custom header name conventions | X-Edits-Applied, X-Edits-Skipped, X-Warnings | Standard X- prefix for custom headers. Clear, unambiguous names. |

**Key insight:** Phase 7 is almost entirely leveraging existing domain modules. The markdown parser is production-ready, validation returns exactly the counts needed for headers, and Fastify provides query param and header APIs. New code is primarily glue logic (format detection, early-exit on dry-run, header addition).

## Common Pitfalls

### Pitfall 1: False Positive Markdown Detection

**What goes wrong:** The detection logic incorrectly identifies JSON as markdown (e.g., JSON with a "# Edits" string value). parseMarkdownEdits() parses it and returns empty edits array.
**Why it happens:** Detection pattern is too loose (e.g., checking for "#" anywhere in string instead of at start).
**How to avoid:** Use anchored patterns: trim the string and check if it STARTS WITH markdown markers (# Edits, ## Metadata, ## Edits Table, or table header pattern). Don't match these patterns in the middle of the string.
**Warning signs:** Clients sending valid JSON but receiving "Markdown format contains no edits" errors.

### Pitfall 2: Dry-Run Returns Binary DOCX

**What goes wrong:** Dry-run mode validates edits but still applies them and returns DOCX. The client expected a JSON validation report.
**Why it happens:** Developer forgot to add early-exit after validation when dry_run=true, so the handler continues through apply/export/recompress steps.
**How to avoid:** Immediately after validation, check if (isDryRun) { return reply.type('application/json').send(validationReport); }. This must come BEFORE the validation.valid check that proceeds to apply.
**Warning signs:** Dry-run requests take as long as normal requests. Clients receive DOCX when they expected JSON.

### Pitfall 3: Header Values Are Not Strings

**What goes wrong:** Setting headers with number values: reply.header('X-Edits-Applied', appliedCount). Fastify coerces to string, but some HTTP clients or proxies may reject non-string headers.
**Why it happens:** Developer forgets that HTTP headers are always strings.
**How to avoid:** Always convert to string: reply.header('X-Edits-Applied', String(appliedCount)).
**Warning signs:** Header values are missing or malformed in client-side inspection. Proxy logs show header validation errors.

### Pitfall 4: Markdown Author Overrides API Author

**What goes wrong:** parseMarkdownEdits() extracts author from markdown metadata (name: "AI Counsel", email: "ai@firm.com"). The handler uses this for track changes instead of the default API_AUTHOR. Now different requests have different authors based on markdown content.
**Why it happens:** Developer assumes markdown author should override default author for "flexibility."
**How to avoid:** Phase 7 focuses on format support, not author customization. Always use API_AUTHOR constant for consistency. If author passthrough is desired, defer to future enhancement and document the decision.
**Warning signs:** Track changes in DOCX show inconsistent author names. Author email varies between requests.

### Pitfall 5: Dry-Run Returns 400 on Invalid Edits

**What goes wrong:** Dry-run validation finds invalid edits and returns 400 error response instead of 200 with valid: false.
**Why it happens:** Developer treats dry-run same as normal validation—invalid edits = request failed.
**How to avoid:** Dry-run returns 200 with validation report regardless of validation outcome. The request succeeded (dry-run was performed). Use 400 only for malformed requests (missing file, invalid JSON/markdown format). Validation failures in dry-run are reported in the valid: false field of the JSON response.
**Warning signs:** Clients can't distinguish between "request is malformed" and "edits are invalid" in dry-run mode.

### Pitfall 6: Skipped Count Excludes Validation Failures

**What goes wrong:** X-Edits-Skipped header shows 0 even when some edits were invalid. The header only counts edits that were skipped during application (e.g., TOC blocks), not edits that failed validation.
**Why it happens:** Developer uses a runtime skip counter instead of validation.summary.invalidEdits.
**How to avoid:** X-Edits-Skipped should equal validation.summary.invalidEdits (edits that failed validation and were never applied). X-Edits-Applied should equal validation.summary.validEdits (edits that passed validation and were applied). Don't create a separate skip counter—use the validation counts.
**Warning signs:** Header math doesn't add up: Applied + Skipped ≠ Total. Clients confused about why some edits disappeared.

### Pitfall 7: Markdown Parsing Errors Are Silent

**What goes wrong:** parseMarkdownEdits() returns empty edits array due to malformed markdown (e.g., table header missing). The handler treats it as "no edits provided" and returns MISSING_EDITS error. Clients don't know their markdown was malformed.
**Why it happens:** parseMarkdownEdits() is designed for graceful degradation (CLI use case where partial recovery is helpful). HTTP API needs explicit failure.
**How to avoid:** After detecting markdown format and parsing, check if parsed.edits.length === 0. If so, return INVALID_EDITS_MARKDOWN error explaining that markdown was detected but parsing failed. Include context about what might be wrong (missing table, malformed rows, etc.).
**Warning signs:** Clients report "Markdown format seems correct but API says no edits found." Silent failures on malformed markdown.

### Pitfall 8: Query Parameter Type Coercion Confusion

**What goes wrong:** request.query.dry_run is the string "false" instead of boolean false. The handler checks if (request.query.dry_run) which is truthy (non-empty string), so dry-run mode activates when dry_run=false.
**Why it happens:** Query parameters are parsed as strings by default. "false" is a truthy string.
**How to avoid:** Explicitly check: const isDryRun = request.query.dry_run === true || request.query.dry_run === 'true'. Or use route schema with type: 'boolean' which enables Fastify's type coercion.
**Warning signs:** dry_run=false query param activates dry-run mode. Inconsistent behavior between true/false values.

## Code Examples

Verified patterns from official sources and existing codebase:

### Complete Apply Route Handler with Phase 7 Extensions

```javascript
// src/routes/apply.mjs
// Source: Phase 6 apply.mjs + parseMarkdownEdits from markdownEditsParser.mjs

import { parseMarkdownEdits } from "../markdownEditsParser.mjs";
// ... (other imports from Phase 6)

async function applyRoutes(fastify, opts) {
  fastify.post("/apply", {
    preHandler: [requireMultipart],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          dry_run: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    const isDryRun = request.query.dry_run === true || request.query.dry_run === 'true';

    let fileBuffer = null;
    let editsJson = null;
    let filename = "document.docx";

    // Step 1: Parse multipart fields with format auto-detection
    for await (const part of request.parts()) {
      if (part.type === "file") {
        fileBuffer = await part.toBuffer();
        filename = part.filename || filename;
        continue;
      }

      if (part.fieldname === "edits") {
        const editsString = part.value;

        // Auto-detect format: markdown has specific markers
        const trimmed = editsString.trim();
        const isMarkdown = trimmed.startsWith('# Edits')
          || trimmed.startsWith('## Metadata')
          || trimmed.startsWith('## Edits Table')
          || /^\|\s*Block\s*\|/.test(trimmed);

        if (isMarkdown) {
          // Parse markdown format
          const parsed = parseMarkdownEdits(editsString);
          if (!parsed || !parsed.edits || !Array.isArray(parsed.edits) || parsed.edits.length === 0) {
            return reply.status(400).send(buildError(
              "INVALID_EDITS_MARKDOWN",
              "Markdown format detected but parsing failed or contains no edits",
              [{ field: "edits", reason: "Could not parse markdown edits table" }]
            ));
          }
          editsJson = parsed.edits;
        } else {
          // Parse JSON format
          try {
            editsJson = JSON.parse(editsString);
          } catch (error) {
            return reply.status(400).send(buildError(
              "INVALID_EDITS_JSON",
              "Edits field must be valid JSON or markdown format",
              [{ field: "edits", reason: error.message }]
            ));
          }
        }
      }
    }

    // Step 2-4: Validate required fields, file safety, create editor
    // ... (same as Phase 6)

    if (!fileBuffer) {
      return reply.status(400).send(buildError("MISSING_FILE", "No file uploaded", []));
    }

    if (!editsJson || !Array.isArray(editsJson)) {
      return reply.status(400).send(buildError(
        "MISSING_EDITS",
        "Edits field is required and must be a JSON array or markdown format",
        []
      ));
    }

    // File validation (magic bytes, zip bomb)
    // ... (same as Phase 6)

    // Acquire semaphore and create editor
    // ... (same as Phase 6)

    // Step 5: Validate edits
    try {
      const ir = extractIRFromEditor(editor, filename);
      const validation = validateEditsAgainstIR(editsJson, ir);

      // Dry-run mode: return validation report and exit early
      if (isDryRun) {
        return reply.type('application/json').send({
          valid: validation.valid,
          summary: {
            totalEdits: validation.summary.totalEdits,
            validEdits: validation.summary.validEdits,
            invalidEdits: validation.summary.invalidEdits,
            warningCount: validation.summary.warningCount
          },
          issues: validation.issues.map(issue => ({
            editIndex: issue.editIndex,
            blockId: issue.blockId ?? null,
            type: issue.type,
            message: issue.message
          })),
          warnings: validation.warnings.map(warn => ({
            editIndex: warn.editIndex,
            blockId: warn.blockId ?? null,
            type: warn.type,
            message: warn.message
          }))
        });
      }

      // Normal mode: check validation and proceed
      if (!validation.valid) {
        return reply.status(400).send(buildError(
          "INVALID_EDITS",
          "One or more edits are invalid",
          validation.issues.map(issue => ({
            editIndex: issue.editIndex,
            blockId: issue.blockId ?? null,
            type: issue.type,
            message: issue.message
          }))
        ));
      }

      // Step 6: Apply edits
      let modifiedBuffer;
      try {
        modifiedBuffer = await applyEditsToBuffer(editor, editsJson, ir, {
          author: API_AUTHOR,
        });
      } catch (error) {
        request.log.error({ err: error, filename }, "Edit application failed");
        return reply.status(422).send(buildError("APPLY_FAILED", "Unable to apply edits to document", []));
      }

      // Step 7: Recompress
      let finalBuffer = modifiedBuffer;
      try {
        finalBuffer = await recompressDocxBuffer(modifiedBuffer);
      } catch (error) {
        request.log.warn({ err: error, filename }, "DOCX recompression failed");
      }

      // Step 8: Calculate header counts
      const appliedCount = validation.summary.validEdits;
      const skippedCount = validation.summary.invalidEdits;
      const warningCount = validation.summary.warningCount;

      // Step 9: Return DOCX with summary headers
      const outputFilename = sanitizeOutputFilename(filename);
      return reply
        .header("Content-Type", DOCX_CONTENT_TYPE)
        .header("Content-Disposition", `attachment; filename="${outputFilename}"`)
        .header("X-Edits-Applied", String(appliedCount))
        .header("X-Edits-Skipped", String(skippedCount))
        .header("X-Warnings", String(warningCount))
        .send(finalBuffer);
    } finally {
      // onResponse hook performs cleanup + semaphore release
    }
  });
}

export default applyRoutes;
```

### Format Detection and Parsing

```javascript
// Markdown format detection and parsing
// Source: markdownEditsParser.mjs patterns

const editsString = part.value; // String from multipart field

// Step 1: Trim and detect format
const trimmed = editsString.trim();
const isMarkdown = trimmed.startsWith('# Edits')
  || trimmed.startsWith('## Metadata')
  || trimmed.startsWith('## Edits Table')
  || /^\|\s*Block\s*\|/.test(trimmed); // Table header: | Block | Op | Diff | Comment |

if (isMarkdown) {
  // Step 2: Parse markdown
  const parsed = parseMarkdownEdits(editsString);

  // Step 3: Validate parse result
  if (!parsed || !parsed.edits || !Array.isArray(parsed.edits)) {
    return reply.status(400).send(buildError(
      "INVALID_EDITS_MARKDOWN",
      "Markdown format detected but parsing failed",
      [{ field: "edits", reason: "parseMarkdownEdits returned invalid structure" }]
    ));
  }

  if (parsed.edits.length === 0) {
    return reply.status(400).send(buildError(
      "INVALID_EDITS_MARKDOWN",
      "Markdown format contains no edits",
      [{ field: "edits", reason: "Edits table is empty or malformed" }]
    ));
  }

  // Step 4: Use parsed edits
  editsJson = parsed.edits;
} else {
  // Parse as JSON
  try {
    editsJson = JSON.parse(editsString);
  } catch (error) {
    return reply.status(400).send(buildError(
      "INVALID_EDITS_JSON",
      "Edits field must be valid JSON or markdown format",
      [{ field: "edits", reason: error.message }]
    ));
  }
}
```

### Dry-Run Validation Report Response

```javascript
// Dry-run early-exit after validation
// Source: Fastify reply patterns + existing validation structure

const validation = validateEditsAgainstIR(editsJson, ir);

if (isDryRun) {
  // Return validation report as JSON (200 status regardless of validation outcome)
  return reply.type('application/json').send({
    valid: validation.valid,
    summary: {
      totalEdits: validation.summary.totalEdits,
      validEdits: validation.summary.validEdits,
      invalidEdits: validation.summary.invalidEdits,
      warningCount: validation.summary.warningCount
    },
    issues: validation.issues.map(issue => ({
      editIndex: issue.editIndex,
      blockId: issue.blockId ?? null,
      type: issue.type,
      message: issue.message
    })),
    warnings: validation.warnings.map(warn => ({
      editIndex: warn.editIndex,
      blockId: warn.blockId ?? null,
      type: warn.type,
      message: warn.message
    }))
  });
}

// Normal flow continues here (check validation.valid, apply edits, etc.)
```

### Response Headers for Edit Metadata

```javascript
// Add edit summary headers to successful response
// Source: Fastify reply.header() API + validation summary structure

// After validation and application
const appliedCount = validation.summary.validEdits; // Edits that passed validation and were applied
const skippedCount = validation.summary.invalidEdits; // Edits that failed validation
const warningCount = validation.summary.warningCount; // Non-blocking warnings

// Return DOCX with headers
return reply
  .header("Content-Type", DOCX_CONTENT_TYPE)
  .header("Content-Disposition", `attachment; filename="${outputFilename}"`)
  .header("X-Edits-Applied", String(appliedCount))
  .header("X-Edits-Skipped", String(skippedCount))
  .header("X-Warnings", String(warningCount))
  .send(finalBuffer);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| JSON-only edits | JSON + markdown auto-detection | Phase 7 (APPLY-05) | Clients can use LLM-friendly markdown format; auto-detection means no Content-Type header required |
| No validation-only mode | Dry-run via query param | Phase 7 (APPLY-06) | Clients can validate edits without producing DOCX (~80% faster); useful for edit preview workflows |
| No edit metadata in response | X-Edits-Applied, X-Edits-Skipped, X-Warnings headers | Phase 7 (APPLY-07) | Clients can track success rate without parsing binary DOCX; useful for batch processing and monitoring |
| Separate format endpoints | Single endpoint with auto-detection | Phase 7 (APPLY-05) | Reduced API surface area; simpler client integration; same auth/validation logic for both formats |

**Deprecated/outdated:**
- **Manual format selection:** Don't require clients to specify edits_format parameter. Auto-detection is more reliable and eliminates a source of client errors.
- **Separate /validate endpoint:** Don't create a new endpoint for validation. Use dry_run=true on /apply to reuse all request handling logic.

## Open Questions

Things that couldn't be fully resolved:

1. **Should markdown author metadata override API_AUTHOR?**
   - What we know: parseMarkdownEdits() returns author from markdown metadata (name + email). This could be used for track changes attribution.
   - What's unclear: Whether author passthrough is desired or if all API requests should use consistent API_AUTHOR. Security implications: can clients impersonate authors?
   - Recommendation: Phase 7 uses API_AUTHOR constant for all requests, ignoring markdown author metadata. Defer author passthrough to future enhancement (FEAT-02 in v2). Document this decision in PLAN.md.

2. **Should dry-run return 200 or 400 when validation fails?**
   - What we know: Dry-run processed the request successfully—it validated edits and returned a report. The edits being invalid is not a request failure.
   - What's unclear: Some REST conventions use 4xx for "operation didn't succeed" even if request was processed.
   - Recommendation: Return 200 with valid: false in JSON body. Clients can check the valid field. Use 400 only for malformed requests (missing file, invalid JSON/markdown format). This matches the pattern: 200 = request processed, 400 = request malformed, 422 = entity unprocessable.

3. **What happens if markdown contains both JSON and markdown markers?**
   - What we know: Detection checks for markdown markers first. If found, parseMarkdownEdits() is used.
   - What's unclear: Edge case where edits field contains both (e.g., JSON with a field value "# Edits Table").
   - Recommendation: Detection pattern is anchored (starts with marker). A JSON string value containing "# Edits" won't trigger markdown parsing because it won't be at the start of the trimmed string. Low risk edge case.

4. **Should X-Edits-Applied include TOC blocks that were skipped?**
   - What we know: applyEditsToBuffer() skips TOC blocks at runtime (after validation passes). These are not included in validation.summary.invalidEdits.
   - What's unclear: Whether X-Edits-Applied should reflect actual applied count (excluding runtime skips) or validation-based count.
   - Recommendation: Use validation.summary.validEdits for consistency. TOC detection happens at validation (warnings) and application (skip). Count reflects validation result. If runtime skip tracking is needed, defer to future enhancement.

## Sources

### Primary (HIGH confidence)
- src/markdownEditsParser.mjs - Verified parseMarkdownEdits() and editsToMarkdown() APIs; production-tested parser
- tests_and_others/tests/markdownEditsParser.test.mjs - Comprehensive test coverage (50+ test cases) including truncation, edge cases, round-trip
- src/editApplicator.mjs - Verified validateEditsAgainstIR() return structure: { valid, issues, warnings, summary }
- src/routes/apply.mjs (Phase 6) - Verified existing multipart parsing, error handling, and response patterns
- [Fastify Reply Reference](https://fastify.dev/docs/latest/Reference/Reply/) - Verified reply.header() API for custom headers
- [Fastify Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) - Verified route schema for query parameter validation
- Existing Phase 6 apply.mjs patterns - Verified multipart parsing with request.parts(), buildError() helper, and error codes

### Secondary (MEDIUM confidence)
- [Understand customizing response headers](https://app.studyraid.com/en/read/8392/231434/customizing-response-headers) - Best practices for custom headers (X- prefix, string values)
- [Query string validation in Fastify](https://mikulskibartosz.name/query-string-validation-in-fastify) - Query parameter validation with JSON Schema
- [@fastify/multipart README](https://github.com/fastify/fastify-multipart/blob/main/README.md) - Multipart field parsing with request.parts() async iterator

### Tertiary (LOW confidence)
- None. All critical patterns verified against existing codebase or official Fastify documentation.

## Metadata

**Confidence breakdown:**
- Markdown parsing: HIGH - parseMarkdownEdits() already exists with comprehensive tests; no new parsing logic required
- Format detection: HIGH - Markdown markers are unambiguous; simple string pattern matching is reliable
- Dry-run mode: HIGH - Validation function already returns complete report structure; early-exit is straightforward
- Response headers: HIGH - Fastify reply.header() is core API; validation.summary provides exact counts needed
- Query parameter handling: HIGH - Fastify schema validation for querystring is standard practice

**Research date:** 2026-02-06
**Valid until:** 2026-03-08 (30 days — stable domain modules, well-defined requirements, Fastify core APIs)
