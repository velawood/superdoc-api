import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import buildApp from "../../src/app.mjs";
import { editsToMarkdown } from "../../src/markdownEditsParser.mjs";

const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const API_KEY = "test-key-apply-extended";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLE_DOCX_PATH = path.join(__dirname, "fixtures", "sample.docx");

/**
 * Build multipart/form-data payload from file and text parts.
 *
 * @param {Array<object>} parts
 * @returns {{ body: Buffer, contentType: string }}
 */
function buildMultipartPayload(parts) {
  const boundary = "----FormBoundary" + Date.now() + Math.random().toString(16).slice(2);
  const chunks = [];

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));

    if (Object.hasOwn(part, "filename")) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.fieldname}"; filename="${part.filename}"\r\n`
      ));
      chunks.push(Buffer.from(
        `Content-Type: ${part.contentType || "application/octet-stream"}\r\n\r\n`
      ));
      chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(String(part.content)));
      chunks.push(Buffer.from("\r\n"));
      continue;
    }

    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.fieldname}"\r\n\r\n`));
    chunks.push(Buffer.from(String(part.value)));
    chunks.push(Buffer.from("\r\n"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * POST /v1/apply request helper with multipart payload.
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {object} args
 * @param {Buffer} [args.file]
 * @param {string} [args.filename]
 * @param {string} args.edits
 * @param {Record<string, string|boolean|number>} [args.querystring]
 * @param {string} [args.contentType]
 * @returns {Promise<import("light-my-request").Response>}
 */
async function makeApplyRequest(app, {
  file,
  filename = "sample.docx",
  edits,
  querystring = {},
  contentType = "application/octet-stream",
}) {
  const parts = [];
  if (file) {
    parts.push({
      fieldname: "file",
      filename,
      content: file,
      contentType,
    });
  }
  if (edits !== undefined) {
    parts.push({
      fieldname: "edits",
      value: edits,
    });
  }

  const { body, contentType: multipartType } = buildMultipartPayload(parts);
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(querystring)) {
    qs.append(key, String(value));
  }
  const url = qs.toString().length > 0 ? `/v1/apply?${qs.toString()}` : "/v1/apply";

  return app.inject({
    method: "POST",
    url,
    payload: body,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": multipartType,
    },
  });
}

/**
 * Resolve stable seqIds from /v1/read for valid apply tests.
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {Buffer} sampleDocx
 * @returns {Promise<string[]>}
 */
async function resolveValidSeqIds(app, sampleDocx) {
  const { body, contentType } = buildMultipartPayload([
    {
      fieldname: "file",
      filename: "sample.docx",
      content: sampleDocx,
      contentType: "application/octet-stream",
    },
  ]);

  const res = await app.inject({
    method: "POST",
    url: "/v1/read",
    payload: body,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": contentType,
    },
  });

  assert.equal(res.statusCode, 200);
  const ir = res.json();
  assert.ok(Array.isArray(ir.blocks), "read response must include blocks");
  assert.ok(ir.blocks.length > 0, "fixture must contain blocks");

  const seqIds = ir.blocks.map((block) => block.seqId).filter(Boolean);
  assert.ok(seqIds.length > 0, "read response must include seqIds");
  return seqIds;
}

describe("POST /v1/apply - Extended Contract", () => {
  let app;
  let sampleDocx;
  let validSeqIds;
  let validEdit;
  let validJsonEditsString;
  let validMarkdownEditsString;

  before(async () => {
    app = buildApp({ logger: false, apiKey: API_KEY });
    await app.ready();

    sampleDocx = await readFile(SAMPLE_DOCX_PATH);
    validSeqIds = await resolveValidSeqIds(app, sampleDocx);
    validEdit = { blockId: validSeqIds[0], operation: "comment", comment: "apply-extended test comment" };
    validJsonEditsString = JSON.stringify([validEdit]);
    validMarkdownEditsString = editsToMarkdown({
      version: "1.0",
      author: { name: "Test", email: "test@test.com" },
      edits: [validEdit],
    });
  });

  after(async () => {
    await app.close();
  });

  it("accepts markdown-formatted edits and returns 200 with DOCX binary", async () => {
    const res = await makeApplyRequest(app, {
      file: sampleDocx,
      edits: validMarkdownEditsString,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], DOCX_CONTENT_TYPE);
    assert.ok(Buffer.isBuffer(res.rawPayload), "expected binary payload");
    assert.deepEqual(res.rawPayload.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it("returns 400 INVALID_EDITS_MARKDOWN for malformed markdown", async () => {
    const malformedMarkdown = "# Edits\n\nThis is not a valid edits table";
    const res = await makeApplyRequest(app, {
      file: sampleDocx,
      edits: malformedMarkdown,
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "INVALID_EDITS_MARKDOWN");
  });

  it("auto-detects JSON when edits field is valid JSON array", async () => {
    const res = await makeApplyRequest(app, {
      file: sampleDocx,
      edits: validJsonEditsString,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], DOCX_CONTENT_TYPE);
  });

  it("auto-detects JSON when edits field starts with [ (array notation)", async () => {
    const edits = JSON.stringify([{ blockId: validSeqIds[0], operation: "delete", comment: "json array parse" }]);
    const res = await makeApplyRequest(app, {
      file: sampleDocx,
      edits,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], DOCX_CONTENT_TYPE);
  });

  it("dry_run=true returns 200 with JSON validation report", async () => {
    const res = await makeApplyRequest(app, {
      file: sampleDocx,
      edits: validJsonEditsString,
      querystring: { dry_run: true },
    });

    assert.equal(res.statusCode, 200);
    assert.ok(
      String(res.headers["content-type"]).includes("application/json"),
      `expected application/json content type, got ${res.headers["content-type"]}`
    );

    const body = res.json();
    assert.equal(typeof body.valid, "boolean");
    assert.equal(typeof body.summary, "object");
    assert.ok(Array.isArray(body.issues));
    assert.ok(Array.isArray(body.warnings));
    assert.equal(typeof body.summary.totalEdits, "number");
    assert.equal(typeof body.summary.validEdits, "number");
    assert.equal(typeof body.summary.invalidEdits, "number");
    assert.equal(typeof body.summary.warningCount, "number");
  });

  it("dry_run=true returns 200 even with invalid edits", async () => {
    const invalidEdits = JSON.stringify([{ blockId: "missing-block-id", operation: "replace", newText: "nope" }]);
    const res = await makeApplyRequest(app, {
      file: sampleDocx,
      edits: invalidEdits,
      querystring: { dry_run: true },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.valid, false);
    assert.ok(Array.isArray(body.issues));
    assert.ok(body.issues.length > 0);
    assert.ok(body.summary.invalidEdits > 0);
  });

  it("dry_run=true does not return DOCX binary", async () => {
    const res = await makeApplyRequest(app, {
      file: sampleDocx,
      edits: validJsonEditsString,
      querystring: { dry_run: true },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(typeof body, "object");
    assert.notDeepEqual(res.rawPayload.subarray(0, 2), Buffer.from([0x50, 0x4b]));
  });

  it("dry_run=false (or absent) returns DOCX binary as usual", async () => {
    const res = await makeApplyRequest(app, {
      file: sampleDocx,
      edits: validJsonEditsString,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], DOCX_CONTENT_TYPE);
    assert.deepEqual(res.rawPayload.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it("dry_run=true works with markdown-formatted edits", async () => {
    const res = await makeApplyRequest(app, {
      file: sampleDocx,
      edits: validMarkdownEditsString,
      querystring: { dry_run: true },
    });

    assert.equal(res.statusCode, 200);
    assert.ok(String(res.headers["content-type"]).includes("application/json"));
    const body = res.json();
    assert.equal(typeof body.valid, "boolean");
  });

  it("successful apply includes X-Edits-Applied header", async () => {
    const res = await makeApplyRequest(app, {
      file: sampleDocx,
      edits: validJsonEditsString,
    });

    assert.equal(res.statusCode, 200);
    assert.ok("x-edits-applied" in res.headers);
    assert.match(String(res.headers["x-edits-applied"]), /^\d+$/);
  });

  it("successful apply includes X-Edits-Skipped header", async () => {
    const res = await makeApplyRequest(app, {
      file: sampleDocx,
      edits: validJsonEditsString,
    });

    assert.equal(res.statusCode, 200);
    assert.ok("x-edits-skipped" in res.headers);
    assert.match(String(res.headers["x-edits-skipped"]), /^\d+$/);
  });

  it("successful apply includes X-Warnings header", async () => {
    const res = await makeApplyRequest(app, {
      file: sampleDocx,
      edits: validJsonEditsString,
    });

    assert.equal(res.statusCode, 200);
    assert.ok("x-warnings" in res.headers);
    assert.match(String(res.headers["x-warnings"]), /^\d+$/);
  });

  it("header counts match edit summary", async () => {
    const edits = JSON.stringify([
      { blockId: validSeqIds[0], operation: "comment", comment: "header count 1" },
    ]);
    const res = await makeApplyRequest(app, {
      file: sampleDocx,
      edits,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(Number.parseInt(String(res.headers["x-edits-applied"]), 10), 1);
    assert.equal(Number.parseInt(String(res.headers["x-edits-skipped"]), 10), 0);
  });

  it("error responses do NOT include edit summary headers", async () => {
    const res = await makeApplyRequest(app, {
      edits: validJsonEditsString,
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "MISSING_FILE");
    assert.equal(res.headers["x-edits-applied"], undefined);
    assert.equal(res.headers["x-edits-skipped"], undefined);
    assert.equal(res.headers["x-warnings"], undefined);
  });
});
