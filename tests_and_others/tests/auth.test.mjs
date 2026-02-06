import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import buildApp from "../../src/app.mjs";
import { requireMultipart } from "../../src/hooks/content-type-check.mjs";

// ---------------------------------------------------------------------------
// Suite 1: Authentication (AUTH-01, AUTH-02)
// ---------------------------------------------------------------------------
describe("Authentication", () => {
  let app;

  before(async () => {
    app = buildApp({ logger: false, apiKey: "test-api-key-12345" });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("GET /v1/health with valid Bearer token returns 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer test-api-key-12345" },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  });

  it("GET /v1/health without Authorization header returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, "UNAUTHORIZED");
    assert.equal(body.error.message, "Invalid or missing API key");
    assert.deepEqual(body.error.details, []);
  });

  it("GET /v1/health with wrong API key returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer wrong-key" },
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, "UNAUTHORIZED");
    assert.equal(body.error.message, "Invalid or missing API key");
  });

  it("GET /v1/health with malformed auth header returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "test-api-key-12345" }, // Missing "Bearer " prefix
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, "UNAUTHORIZED");
  });

  it("401 response message never reveals WHY auth failed", async () => {
    // Test multiple failure scenarios - message should be identical
    const wrongKey = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer wrong-key" },
    });

    const missingAuth = await app.inject({
      method: "GET",
      url: "/v1/health",
    });

    const malformed = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "NotBearer test-api-key-12345" },
    });

    // All should have identical message (no info leak about failure reason)
    const message1 = wrongKey.json().error.message;
    const message2 = missingAuth.json().error.message;
    const message3 = malformed.json().error.message;

    assert.equal(message1, "Invalid or missing API key");
    assert.equal(message2, "Invalid or missing API key");
    assert.equal(message3, "Invalid or missing API key");
  });

  it("GET /health (root) works without auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Content-Type Validation (AUTH-04)
// ---------------------------------------------------------------------------
describe("Content-Type Validation", () => {
  let app;

  before(async () => {
    app = buildApp({ logger: false, apiKey: "test-api-key-12345" });

    // Register test route with requireMultipart hook in protected scope
    app.register(async function protectedTestRoute(scope) {
      // Apply auth to this scope
      scope.addHook("onRequest", async (request, reply) => {
        const authHeader = request.headers.authorization;
        if (!authHeader || authHeader !== "Bearer test-api-key-12345") {
          reply.status(401).send({
            error: {
              code: "UNAUTHORIZED",
              message: "Invalid or missing API key",
              details: [],
            },
          });
        }
      });

      // Test route with requireMultipart preHandler
      // Note: multipart plugin is now registered globally (Phase 3), so no need
      // to override content type parser here
      scope.post("/test-upload", {
        preHandler: requireMultipart,
      }, async (request, reply) => {
        return { success: true };
      });
    }, { prefix: "/v1" });

    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("POST /v1/test-upload with application/json returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/test-upload",
      headers: {
        authorization: "Bearer test-api-key-12345",
        "content-type": "application/json",
      },
      payload: { test: "data" },
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error.code, "INVALID_CONTENT_TYPE");
    assert.equal(body.error.message, "Content-Type must be multipart/form-data");
    assert.deepEqual(body.error.details, []);
  });

  it("POST /v1/test-upload with no Content-Type returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/test-upload",
      headers: {
        authorization: "Bearer test-api-key-12345",
      },
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error.code, "INVALID_CONTENT_TYPE");
  });

  it("POST /v1/test-upload with multipart/form-data passes preHandler", async () => {
    const boundary = "----WebKitFormBoundary1234567890";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="test"',
      '',
      'test-value',
      `--${boundary}--`,
      ''
    ].join('\r\n');

    const res = await app.inject({
      method: "POST",
      url: "/v1/test-upload",
      headers: {
        authorization: "Bearer test-api-key-12345",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    // Route handler should execute (returns {success: true})
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { success: true });
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Error Sanitization (AUTH-06)
// ---------------------------------------------------------------------------
describe("Error Sanitization", () => {
  let app;

  before(async () => {
    app = buildApp({ logger: false, apiKey: "test-api-key-12345" });

    // Register test routes that throw errors with internal details
    app.register(async function testErrorRoutes(scope) {
      // Apply basic auth for this scope
      scope.addHook("onRequest", async (request, reply) => {
        const authHeader = request.headers.authorization;
        if (!authHeader || authHeader !== "Bearer test-api-key-12345") {
          reply.status(401).send({
            error: {
              code: "UNAUTHORIZED",
              message: "Invalid or missing API key",
              details: [],
            },
          });
        }
      });

      // Route throwing error with file path
      scope.get("/test-error-filepath", async () => {
        throw new Error("ENOENT: no such file or directory, open '/src/app.mjs'");
      });

      // Route throwing error with stack trace pattern
      scope.get("/test-error-stack", async () => {
        const err = new Error("Failed to process");
        err.stack = "Error: Failed at processFile (src/processor.mjs:42:15)";
        throw err;
      });

      // Route throwing 4xx error with unsafe message
      scope.get("/test-400-unsafe", async () => {
        const err = new Error("Cannot read file /home/user/config.json");
        err.statusCode = 400;
        throw err;
      });

      // Route throwing 4xx error with safe message
      scope.get("/test-400-safe", async () => {
        const err = new Error("Invalid input");
        err.statusCode = 400;
        throw err;
      });
    }, { prefix: "/v1" });

    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("500 error with file path does not expose path in response", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/test-error-filepath",
      headers: { authorization: "Bearer test-api-key-12345" },
    });

    assert.equal(res.statusCode, 500);
    const body = res.json();
    const responseStr = JSON.stringify(body);

    // Should NOT contain file path
    assert.ok(!responseStr.includes("/src/"), "Response should not contain /src/");
    assert.ok(!responseStr.includes(".mjs"), "Response should not contain .mjs");
    assert.ok(!responseStr.includes("ENOENT"), "Response should not contain ENOENT");
  });

  it("500 error with stack trace does not expose stack in response", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/test-error-stack",
      headers: { authorization: "Bearer test-api-key-12345" },
    });

    assert.equal(res.statusCode, 500);
    const body = res.json();
    const responseStr = JSON.stringify(body);

    // Should NOT contain stack trace patterns
    assert.ok(!responseStr.includes("at "), "Response should not contain stack trace");
    assert.ok(!responseStr.includes("processFile"), "Response should not contain function name");
    assert.ok(!responseStr.includes("processor.mjs"), "Response should not contain file name");
  });

  it("500 error message is always generic", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/test-error-filepath",
      headers: { authorization: "Bearer test-api-key-12345" },
    });

    const body = res.json();
    assert.equal(body.error.message, "An internal server error occurred");
  });

  it("4xx error with unsafe message is scrubbed", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/test-400-unsafe",
      headers: { authorization: "Bearer test-api-key-12345" },
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    const responseStr = JSON.stringify(body);

    // Should NOT contain file path
    assert.ok(!responseStr.includes("/home/user"), "Response should not contain file path");
    assert.ok(!responseStr.includes("config.json"), "Response should not contain file name");

    // Should be scrubbed to generic message
    assert.equal(body.error.message, "Bad request");
  });

  it("4xx error with safe message passes through unchanged", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/test-400-safe",
      headers: { authorization: "Bearer test-api-key-12345" },
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();

    // Safe message should pass through
    assert.equal(body.error.message, "Invalid input");
  });
});
