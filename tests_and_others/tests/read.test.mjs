import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import buildApp from "../../src/app.mjs";

/**
 * Helper function to build a valid multipart/form-data payload.
 *
 * @param {string} filename - The filename to use in Content-Disposition
 * @param {Buffer} buffer - The file content
 * @returns {{payload: Buffer, contentType: string}} The multipart payload and Content-Type header
 */
function buildMultipartPayload(filename, buffer) {
  const boundary = "----FormBoundary" + Date.now();
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([header, buffer, footer]);

  return {
    payload,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Happy Path
// ---------------------------------------------------------------------------
describe("POST /v1/read - Happy Path", () => {
  let app;
  let sampleDocx;

  before(async () => {
    app = buildApp({ logger: false, apiKey: "test-key-read" });
    await app.ready();

    // Load valid DOCX fixture
    sampleDocx = await readFile("tests_and_others/tests/fixtures/sample.docx");
  });

  after(async () => {
    await app.close();
  });

  it("returns 200 with complete IR for valid DOCX", async () => {
    const { payload, contentType } = buildMultipartPayload("sample.docx", sampleDocx);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        authorization: "Bearer test-key-read",
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 200);
    assert.ok(
      res.headers["content-type"].includes("application/json"),
      `Expected application/json, got ${res.headers["content-type"]}`
    );
  });

  it("response includes metadata with correct structure", async () => {
    const { payload, contentType } = buildMultipartPayload("sample.docx", sampleDocx);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        authorization: "Bearer test-key-read",
        "content-type": contentType,
      },
    });

    const body = res.json();
    assert.ok(body.metadata, "Response has metadata");
    assert.equal(body.metadata.filename, "sample.docx");
    assert.equal(body.metadata.format, "full");
    assert.equal(typeof body.metadata.generated, "string");
    assert.equal(typeof body.metadata.version, "string");
    assert.equal(typeof body.metadata.blockCount, "number");
    assert.ok(body.metadata.blockCount > 0, "blockCount should be positive");
    assert.equal(typeof body.metadata.idsAssigned, "number");
  });

  it("response includes blocks array with content", async () => {
    const { payload, contentType } = buildMultipartPayload("sample.docx", sampleDocx);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        authorization: "Bearer test-key-read",
        "content-type": contentType,
      },
    });

    const body = res.json();
    assert.ok(body.blocks, "Response has blocks");
    assert.ok(Array.isArray(body.blocks), "blocks should be an array");
    assert.ok(body.blocks.length > 0, "blocks array should not be empty");
  });

  it("response includes outline array", async () => {
    const { payload, contentType } = buildMultipartPayload("sample.docx", sampleDocx);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        authorization: "Bearer test-key-read",
        "content-type": contentType,
      },
    });

    const body = res.json();
    assert.ok(body.outline, "Response has outline");
    assert.ok(Array.isArray(body.outline), "outline should be an array");
  });

  it("response includes idMapping object", async () => {
    const { payload, contentType } = buildMultipartPayload("sample.docx", sampleDocx);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        authorization: "Bearer test-key-read",
        "content-type": contentType,
      },
    });

    const body = res.json();
    assert.ok(body.idMapping, "Response has idMapping");
    assert.equal(typeof body.idMapping, "object", "idMapping should be an object");
    assert.ok(!Array.isArray(body.idMapping), "idMapping should not be an array");

    // Verify at least one UUID -> seqId mapping exists
    const keys = Object.keys(body.idMapping);
    assert.ok(keys.length > 0, "idMapping should have at least one entry");
  });

  it("response includes X-Request-Id header", async () => {
    const { payload, contentType } = buildMultipartPayload("sample.docx", sampleDocx);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        authorization: "Bearer test-key-read",
        "content-type": contentType,
      },
    });

    assert.ok(
      res.headers["x-request-id"],
      "Expected X-Request-Id header to be present"
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Validation Errors
// ---------------------------------------------------------------------------
describe("POST /v1/read - Validation Errors", () => {
  let app;

  before(async () => {
    app = buildApp({ logger: false, apiKey: "test-key-read" });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("returns 400 with MISSING_FILE when no file uploaded", async () => {
    const boundary = "----FormBoundary" + Date.now();
    const emptyPayload = `--${boundary}\r\n--${boundary}--\r\n`;

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload: emptyPayload,
      headers: {
        authorization: "Bearer test-key-read",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.error, "Response should have error property");
    assert.equal(body.error.code, "MISSING_FILE");
    assert.equal(typeof body.error.message, "string");
    assert.ok(Array.isArray(body.error.details), "details should be an array");
  });

  it("returns 400 with INVALID_FILE_TYPE for non-DOCX file (PNG magic bytes)", async () => {
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { payload, contentType } = buildMultipartPayload("fake.docx", pngBuffer);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        authorization: "Bearer test-key-read",
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error.code, "INVALID_FILE_TYPE");
    assert.ok(Array.isArray(body.error.details));
  });

  it("returns 422 with EXTRACTION_FAILED for corrupted DOCX", async () => {
    // Valid ZIP structure but invalid DOCX content (passes validation but fails extraction)
    // This is a minimal valid ZIP file with a single file 'test.xml' containing 'invalid content'
    const corruptedBuffer = Buffer.from(
      "UEsDBBQAAAAIAAAAAAAAAAAAFwAAAA8AAAAIAAAAdGVzdC54bWx4nMvMK0vMyUxRSM7PK0nNKwEAL8oGA1BLAQIUABQAAAAIAAAAAAAAAAAAFwAAAA8AAAAIAAAAAAAAAAAAAAAAAAAAAAB0ZXN0LnhtbFBLBQYAAAAAAQABADYAAAA9AAAAAAA=",
      "base64"
    );
    const { payload, contentType } = buildMultipartPayload("corrupt.docx", corruptedBuffer);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        authorization: "Bearer test-key-read",
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 422);
    const body = res.json();
    assert.equal(body.error.code, "EXTRACTION_FAILED");
    assert.equal(body.error.message, "Unable to process document");
    assert.ok(Array.isArray(body.error.details));

    // Verify no internal details are leaked
    const responseStr = JSON.stringify(body);
    assert.ok(
      !responseStr.includes("node_modules"),
      "Response should not expose internal paths"
    );
  });

  it("returns 400 with INVALID_CONTENT_TYPE for non-multipart Content-Type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload: { data: "not multipart" },
      headers: {
        authorization: "Bearer test-key-read",
        "content-type": "application/json",
      },
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error.code, "INVALID_CONTENT_TYPE");
    assert.ok(Array.isArray(body.error.details));
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Auth and Headers
// ---------------------------------------------------------------------------
describe("POST /v1/read - Auth and Headers", () => {
  let app;

  before(async () => {
    app = buildApp({ logger: false, apiKey: "test-key-read" });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const fakeBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const { payload, contentType } = buildMultipartPayload("test.docx", fakeBuffer);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        "content-type": contentType,
        // No authorization header
      },
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.ok(body.error, "Response should have error property");
    assert.equal(body.error.code, "UNAUTHORIZED");
  });

  it("returns 401 when Bearer token is invalid", async () => {
    const fakeBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const { payload, contentType } = buildMultipartPayload("test.docx", fakeBuffer);

    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        authorization: "Bearer wrong-key",
        "content-type": contentType,
      },
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, "UNAUTHORIZED");
    assert.ok(Array.isArray(body.error.details));
  });

  it("error responses include X-Request-Id header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/read",
      headers: {
        authorization: "Bearer test-key-read",
        "content-type": "application/json", // Wrong content-type
      },
    });

    assert.equal(res.statusCode, 400);
    assert.ok(
      res.headers["x-request-id"],
      "Expected X-Request-Id on error response"
    );
  });
});
