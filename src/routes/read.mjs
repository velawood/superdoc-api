import { extractDocumentIRFromBuffer } from "../irExtractor.mjs";
import { validateMagicBytes, checkZipBomb } from "../validation/file-upload.mjs";
import { requireMultipart } from "../hooks/content-type-check.mjs";

/**
 * Read endpoint route plugin.
 *
 * Registers POST /read for uploading and extracting document IR from DOCX files.
 *
 * Flow:
 * 1. requireMultipart preHandler validates Content-Type: multipart/form-data
 * 2. Extract uploaded file from request
 * 3. Validate ZIP magic bytes (DOCX files are ZIP archives)
 * 4. Check for zip bomb attacks
 * 5. Extract document IR using extractDocumentIRFromBuffer
 * 6. Return full IR as JSON (blocks, outline, definedTerms, idMapping)
 *
 * Error responses follow established format: { error: { code, message, details } }
 *
 * Error codes:
 * - 400 MISSING_FILE: No file uploaded in multipart request
 * - 400 INVALID_FILE_TYPE: File does not have ZIP/DOCX magic bytes
 * - 400 ZIP_BOMB_DETECTED: Suspicious compression ratio or decompressed size
 * - 422 EXTRACTION_FAILED: File passed validation but SuperDoc cannot parse DOCX content
 *
 * Authentication: Inherits Bearer auth from /v1 scope (no additional auth needed here)
 *
 * @param {import("fastify").FastifyInstance} fastify
 * @param {object} opts
 */
async function readRoutes(fastify, opts) {
  fastify.post("/read", { preHandler: [requireMultipart] }, async (request, reply) => {
    // Step 1: Extract uploaded file
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

    // Step 3: Validate ZIP magic bytes
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
    const zipResult = await checkZipBomb(buffer);
    if (!zipResult.safe) {
      return reply.status(400).send({
        error: {
          code: "ZIP_BOMB_DETECTED",
          message: zipResult.error,
          details: [],
        },
      });
    }

    // Step 5: Extract document IR
    let ir;
    try {
      ir = await extractDocumentIRFromBuffer(buffer, filename, {
        format: "full",
        includeDefinedTerms: true,
        includeOutline: true,
      });
    } catch (error) {
      request.log.error({ err: error, filename }, "Document extraction failed");
      return reply.status(422).send({
        error: {
          code: "EXTRACTION_FAILED",
          message: "Unable to process document",
          details: [],
        },
      });
    }

    // Step 6: Return IR as JSON
    return reply.type("application/json").send(ir);
  });
}

export default readRoutes;
