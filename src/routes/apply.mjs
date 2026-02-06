import { createHeadlessEditor } from "../editorFactory.mjs";
import { extractIRFromEditor } from "../irExtractor.mjs";
import { validateEditsAgainstIR } from "../editApplicator.mjs";
import { parseMarkdownEdits } from "../markdownEditsParser.mjs";
import { validateMagicBytes, checkZipBomb } from "../validation/file-upload.mjs";
import { recompressDocxBuffer } from "../utils/recompress.mjs";
import { applyEditsToBuffer } from "../utils/apply-buffer.mjs";
import { requireMultipart } from "../hooks/content-type-check.mjs";

const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const API_AUTHOR = { name: "API User", email: "api@superdoc.com" };

/**
 * Build a consistent structured error payload.
 *
 * @param {string} code
 * @param {string} message
 * @param {Array<object>} [details=[]]
 * @returns {{ error: { code: string, message: string, details: Array<object> } }}
 */
function buildError(code, message, details = []) {
  return { error: { code, message, details } };
}

/**
 * Sanitize uploaded filename for Content-Disposition and append "-edited.docx".
 *
 * Replaces problematic header characters (quotes, backslashes, newlines),
 * strips non-ASCII, and normalizes remaining unsafe characters to underscores.
 *
 * @param {string} filename
 * @returns {string}
 */
function sanitizeOutputFilename(filename) {
  const base = (filename || "document.docx").replace(/\.docx$/i, "");
  const normalized = base.normalize("NFKD").replace(/[^\x20-\x7E]/g, "_");
  const headerSafe = normalized
    .replace(/["\\\r\n]/g, "_")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .trim()
    .replace(/\s+/g, "_");

  const safeBase = headerSafe || "document";
  return `${safeBase}-edited.docx`;
}

/**
 * Apply endpoint route plugin.
 *
 * Registers POST /apply for uploading a DOCX file and edits (JSON array or
 * markdown format), then returns a redlined DOCX as binary.
 *
 * Multipart fields:
 * - file (required): DOCX file
 * - edits (required): JSON array or markdown-formatted edits
 *
 * Query parameters:
 * - dry_run (optional boolean): validate edits only and return JSON report
 *
 * Success response:
 * - 200
 * - Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document
 * - Content-Disposition: attachment; filename="<sanitized>-edited.docx"
 * - X-Edits-Applied: number of valid edits applied
 * - X-Edits-Skipped: number of invalid edits skipped
 * - X-Warnings: number of validation warnings
 * - Body: DOCX binary buffer
 *
 * Error responses follow: { error: { code, message, details } }
 *
 * Error codes:
 * - 400 INVALID_EDITS_JSON: edits field exists but contains malformed JSON
 * - 400 INVALID_EDITS_MARKDOWN: markdown edits format is malformed or empty
 * - 400 MISSING_FILE: no file part provided
 * - 400 MISSING_EDITS: edits field missing or not a JSON array
 * - 400 INVALID_FILE_TYPE: uploaded file is not a ZIP/DOCX by magic bytes
 * - 400 ZIP_BOMB_DETECTED: uploaded ZIP has suspicious decompression characteristics
 * - 400 INVALID_EDITS: one or more edits fail validation (returns full issue list)
 * - 422 DOCUMENT_LOAD_FAILED: editor could not load the DOCX
 * - 422 APPLY_FAILED: edits could not be applied/exported
 *
 * Authentication: Inherits Bearer auth from /v1 scope.
 *
 * @param {import("fastify").FastifyInstance} fastify
 * @param {object} opts
 */
async function applyRoutes(fastify, opts) {
  fastify.post("/apply", {
    preHandler: [requireMultipart],
    schema: {
      querystring: {
        type: "object",
        properties: {
          dry_run: { type: "boolean", default: false },
        },
      },
    },
  }, async (request, reply) => {
    const isDryRun = request.query.dry_run === true;
    let fileBuffer = null;
    let editsJson = null;
    let filename = "document.docx";

    // Step 1: Parse all multipart fields (file + edits JSON).
    for await (const part of request.parts()) {
      if (part.type === "file") {
        fileBuffer = await part.toBuffer();
        filename = part.filename || filename;
        continue;
      }

      if (part.fieldname === "edits") {
        const editsString = part.value;
        const trimmed = editsString.trim();

        const isMarkdown = trimmed.startsWith("# Edits")
          || trimmed.startsWith("## Metadata")
          || trimmed.startsWith("## Edits Table")
          || /^\|\s*Block\s*\|/.test(trimmed);

        if (isMarkdown) {
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

    // Step 2: Validate required fields.
    if (!fileBuffer) {
      return reply.status(400).send(buildError("MISSING_FILE", "No file uploaded", []));
    }

    if (!editsJson) {
      return reply.status(400).send(buildError(
        "MISSING_EDITS",
        "Edits field is required and must be a JSON array or markdown format",
        []
      ));
    }

    if (!Array.isArray(editsJson)) {
      return reply.status(400).send(buildError("MISSING_EDITS", "Edits field must be a JSON array", []));
    }

    // Step 3: Validate file upload safety.
    const magicResult = validateMagicBytes(fileBuffer);
    if (!magicResult.valid) {
      return reply.status(400).send(buildError("INVALID_FILE_TYPE", magicResult.error, []));
    }

    const zipResult = await checkZipBomb(fileBuffer);
    if (!zipResult.safe) {
      return reply.status(400).send(buildError("ZIP_BOMB_DETECTED", zipResult.error, []));
    }

    // Step 4: Acquire semaphore and create editor.
    await fastify.documentSemaphore.acquire();

    let editor = null;
    let cleanup = null;
    try {
      const editorResult = await createHeadlessEditor(fileBuffer, {
        documentMode: "suggesting",
        user: API_AUTHOR,
      });

      if (editorResult && typeof editorResult === "object" && "editor" in editorResult) {
        editor = editorResult.editor;
        cleanup = typeof editorResult.cleanup === "function"
          ? editorResult.cleanup
          : null;
      } else {
        editor = editorResult;
      }

      if (!cleanup) {
        cleanup = () => {
          try {
            editor?.destroy?.();
          } catch {
            // Best-effort cleanup fallback for legacy return shape.
          }
        };
      }

      request.editorCleanup = cleanup;
    } catch (error) {
      if (cleanup) {
        try {
          cleanup();
        } catch (cleanupError) {
          request.log.warn({ err: cleanupError, filename }, "Immediate editor cleanup failed");
        }
      }

      try {
        fastify.documentSemaphore.release();
      } catch (releaseError) {
        request.log.warn({ err: releaseError }, "Failed to release document semaphore");
      }

      request.editorCleanup = null;
      request.log.error({ err: error, filename }, "Document load failed");
      return reply.status(422).send(buildError("DOCUMENT_LOAD_FAILED", "Unable to load document", []));
    }

    // Steps 5-8: Validate edits, apply, recompress, and return binary response.
    try {
      const ir = extractIRFromEditor(editor, filename);
      const validation = validateEditsAgainstIR(editsJson, ir);

      // Dry-run mode: return validation report without applying edits
      if (isDryRun) {
        return reply.type("application/json").send({
          valid: validation.valid,
          summary: {
            totalEdits: validation.summary.totalEdits,
            validEdits: validation.summary.validEdits,
            invalidEdits: validation.summary.invalidEdits,
            warningCount: validation.summary.warningCount,
          },
          issues: validation.issues.map((issue) => ({
            editIndex: issue.editIndex,
            blockId: issue.blockId ?? null,
            type: issue.type,
            message: issue.message,
          })),
          warnings: (validation.warnings || []).map((warn) => ({
            editIndex: warn.editIndex,
            blockId: warn.blockId ?? null,
            type: warn.type,
            message: warn.message,
          })),
        });
      }

      if (!validation.valid) {
        return reply.status(400).send(buildError(
          "INVALID_EDITS",
          "One or more edits are invalid",
          validation.issues.map((issue) => ({
            editIndex: issue.editIndex,
            blockId: issue.blockId ?? null,
            type: issue.type,
            message: issue.message,
          }))
        ));
      }

      const modifiedBuffer = await applyEditsToBuffer(editor, editsJson, ir, {
        author: API_AUTHOR,
      });

      let finalBuffer = modifiedBuffer;
      try {
        finalBuffer = await recompressDocxBuffer(modifiedBuffer);
      } catch (error) {
        request.log.warn({ err: error, filename }, "DOCX recompression failed; returning uncompressed output");
      }

      const appliedCount = validation.summary.validEdits;
      const skippedCount = validation.summary.invalidEdits;
      const warningCount = validation.summary.warningCount;
      const outputFilename = sanitizeOutputFilename(filename);
      return reply
        .header("Content-Type", DOCX_CONTENT_TYPE)
        .header("Content-Disposition", `attachment; filename="${outputFilename}"`)
        .header("X-Edits-Applied", String(appliedCount))
        .header("X-Edits-Skipped", String(skippedCount))
        .header("X-Warnings", String(warningCount))
        .send(finalBuffer);
    } catch (error) {
      request.log.error({ err: error, filename }, "Edit application failed");
      return reply.status(422).send(buildError("APPLY_FAILED", "Unable to apply edits to document", []));
    } finally {
      // onResponse hook performs cleanup + semaphore release using request.editorCleanup.
    }
  });
}

export default applyRoutes;
