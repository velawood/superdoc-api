import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import buildApp from "../../src/app.mjs";

const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const API_KEY = "test-key-apply";

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
 * Resolve a valid, stable block identifier by reading IR from /v1/read.
 *
 * UUID ids are regenerated on each parse, so use seqId for apply tests.
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {Buffer} sampleDocx
 * @returns {Promise<string>}
 */
async function resolveValidSeqId(app, sampleDocx) {
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
  const response = res.json();
  assert.ok(Array.isArray(response.blocks) && response.blocks.length > 0, "read response has blocks");
  assert.equal(typeof response.blocks[0].seqId, "string");
  return response.blocks[0].seqId;
}

function assertErrorDetailShape(detail) {
  assert.ok(Object.hasOwn(detail, "editIndex"), "detail includes editIndex");
  assert.ok(Object.hasOwn(detail, "blockId"), "detail includes blockId");
  assert.ok(Object.hasOwn(detail, "type"), "detail includes type");
  assert.ok(Object.hasOwn(detail, "message"), "detail includes message");
}

// ---------------------------------------------------------------------------
// Suite 1: Happy Path
// ---------------------------------------------------------------------------
describe("POST /v1/apply - Happy Path", () => {
  let app;
  let sampleDocx;
  let validBlockId;

  before(async () => {
    app = buildApp({ logger: false, apiKey: API_KEY });
    await app.ready();
    sampleDocx = await readFile(SAMPLE_DOCX_PATH);
    validBlockId = await resolveValidSeqId(app, sampleDocx);
  });

  after(async () => {
    await app.close();
  });

  it("returns 200 with DOCX binary when valid DOCX + valid edits are sent", async () => {
    const edits = [{ blockId: validBlockId, operation: "comment", comment: "Test comment" }];
    const { body, contentType } = buildMultipartPayload([
      {
        fieldname: "file",
        filename: "sample.docx",
        content: sampleDocx,
        contentType: "application/octet-stream",
      },
      {
        fieldname: "edits",
        value: JSON.stringify(edits),
      },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/apply",
      payload: body,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], DOCX_CONTENT_TYPE);
    assert.match(res.headers["content-disposition"], /attachment/i);
    assert.match(res.headers["content-disposition"], /-edited\.docx"/i);

    assert.ok(Buffer.isBuffer(res.rawPayload), "response is binary buffer");
    assert.ok(res.rawPayload.length > 0, "response buffer is non-empty");
    assert.deepEqual(res.rawPayload.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Edit Validation (APPLY-02)
// ---------------------------------------------------------------------------
describe("POST /v1/apply - Edit Validation", () => {
  let app;
  let sampleDocx;
  let validBlockId;

  before(async () => {
    app = buildApp({ logger: false, apiKey: API_KEY });
    await app.ready();
    sampleDocx = await readFile(SAMPLE_DOCX_PATH);
    validBlockId = await resolveValidSeqId(app, sampleDocx);
  });

  after(async () => {
    await app.close();
  });

  it("returns 400 INVALID_EDITS when blockId does not exist", async () => {
    const edits = [{ blockId: "nonexistent-block-id", operation: "replace", newText: "x" }];
    const { body, contentType } = buildMultipartPayload([
      { fieldname: "file", filename: "sample.docx", content: sampleDocx },
      { fieldname: "edits", value: JSON.stringify(edits) },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/apply",
      payload: body,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 400);
    const response = res.json();
    assert.equal(response.error.code, "INVALID_EDITS");
    assert.ok(Array.isArray(response.error.details));
    assert.equal(response.error.details.length, 1);

    const detail = response.error.details[0];
    assertErrorDetailShape(detail);
    assert.equal(detail.editIndex, 0);
    assert.equal(detail.blockId, "nonexistent-block-id");
    assert.equal(detail.type, "missing_block");
  });

  it("returns 400 INVALID_EDITS for replace edit missing newText", async () => {
    const edits = [{ blockId: validBlockId, operation: "replace" }];
    const { body, contentType } = buildMultipartPayload([
      { fieldname: "file", filename: "sample.docx", content: sampleDocx },
      { fieldname: "edits", value: JSON.stringify(edits) },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/apply",
      payload: body,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 400);
    const response = res.json();
    assert.equal(response.error.code, "INVALID_EDITS");
    assert.ok(Array.isArray(response.error.details));
    assert.equal(response.error.details.length, 1);

    const detail = response.error.details[0];
    assertErrorDetailShape(detail);
    assert.equal(detail.editIndex, 0);
    assert.equal(detail.blockId, validBlockId);
    assert.equal(detail.type, "missing_field");
  });

  it("rejects entire request when valid and invalid edits are mixed", async () => {
    const edits = [
      { blockId: validBlockId, operation: "comment", comment: "valid edit" },
      { blockId: "missing-block", operation: "replace", newText: "x" },
      { blockId: validBlockId, operation: "replace" },
    ];

    const { body, contentType } = buildMultipartPayload([
      { fieldname: "file", filename: "sample.docx", content: sampleDocx },
      { fieldname: "edits", value: JSON.stringify(edits) },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/apply",
      payload: body,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 400);
    const response = res.json();
    assert.equal(response.error.code, "INVALID_EDITS");
    assert.ok(Array.isArray(response.error.details));
    assert.equal(response.error.details.length, 2, "all invalid edits should be returned");
    assert.deepEqual(response.error.details.map((d) => d.editIndex), [1, 2]);

    for (const detail of response.error.details) {
      assertErrorDetailShape(detail);
    }

    const types = new Set(response.error.details.map((d) => d.type));
    assert.ok(types.has("missing_block"));
    assert.ok(types.has("missing_field"));
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Input Validation
// ---------------------------------------------------------------------------
describe("POST /v1/apply - Input Validation", () => {
  let app;
  let sampleDocx;
  let validBlockId;

  before(async () => {
    app = buildApp({ logger: false, apiKey: API_KEY });
    await app.ready();
    sampleDocx = await readFile(SAMPLE_DOCX_PATH);
    validBlockId = await resolveValidSeqId(app, sampleDocx);
  });

  after(async () => {
    await app.close();
  });

  it("returns 400 MISSING_FILE when no file part is provided", async () => {
    const edits = [{ blockId: validBlockId, operation: "comment", comment: "test" }];
    const { body, contentType } = buildMultipartPayload([
      { fieldname: "edits", value: JSON.stringify(edits) },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/apply",
      payload: body,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "MISSING_FILE");
  });

  it("returns 400 MISSING_EDITS when no edits field is provided", async () => {
    const { body, contentType } = buildMultipartPayload([
      { fieldname: "file", filename: "sample.docx", content: sampleDocx },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/apply",
      payload: body,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "MISSING_EDITS");
  });

  it("returns 400 INVALID_EDITS_JSON when edits field contains malformed JSON", async () => {
    const { body, contentType } = buildMultipartPayload([
      { fieldname: "file", filename: "sample.docx", content: sampleDocx },
      { fieldname: "edits", value: "not valid json {" },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/apply",
      payload: body,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 400);
    const response = res.json();
    assert.equal(response.error.code, "INVALID_EDITS_JSON");
    assert.ok(Array.isArray(response.error.details));
  });

  it("returns 400 MISSING_EDITS when edits JSON is not an array", async () => {
    const { body, contentType } = buildMultipartPayload([
      { fieldname: "file", filename: "sample.docx", content: sampleDocx },
      { fieldname: "edits", value: JSON.stringify({ blockId: validBlockId, operation: "comment" }) },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/apply",
      payload: body,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "MISSING_EDITS");
  });

  it("returns 400 INVALID_FILE_TYPE for non-DOCX uploads", async () => {
    const pngBytes = Buffer.alloc(100);
    pngBytes[0] = 0x89;
    pngBytes[1] = 0x50;
    pngBytes[2] = 0x4e;
    pngBytes[3] = 0x47;

    const edits = [{ blockId: validBlockId, operation: "comment", comment: "test" }];
    const { body, contentType } = buildMultipartPayload([
      { fieldname: "file", filename: "fake.png", content: pngBytes, contentType: "image/png" },
      { fieldname: "edits", value: JSON.stringify(edits) },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/apply",
      payload: body,
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "INVALID_FILE_TYPE");
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Authentication
// ---------------------------------------------------------------------------
describe("POST /v1/apply - Authentication", () => {
  let app;
  let sampleDocx;

  before(async () => {
    app = buildApp({ logger: false, apiKey: API_KEY });
    await app.ready();
    sampleDocx = await readFile(SAMPLE_DOCX_PATH);
  });

  after(async () => {
    await app.close();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const edits = [{ blockId: "b001", operation: "comment", comment: "test" }];
    const { body, contentType } = buildMultipartPayload([
      { fieldname: "file", filename: "sample.docx", content: sampleDocx },
      { fieldname: "edits", value: JSON.stringify(edits) },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/apply",
      payload: body,
      headers: {
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "UNAUTHORIZED");
  });

  it("returns 401 when Bearer token is invalid", async () => {
    const edits = [{ blockId: "b001", operation: "comment", comment: "test" }];
    const { body, contentType } = buildMultipartPayload([
      { fieldname: "file", filename: "sample.docx", content: sampleDocx },
      { fieldname: "edits", value: JSON.stringify(edits) },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/apply",
      payload: body,
      headers: {
        authorization: "Bearer wrong-token",
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Content-Type
// ---------------------------------------------------------------------------
describe("POST /v1/apply - Content-Type", () => {
  let app;

  before(async () => {
    app = buildApp({ logger: false, apiKey: API_KEY });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("returns 400 INVALID_CONTENT_TYPE for non-multipart requests", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/apply",
      payload: {
        edits: [{ blockId: "b001", operation: "comment", comment: "test" }],
      },
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
    });

    assert.equal(res.statusCode, 400);
    const response = res.json();
    assert.equal(response.error.code, "INVALID_CONTENT_TYPE");
    assert.ok(Array.isArray(response.error.details));
  });
});
