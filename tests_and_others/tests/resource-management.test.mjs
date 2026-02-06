import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Editor } from "@harbour-enterprises/superdoc/super-editor";
import buildApp from "../../src/app.mjs";
import { createHeadlessEditor } from "../../src/editorFactory.mjs";

/**
 * Build a valid multipart/form-data payload with a single `file` part.
 *
 * @param {string} filename
 * @param {Buffer} buffer
 * @returns {{payload: Buffer, contentType: string}}
 */
function buildMultipartPayload(filename, buffer) {
  const boundary = "----FormBoundary" + Date.now();
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

  return {
    payload: Buffer.concat([header, buffer, footer]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Check whether a promise settles within a time budget.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
async function settlesWithin(promise, ms) {
  const timeoutSentinel = Symbol("timeout");
  const result = await Promise.race([
    promise.then(() => true, () => true),
    delay(ms, timeoutSentinel),
  ]);
  return result !== timeoutSentinel;
}

const CORRUPTED_DOCX_BUFFER = Buffer.from(
  "UEsDBBQAAAAIAAAAAAAAAAAAFwAAAA8AAAAIAAAAdGVzdC54bWx4nMvMK0vMyUxRSM7PK0nNKwEAL8oGA1BLAQIUABQAAAAIAAAAAAAAAAAAFwAAAA8AAAAIAAAAAAAAAAAAAAAAAAAAAAB0ZXN0LnhtbFBLBQYAAAAAAQABADYAAAA9AAAAAAA=",
  "base64"
);

// ---------------------------------------------------------------------------
// Suite 1: Editor Factory Cleanup Contract
// ---------------------------------------------------------------------------
describe("Resource Management - Editor Factory Cleanup", () => {
  let sampleDocx;

  before(async () => {
    sampleDocx = await readFile("tests_and_others/tests/fixtures/sample.docx");
  });

  it("createHeadlessEditor returns {editor, cleanup} and cleanup destroys editor", async () => {
    const originalDestroy = Editor.prototype.destroy;
    let destroyCalls = 0;

    Editor.prototype.destroy = function patchedDestroy(...args) {
      destroyCalls += 1;
      return originalDestroy.apply(this, args);
    };

    try {
      const result = await createHeadlessEditor(sampleDocx);
      assert.ok(result.editor, "expected editor instance");
      assert.equal(typeof result.cleanup, "function", "expected cleanup function");

      assert.doesNotThrow(() => result.cleanup());
      assert.ok(destroyCalls >= 1, "cleanup should call editor.destroy()");
      assert.doesNotThrow(() => result.cleanup(), "cleanup should be idempotent");
    } finally {
      Editor.prototype.destroy = originalDestroy;
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Concurrency Limiter + onResponse Cleanup Hook
// ---------------------------------------------------------------------------
describe("Resource Management - Concurrency Limiter Integration", () => {
  let app;
  let sampleDocx;
  let cleanupCalls = 0;
  const originalMaxConcurrency = process.env.MAX_DOCUMENT_CONCURRENCY;

  before(async () => {
    process.env.MAX_DOCUMENT_CONCURRENCY = "1";
    app = buildApp({ logger: false, apiKey: "test-key-resource" });

    app.post("/test-resource-cleanup", async (request, reply) => {
      await app.documentSemaphore.acquire();
      request.editorCleanup = () => {
        cleanupCalls += 1;
      };
      return reply.send({ ok: true });
    });

    await app.ready();
    sampleDocx = await readFile("tests_and_others/tests/fixtures/sample.docx");
  });

  after(async () => {
    await app.close();

    if (originalMaxConcurrency === undefined) {
      delete process.env.MAX_DOCUMENT_CONCURRENCY;
    } else {
      process.env.MAX_DOCUMENT_CONCURRENCY = originalMaxConcurrency;
    }
  });

  it("decorates app with documentSemaphore acquire/release", () => {
    assert.ok(app.documentSemaphore, "app.documentSemaphore should exist");
    assert.equal(typeof app.documentSemaphore.acquire, "function");
    assert.equal(typeof app.documentSemaphore.release, "function");
  });

  it("queues requests beyond maxConcurrency instead of rejecting", async () => {
    await app.documentSemaphore.acquire();

    const { payload, contentType } = buildMultipartPayload("sample.docx", sampleDocx);
    const pendingRequest = app.inject({
      method: "POST",
      url: "/v1/read",
      payload,
      headers: {
        authorization: "Bearer test-key-resource",
        "content-type": contentType,
      },
    });

    const settledWhileLocked = await settlesWithin(pendingRequest, 75);
    assert.equal(settledWhileLocked, false, "request should wait in semaphore queue");

    app.documentSemaphore.release();

    const res = await pendingRequest;
    assert.equal(res.statusCode, 200);
  });

  it("onResponse hook runs editorCleanup and releases semaphore", async () => {
    cleanupCalls = 0;

    const res = await app.inject({
      method: "POST",
      url: "/test-resource-cleanup",
    });

    assert.equal(res.statusCode, 200);
    assert.equal(cleanupCalls, 1, "expected editorCleanup to run on response");

    const acquireProbe = app.documentSemaphore.acquire();
    const acquired = await settlesWithin(acquireProbe, 75);
    assert.equal(acquired, true, "semaphore should be released in onResponse hook");
    if (acquired) {
      app.documentSemaphore.release();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Sequential Request Resource Lifecycle
// ---------------------------------------------------------------------------
describe("Resource Management - Sequential Success Requests", () => {
  let app;
  let sampleDocx;

  before(async () => {
    app = buildApp({ logger: false, apiKey: "test-key-resource" });
    await app.ready();
    sampleDocx = await readFile("tests_and_others/tests/fixtures/sample.docx");
  });

  after(async () => {
    await app.close();
  });

  it("handles three sequential valid /v1/read requests without leaking semaphore permits", async () => {
    for (let i = 0; i < 3; i += 1) {
      const { payload, contentType } = buildMultipartPayload(`sample-${i}.docx`, sampleDocx);
      const res = await app.inject({
        method: "POST",
        url: "/v1/read",
        payload,
        headers: {
          authorization: "Bearer test-key-resource",
          "content-type": contentType,
        },
      });

      assert.equal(res.statusCode, 200, `request ${i + 1} should succeed`);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Error Path Cleanup
// ---------------------------------------------------------------------------
describe("Resource Management - Error Path Cleanup", () => {
  let app;
  let sampleDocx;

  before(async () => {
    app = buildApp({ logger: false, apiKey: "test-key-resource" });
    await app.ready();
    sampleDocx = await readFile("tests_and_others/tests/fixtures/sample.docx");
  });

  after(async () => {
    await app.close();
  });

  it("returns 422 for corrupt DOCX then still processes valid DOCX", async () => {
    const corrupt = buildMultipartPayload("corrupt.docx", CORRUPTED_DOCX_BUFFER);
    const failed = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload: corrupt.payload,
      headers: {
        authorization: "Bearer test-key-resource",
        "content-type": corrupt.contentType,
      },
    });

    assert.equal(failed.statusCode, 422);
    assert.equal(failed.json().error.code, "EXTRACTION_FAILED");

    const valid = buildMultipartPayload("sample.docx", sampleDocx);
    const recovered = await app.inject({
      method: "POST",
      url: "/v1/read",
      payload: valid.payload,
      headers: {
        authorization: "Bearer test-key-resource",
        "content-type": valid.contentType,
      },
    });

    assert.equal(recovered.statusCode, 200);
  });
});
