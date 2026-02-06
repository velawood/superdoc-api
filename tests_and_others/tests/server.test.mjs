import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import buildApp from "../../src/app.mjs";

/**
 * UUID v4 format regex (lowercase hex, 8-4-4-4-12).
 * Fastify's crypto.randomUUID() always produces lowercase.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Suite 1: Health Check (INFRA-01)
// ---------------------------------------------------------------------------
describe("Health Check", () => {
  let app;

  before(async () => {
    app = buildApp({ logger: false, apiKey: 'test-key' });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("GET /health returns 200 with {status:ok}", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  });

  it("GET /v1/health returns 200 with {status:ok}", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer test-key" }
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  });

  it("Response Content-Type is application/json", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });

    assert.ok(
      res.headers["content-type"].includes("application/json"),
      `Expected application/json, got ${res.headers["content-type"]}`
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Request ID Tracing (INFRA-02)
// ---------------------------------------------------------------------------
describe("Request ID Tracing", () => {
  let app;

  before(async () => {
    app = buildApp({ logger: false, apiKey: 'test-key' });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("Response includes X-Request-Id header", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });

    assert.ok(
      res.headers["x-request-id"],
      "Expected X-Request-Id header to be present"
    );
  });

  it("X-Request-Id is a valid UUID v4 format", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    const requestId = res.headers["x-request-id"];

    assert.match(requestId, UUID_RE, `Expected UUID format, got ${requestId}`);
  });

  it("Client-provided X-Request-Id is echoed back unchanged", async () => {
    const clientId = "my-custom-request-id-12345";
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": clientId },
    });

    assert.equal(res.headers["x-request-id"], clientId);
  });

  it("Each request gets a unique X-Request-Id when not provided", async () => {
    const [res1, res2, res3] = await Promise.all([
      app.inject({ method: "GET", url: "/health" }),
      app.inject({ method: "GET", url: "/health" }),
      app.inject({ method: "GET", url: "/health" }),
    ]);

    const ids = new Set([
      res1.headers["x-request-id"],
      res2.headers["x-request-id"],
      res3.headers["x-request-id"],
    ]);

    assert.equal(ids.size, 3, "Expected 3 distinct request IDs");
  });

  it("Error responses also include X-Request-Id", async () => {
    const res = await app.inject({ method: "GET", url: "/nonexistent" });

    assert.equal(res.statusCode, 404);
    assert.ok(
      res.headers["x-request-id"],
      "Expected X-Request-Id on 404 response"
    );
    assert.match(
      res.headers["x-request-id"],
      UUID_RE,
      "Expected UUID format on error response"
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Structured Errors (INFRA-03)
// ---------------------------------------------------------------------------
describe("Structured Errors", () => {
  let app;

  before(async () => {
    app = buildApp({ logger: false, apiKey: 'test-key' });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("Unknown route returns {error: {code: NOT_FOUND, message, details: []}}", async () => {
    const res = await app.inject({ method: "GET", url: "/nonexistent" });
    const body = res.json();

    assert.ok(body.error, "Response should have error property");
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(typeof body.error.message, "string");
    assert.ok(Array.isArray(body.error.details), "details should be an array");
    assert.equal(body.error.details.length, 0);
  });

  it("error.message includes the method and URL attempted", async () => {
    const res = await app.inject({ method: "DELETE", url: "/some/path" });
    const body = res.json();

    assert.ok(
      body.error.message.includes("DELETE"),
      `Expected message to include 'DELETE', got: ${body.error.message}`
    );
    assert.ok(
      body.error.message.includes("/some/path"),
      `Expected message to include '/some/path', got: ${body.error.message}`
    );
  });

  it("error.details is always an array (even if empty)", async () => {
    const res = await app.inject({ method: "GET", url: "/nonexistent" });
    const body = res.json();

    assert.ok(Array.isArray(body.error.details));
  });
});

// ---------------------------------------------------------------------------
// Suite 4: HTTP Status Codes (INFRA-04)
// ---------------------------------------------------------------------------
describe("HTTP Status Codes", () => {
  let app;

  before(async () => {
    app = buildApp({ logger: false, apiKey: 'test-key' });

    // Register test routes at root level (unprotected, for error testing)
    app.get("/test-error", async () => {
      throw new Error("test boom");
    });

    app.post("/test-validate", {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    }, async (request) => ({ ok: true }));

    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("Unknown route returns HTTP 404", async () => {
    const res = await app.inject({ method: "GET", url: "/nonexistent" });

    assert.equal(res.statusCode, 404);
  });

  it("Server error returns HTTP 500", async () => {
    const res = await app.inject({ method: "GET", url: "/test-error" });

    assert.equal(res.statusCode, 500);
  });

  it("500 error message is generic, not the actual error", async () => {
    const res = await app.inject({ method: "GET", url: "/test-error" });
    const body = res.json();

    assert.equal(body.error.message, "An internal server error occurred");
    assert.ok(
      !JSON.stringify(body).includes("test boom"),
      "Response should not expose internal error message"
    );
  });

  it("Validation error returns HTTP 400 with details array", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test-validate",
      payload: { wrong: "field" },
    });

    assert.equal(res.statusCode, 400);

    const body = res.json();
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.ok(
      Array.isArray(body.error.details),
      "details should be an array"
    );
    assert.ok(
      body.error.details.length > 0,
      "details should contain validation errors"
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 5: API Versioning (INFRA-07)
// ---------------------------------------------------------------------------
describe("API Versioning", () => {
  let app;

  before(async () => {
    app = buildApp({ logger: false, apiKey: 'test-key' });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("GET /v1/health returns 200 (endpoints exist under /v1/)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer test-key" }
    });

    assert.equal(res.statusCode, 200);
  });

  it("GET /v2/health returns 404 (only v1 exists)", async () => {
    const res = await app.inject({ method: "GET", url: "/v2/health" });

    assert.equal(res.statusCode, 404);
  });
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------
describe("Edge Cases", () => {
  let app;

  before(async () => {
    app = buildApp({ logger: false, apiKey: 'test-key' });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("Multiple rapid requests get distinct X-Request-Id values", async () => {
    const requests = Array.from({ length: 10 }, () =>
      app.inject({ method: "GET", url: "/health" })
    );
    const responses = await Promise.all(requests);
    const ids = new Set(responses.map((r) => r.headers["x-request-id"]));

    assert.equal(ids.size, 10, "Expected 10 distinct request IDs");
  });

  it("X-Request-Id with non-UUID value from client is still echoed", async () => {
    const clientId = "not-a-uuid-just-a-string";
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": clientId },
    });

    assert.equal(res.headers["x-request-id"], clientId);
  });

  it("POST to /health returns 404 (only GET is defined)", async () => {
    const res = await app.inject({ method: "POST", url: "/health" });

    assert.equal(res.statusCode, 404);
  });
});
