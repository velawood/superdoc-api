# Phase 2: Auth and Error Handling - Research

**Researched:** 2026-02-06
**Domain:** Fastify 5 API key authentication, content-type validation, error sanitization
**Confidence:** HIGH

## Summary

Phase 2 adds three security layers to the existing Fastify 5 server: (1) API key authentication via Bearer token with timing-safe comparison, (2) Content-Type validation requiring multipart/form-data for upload endpoints, and (3) hardened error sanitization ensuring no internal details leak in any response. These requirements map to AUTH-01, AUTH-02, AUTH-04, and AUTH-06.

The standard approach uses `@fastify/bearer-auth` v10.x (official Fastify plugin, compatible with Fastify 5) for Bearer token authentication with built-in timing-safe comparison. The plugin is registered inside a scoped plugin context that contains all protected `/v1/` API routes, leaving health endpoints unprotected. Content-Type validation uses a route-level `preHandler` hook on upload endpoints. Error sanitization builds on the existing `error-handler.mjs` plugin from Phase 1, which already suppresses internal messages for 5xx errors.

The project already has the foundational pieces: `fastify-plugin` for global hooks, a structured error format (`{error: {code, message, details}}`), and the app factory pattern. Phase 2 extends these without breaking existing behavior.

**Primary recommendation:** Use `@fastify/bearer-auth` v10.x for authentication (scoped to protected routes via Fastify's encapsulation), a simple `preHandler` hook for Content-Type checks on upload routes, and strengthen the existing error handler to scrub all error properties.

## Standard Stack

The established libraries/tools for this phase:

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @fastify/bearer-auth | ^10.1.2 | Bearer token auth with timing-safe comparison | Official Fastify plugin; built-in constant-time key comparison; encapsulation-aware; Fastify 5 compatible |
| fastify-plugin | ^5.1.0 (already installed) | Non-encapsulated plugin wrapping | Already used in Phase 1; needed for global error handler |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:crypto | built-in | timingSafeEqual for custom auth if needed | Only if bypassing @fastify/bearer-auth for custom auth logic |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @fastify/bearer-auth | Hand-rolled onRequest hook with crypto.timingSafeEqual | @fastify/bearer-auth already handles timing-safe comparison, header parsing, error responses, and spec compliance. Hand-rolling requires re-implementing all of this. Use the plugin. |
| @fastify/bearer-auth | @fastify/auth + custom strategy | Overkill for single-strategy API key auth. @fastify/auth is for combining multiple auth strategies (JWT + Bearer + anonymous). Not needed here. |
| Scoped plugin registration | Global hook with URL allowlist | Scoped registration uses Fastify's native encapsulation. URL allowlists are fragile and error-prone as routes change. Use encapsulation. |

**Installation:**

```bash
npm install @fastify/bearer-auth
```

## Architecture Patterns

### Recommended Project Structure (additions to Phase 1)

```
src/
  app.mjs                  # Modified: register auth scoped to /v1 protected routes
  server.mjs               # Unchanged
  plugins/
    request-id.mjs         # Unchanged (global via fastify-plugin)
    error-handler.mjs      # Modified: strengthen sanitization
    auth.mjs               # NEW: bearer auth configuration plugin
  hooks/
    content-type-check.mjs # NEW: multipart/form-data validation preHandler
  routes/
    health.mjs             # Unchanged (remains unprotected)
```

### Pattern 1: Scoped Authentication via Fastify Encapsulation

**What:** Register `@fastify/bearer-auth` inside a scoped plugin that contains all protected routes. Routes outside the scope (health endpoints) remain unprotected.
**When to use:** When some routes need auth and others do not.
**Why this works:** Fastify's encapsulation model naturally scopes hooks. Plugins registered with `fastify-plugin` are global; normal plugins are scoped. `@fastify/bearer-auth` is a normal plugin, so it only applies to routes in its registration context.
**Source:** @fastify/bearer-auth README (https://github.com/fastify/fastify-bearer-auth)

```javascript
// src/app.mjs
import Fastify from "fastify";
import crypto from "node:crypto";
import requestIdPlugin from "./plugins/request-id.mjs";
import errorHandlerPlugin from "./plugins/error-handler.mjs";
import healthRoutes from "./routes/health.mjs";
import authPlugin from "./plugins/auth.mjs";

export default function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger !== undefined
      ? opts.logger
      : { level: process.env.LOG_LEVEL || "info" },
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  // Global plugins (apply everywhere via fastify-plugin)
  app.register(requestIdPlugin);
  app.register(errorHandlerPlugin);

  // Health at root level (unprotected, for infrastructure probes)
  app.register(healthRoutes);

  // Protected /v1 scope: auth + API routes
  app.register(async function protectedRoutes(scope) {
    // Register auth -- scoped to this plugin context only
    scope.register(authPlugin);

    // Health under /v1 (also protected by auth since it's in scope)
    // OR register health outside this scope if it should be unprotected
    scope.register(healthRoutes);

    // Future: upload routes, read routes, etc.
  }, { prefix: "/v1" });

  return app;
}
```

**Design decision: Should /v1/health require auth?**
Option A: `/v1/health` inside protected scope (requires Bearer token). Root `/health` remains unprotected for infrastructure probes.
Option B: `/v1/health` outside protected scope (unprotected). Both health endpoints skip auth.
**Recommendation:** Option A is simpler and cleaner. Infrastructure probes use `/health` (no auth). API clients calling `/v1/health` provide their key like any other `/v1/` endpoint. This avoids carving out exceptions.

### Pattern 2: Bearer Auth Plugin Configuration

**What:** Configure `@fastify/bearer-auth` to use the project's structured error format and read the API key from an environment variable.
**When to use:** For the auth plugin setup.
**Source:** @fastify/bearer-auth README (https://github.com/fastify/fastify-bearer-auth)

```javascript
// src/plugins/auth.mjs

/**
 * Auth plugin - Bearer token authentication for API endpoints.
 *
 * NOT wrapped with fastify-plugin. This is intentionally encapsulated
 * so it only applies to the plugin scope where it is registered.
 *
 * Reads API_KEY from environment variable. If not set, the server
 * refuses to start (fail-fast).
 *
 * @param {import("fastify").FastifyInstance} fastify
 * @param {object} opts
 */
import bearerAuth from "@fastify/bearer-auth";

async function authPlugin(fastify, opts) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY environment variable is required");
  }

  fastify.register(bearerAuth, {
    keys: new Set([apiKey]),
    errorResponse: (err) => ({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid or missing API key",
        details: [],
      },
    }),
  });
}

export default authPlugin;
```

**Key points:**
- NOT wrapped with `fastify-plugin` (intentionally scoped)
- Fail-fast if API_KEY is not set (server won't start)
- Custom `errorResponse` matches the project's structured error format
- The error message is deliberately generic ("Invalid or missing API key") -- does not reveal whether the key was missing, malformed, or wrong (AUTH-02)
- `@fastify/bearer-auth` uses constant-time comparison internally (AUTH-01)

### Pattern 3: Content-Type Validation as Route-Level preHandler

**What:** A reusable `preHandler` hook function that checks the Content-Type header for multipart/form-data. Applied per-route on upload endpoints.
**When to use:** On POST routes that accept file uploads (Phase 3+).
**Why preHandler, not onRequest:** The Content-Type check is route-specific, not global. Using a preHandler function attached to individual routes is cleaner than a global hook with URL matching.
**Source:** Fastify Hooks docs (https://fastify.dev/docs/latest/Reference/Hooks/)

```javascript
// src/hooks/content-type-check.mjs

/**
 * PreHandler hook that validates Content-Type is multipart/form-data.
 * Attach to individual upload routes as a route-level preHandler.
 *
 * @param {import("fastify").FastifyRequest} request
 * @param {import("fastify").FastifyReply} reply
 */
export async function requireMultipart(request, reply) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data")) {
    reply.status(400).send({
      error: {
        code: "INVALID_CONTENT_TYPE",
        message: "Content-Type must be multipart/form-data",
        details: [],
      },
    });
    return reply;
  }
}
```

**Usage on a route:**
```javascript
import { requireMultipart } from "../hooks/content-type-check.mjs";

fastify.post("/v1/read", {
  preHandler: requireMultipart,
}, async (request, reply) => {
  // Handle upload...
});
```

### Pattern 4: Strengthened Error Sanitization

**What:** Enhance the existing error-handler.mjs to ensure no internal details ever leak, including for 4xx errors that might contain library-specific messages.
**When to use:** Globally (already applied via fastify-plugin).
**Source:** Fastify Errors docs (https://fastify.dev/docs/latest/Reference/Errors/), Fastify Issue #4513

The Phase 1 error handler already:
- Returns generic message for 5xx errors ("An internal server error occurred")
- Returns `error.message` for 4xx errors
- Formats validation errors with field-level details

What needs strengthening for AUTH-06:
1. **Sanitize 4xx error messages** -- Fastify's built-in errors (like content-type parser errors) may include internal details. Check and sanitize these.
2. **Strip error properties** -- Never include `error.stack`, file paths, or library names in the response.
3. **Whitelist safe error codes** -- Map known error codes to safe messages instead of passing through raw error messages.

```javascript
// Enhanced error-handler.mjs additions:

// Safe error code mapping
const SAFE_ERRORS = {
  UNAUTHORIZED: { status: 401, message: "Invalid or missing API key" },
  INVALID_CONTENT_TYPE: { status: 400, message: "Content-Type must be multipart/form-data" },
  VALIDATION_ERROR: { status: 400 },  // uses Fastify validation details
  NOT_FOUND: { status: 404 },
  // Fastify internal codes to sanitize:
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, message: "Unsupported media type" },
  FST_ERR_CTP_EMPTY_TYPE: { status: 400, message: "Missing Content-Type header" },
};

// In the error handler, sanitize the message:
const safeError = SAFE_ERRORS[error.code];
const message = safeError?.message
  || (statusCode >= 500 ? "An internal server error occurred" : error.message);

// Additional safety: scan message for path-like patterns and stack-trace patterns
function isSafeMessage(msg) {
  if (!msg || typeof msg !== "string") return false;
  // Reject if contains file paths, stack traces, or module references
  if (/\/(src|node_modules|dist)\//i.test(msg)) return false;
  if (/at\s+\w+\s+\(/i.test(msg)) return false;
  if (/\.mjs:|\.js:|\.ts:/i.test(msg)) return false;
  return true;
}
```

### Anti-Patterns to Avoid

- **Global auth hook with URL allowlist**: Do NOT register auth globally and then skip health endpoints via `if (request.url === '/health') return`. This is fragile, breaks when routes change, and fights Fastify's encapsulation model. Use scoped plugin registration instead.
- **Wrapping auth plugin with fastify-plugin**: Do NOT wrap the auth plugin with `fastify-plugin`. That would make it global and protect health endpoints too. The auth plugin should be intentionally encapsulated.
- **Passing through raw error.message for all errors**: Fastify internal errors (FST_ERR_*) contain implementation details. Always sanitize or map error messages before sending to clients.
- **Checking API key with === instead of timing-safe comparison**: Even for single-key validation, use timing-safe comparison to prevent timing attacks. `@fastify/bearer-auth` handles this automatically.
- **Storing API key in source code**: Always read from environment variable. Fail-fast if not set.

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Bearer token parsing | Manual header.split(" ") and key extraction | @fastify/bearer-auth | Handles edge cases: missing header, malformed header, case sensitivity, spec compliance (RFC 6749/6750) |
| Timing-safe string comparison | Manual crypto.timingSafeEqual with Buffer conversion | @fastify/bearer-auth (built-in) | Plugin handles Buffer length matching internally; manual impl requires padding or hashing to equalize lengths |
| Route scoping for auth | URL allowlists or conditional checks in global hooks | Fastify encapsulation (scoped plugin registration) | Built into Fastify's architecture; impossible to misconfigure if using scoped registration |
| Error response format | Custom error serializer per endpoint | Global setErrorHandler with structured format | Already established in Phase 1; extend, don't duplicate |

**Key insight:** `@fastify/bearer-auth` is 10 lines of configuration versus 50+ lines of hand-rolled auth code that would need to handle header parsing, timing-safe comparison, Buffer length equalization, error responses, and spec compliance. The plugin is maintained by the Fastify team and is their recommended approach.

## Common Pitfalls

### Pitfall 1: Timing Attack via === Comparison

**What goes wrong:** API key is compared using `===` or `==`, allowing attackers to determine correct characters one at a time by measuring response time.
**Why it happens:** String equality in JavaScript short-circuits on first mismatch, creating measurable timing differences.
**How to avoid:** Use `@fastify/bearer-auth` which performs constant-time comparison internally. If hand-rolling, use `crypto.timingSafeEqual` with equal-length Buffers.
**Warning signs:** Using `===` or `.includes()` for API key comparison anywhere in the codebase.
**Confidence:** HIGH (well-documented attack vector; Node.js crypto docs explicitly address this)

### Pitfall 2: Auth Plugin Wrapped with fastify-plugin (Global Leak)

**What goes wrong:** Wrapping the auth plugin with `fastify-plugin` makes authentication global, blocking health check endpoints.
**Why it happens:** Developer follows Phase 1 pattern where `fastify-plugin` was correct for request-id and error-handler (they should be global). Auth should NOT be global.
**How to avoid:** Do NOT import or use `fastify-plugin` for the auth plugin. The auth plugin must be a plain async function, NOT wrapped with `fp()`. Only register it in the scoped context that contains protected routes.
**Warning signs:** Health endpoint returning 401. Infrastructure probes failing.
**Confidence:** HIGH (verified via Fastify Hooks docs -- "all hooks are encapsulated" except when using fastify-plugin)

### Pitfall 3: Error Message Leaking Internal Details

**What goes wrong:** A 4xx error response includes a Fastify internal error message like "Unsupported Media Type: application/octet-stream" or a library stack trace.
**Why it happens:** The Phase 1 error handler passes `error.message` through for non-500 errors. Fastify's built-in errors (FST_ERR_*) contain implementation details.
**How to avoid:** Sanitize ALL error messages before sending. Use a whitelist of known safe error codes mapped to safe messages. For unknown errors, use a generic message.
**Warning signs:** Error responses containing file paths, module names, or Fastify error code prefixes in the message field.
**Confidence:** HIGH (verified via Fastify Issue #4513 -- known issue with Fastify's default error handler exposing internals)

### Pitfall 4: Missing API_KEY Silently Disabling Auth

**What goes wrong:** Server starts without API_KEY environment variable, and all routes become either unprotected or always return 401.
**Why it happens:** No validation that the environment variable is set at startup.
**How to avoid:** Fail-fast: throw an error during plugin registration if `process.env.API_KEY` is falsy. The server should refuse to start without a configured API key.
**Warning signs:** Server starts with a warning but no auth enforcement.
**Confidence:** HIGH (standard practice for required configuration)

### Pitfall 5: crypto.timingSafeEqual Buffer Length Mismatch

**What goes wrong:** `crypto.timingSafeEqual(a, b)` throws if Buffers have different lengths, crashing the server or leaking the length of the valid key.
**Why it happens:** API keys from different sources may have different byte lengths. Directly converting to Buffers and comparing will throw.
**How to avoid:** Use `@fastify/bearer-auth` which handles this internally. If hand-rolling, hash both values with SHA-256 first (producing equal-length digests) then compare the hashes.
**Warning signs:** Unhandled exceptions in the auth layer.
**Confidence:** HIGH (verified via Node.js crypto.timingSafeEqual docs -- "throws an error if the length of a does not equal the length of b")

### Pitfall 6: Content-Type Check Not Returning reply

**What goes wrong:** The preHandler hook sends a 400 response but does not `return reply`, causing Fastify to continue processing the request and potentially sending a second response.
**Why it happens:** Fastify requires `return reply` (or a thrown error) from async hooks that send early responses. Without it, Fastify assumes the hook completed normally and continues to the route handler.
**How to avoid:** Always `return reply` after calling `reply.send()` in an async hook.
**Warning signs:** "Reply already sent" warnings in logs. Double responses.
**Confidence:** HIGH (verified via Fastify Hooks docs -- "make sure to always return reply")

## Code Examples

Verified patterns from official sources:

### Complete Auth Plugin

```javascript
// src/plugins/auth.mjs
// Source: @fastify/bearer-auth README + Fastify Hooks docs
import bearerAuth from "@fastify/bearer-auth";

async function authPlugin(fastify, opts) {
  const apiKey = opts.apiKey || process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY environment variable is required");
  }

  fastify.register(bearerAuth, {
    keys: new Set([apiKey]),
    errorResponse: (err) => ({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid or missing API key",
        details: [],
      },
    }),
  });
}

// NOT exported with fastify-plugin -- intentionally encapsulated
export default authPlugin;
```

### Content-Type Validation Hook

```javascript
// src/hooks/content-type-check.mjs
// Source: Fastify Hooks docs (https://fastify.dev/docs/latest/Reference/Hooks/)

/**
 * Route-level preHandler that requires multipart/form-data Content-Type.
 * Attach to upload routes: { preHandler: requireMultipart }
 */
export async function requireMultipart(request, reply) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.startsWith("multipart/form-data")) {
    reply.status(400).send({
      error: {
        code: "INVALID_CONTENT_TYPE",
        message: "Content-Type must be multipart/form-data",
        details: [],
      },
    });
    return reply; // CRITICAL: must return reply to stop processing
  }
}
```

### Enhanced Error Handler (sanitization)

```javascript
// src/plugins/error-handler.mjs (enhanced)
// Source: Fastify Errors docs + Fastify Issue #4513
import fp from "fastify-plugin";

/**
 * Checks if an error message is safe to expose to clients.
 * Rejects messages containing file paths, stack traces, or module references.
 */
function isSafeMessage(msg) {
  if (!msg || typeof msg !== "string") return false;
  if (/\/(src|node_modules|dist|home|Users)\//i.test(msg)) return false;
  if (/at\s+\w+\s+\(/i.test(msg)) return false;
  if (/\.(mjs|js|ts|cjs):/i.test(msg)) return false;
  return true;
}

async function errorHandlerPlugin(fastify, opts) {
  fastify.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: `Route ${request.method} ${request.url} not found`,
        details: [],
      },
    });
  });

  fastify.setErrorHandler((error, request, reply) => {
    // Always log full error details server-side
    request.log.error(error);

    // Validation errors: safe to expose field-level details
    if (error.validation) {
      reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: error.message,
          details: error.validation.map((v) => ({
            field: v.instancePath || v.params?.missingProperty || "unknown",
            message: v.message,
          })),
        },
      });
      return;
    }

    const statusCode = error.statusCode || 500;

    // For 5xx: always generic message
    // For 4xx: use error message only if safe, otherwise generic
    let message;
    if (statusCode >= 500) {
      message = "An internal server error occurred";
    } else if (isSafeMessage(error.message)) {
      message = error.message;
    } else {
      message = "Bad request";
    }

    reply.status(statusCode).send({
      error: {
        code: error.code || (statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST"),
        message,
        details: [],
      },
    });
  });
}

export default fp(errorHandlerPlugin, { name: "error-handler" });
```

### Testing Auth with fastify.inject()

```javascript
// Source: Fastify testing patterns from Phase 1 + bearer auth
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import buildApp from "../../src/app.mjs";

describe("Authentication", () => {
  let app;
  const TEST_API_KEY = "test-api-key-for-testing-12345";

  before(async () => {
    process.env.API_KEY = TEST_API_KEY;
    app = buildApp({ logger: false });
    await app.ready();
  });

  after(async () => {
    await app.close();
    delete process.env.API_KEY;
  });

  it("Valid Bearer token passes through", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    assert.equal(res.statusCode, 200);
  });

  it("Missing Authorization header returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
    });
    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, "UNAUTHORIZED");
  });

  it("Invalid API key returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer wrong-key" },
    });
    assert.equal(res.statusCode, 401);
  });

  it("401 response does not reveal why key is wrong", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { authorization: "Bearer wrong-key" },
    });
    const body = res.json();
    assert.equal(body.error.message, "Invalid or missing API key");
    // Must NOT say "key not found" or "invalid format" or anything specific
  });

  it("Root /health does NOT require auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      // No Authorization header
    });
    assert.equal(res.statusCode, 200);
  });
});
```

### Testing Content-Type Validation

```javascript
describe("Content-Type Validation", () => {
  let app;

  before(async () => {
    process.env.API_KEY = "test-key";
    app = buildApp({ logger: false });

    // Register a test upload route with the preHandler
    // (simulating what Phase 3+ will add)
    // This would be inside the protected /v1 scope
    await app.ready();
  });

  after(async () => {
    await app.close();
    delete process.env.API_KEY;
  });

  it("POST without multipart/form-data returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/upload",  // test route
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error.code, "INVALID_CONTENT_TYPE");
  });
});
```

### Testing Error Sanitization

```javascript
describe("Error Sanitization", () => {
  let app;

  before(async () => {
    process.env.API_KEY = "test-key";
    app = buildApp({ logger: false });

    // Register a route that throws with internal details
    app.get("/v1/test-internal-error", async () => {
      const err = new Error("ENOENT: no such file /src/app.mjs at line 42");
      err.stack = "Error: ...\n    at Module._compile (node:internal/modules/cjs/loader:1234:14)";
      throw err;
    });

    await app.ready();
  });

  after(async () => {
    await app.close();
    delete process.env.API_KEY;
  });

  it("500 error does not expose file paths", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/test-internal-error",
      headers: { authorization: "Bearer test-key" },
    });
    assert.equal(res.statusCode, 500);
    const body = JSON.stringify(res.json());
    assert.ok(!body.includes("/src/"), "Response should not contain file paths");
    assert.ok(!body.includes("node:internal"), "Response should not contain Node.js internals");
    assert.ok(!body.includes(".mjs"), "Response should not contain file extensions");
  });

  it("500 error has generic message", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/test-internal-error",
      headers: { authorization: "Bearer test-key" },
    });
    const body = res.json();
    assert.equal(body.error.message, "An internal server error occurred");
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual header parsing + crypto.timingSafeEqual | @fastify/bearer-auth v10 with built-in timing-safe comparison | @fastify/bearer-auth v10 (2024) | No need to handle Buffer length matching or header parsing manually |
| Global auth hook with URL allowlist | Scoped plugin registration (Fastify encapsulation) | Fastify 4+ (native encapsulation) | Cleaner, impossible to misconfigure; routes outside scope are automatically unprotected |
| error.message passthrough for 4xx errors | Message sanitization with isSafeMessage check | Security best practice (ongoing) | Prevents leaking Fastify internal error messages (FST_ERR_*) to clients |
| Inline `keys: new Set(["..."])` with hardcoded key | Environment variable with fail-fast validation | Security best practice (ongoing) | Prevents committing secrets to source control |

**Deprecated/outdated:**
- `fastify-bearer-auth` (unscoped package): Use `@fastify/bearer-auth` (scoped to @fastify org). Old package name is deprecated.
- `specCompliance: 'rfc6749'` (case-insensitive Bearer): Default `rfc6750` (exact match) is correct and more secure.

## Open Questions

Things that couldn't be fully resolved:

1. **Should /v1/health require authentication?**
   - What we know: Root `/health` must be unprotected for infrastructure probes. `/v1/` routes are API endpoints.
   - What's unclear: Whether `/v1/health` should require auth like all other `/v1/` routes.
   - Recommendation: Yes, require auth for `/v1/health`. Keep it simple -- everything under `/v1/` requires auth. Infrastructure uses root `/health`. This is the cleanest encapsulation boundary.

2. **Multiple API keys or single key?**
   - What we know: `@fastify/bearer-auth` supports a Set of keys. Requirements say "API key validation" (singular).
   - What's unclear: Whether the project will ever need key rotation (two keys valid simultaneously during rotation).
   - Recommendation: Start with single key from `API_KEY` env var. The Set-based approach in `@fastify/bearer-auth` makes it trivial to add rotation later via `API_KEYS` (comma-separated) if needed. Don't over-engineer now.

3. **Content-Type check: when to implement?**
   - What we know: AUTH-04 requires Content-Type validation for upload endpoints. Upload endpoints don't exist yet (Phase 3+).
   - What's unclear: Whether to create the hook now (Phase 2) and test it with mock routes, or defer to Phase 3 when real upload routes exist.
   - Recommendation: Create the `requireMultipart` hook function now (it's 10 lines) and test it with a mock upload route. This satisfies AUTH-04 and the hook is ready for Phase 3 to use. The planner should decide.

## Sources

### Primary (HIGH confidence)
- @fastify/bearer-auth README (https://github.com/fastify/fastify-bearer-auth) - API, options, scoping, timing-safe comparison, Fastify 5 compatibility
- Fastify Hooks Reference (https://fastify.dev/docs/latest/Reference/Hooks/) - onRequest, preHandler, encapsulation, async hooks, early reply pattern
- Fastify Routes Reference (https://fastify.dev/docs/latest/Reference/Routes/) - Route-level hooks, shorthand methods, options
- Fastify Errors Reference (https://fastify.dev/docs/latest/Reference/Errors/) - setErrorHandler behavior, error properties, custom error handling
- Fastify ContentTypeParser Reference (https://fastify.dev/docs/latest/Reference/ContentTypeParser/) - Content type handling, FST_ERR_CTP_INVALID_MEDIA_TYPE
- Node.js crypto.timingSafeEqual docs (https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b) - Signature, Buffer requirements, throws behavior

### Secondary (MEDIUM confidence)
- Fastify Issue #4513 (https://github.com/fastify/fastify/issues/4513) - Default error handler exposing internals, community discussion, planned fix in v6
- Fastify Issue #487 (https://github.com/fastify/fastify/issues/487) - Disabling hooks on specific routes, encapsulation-based solution

### Tertiary (LOW confidence)
- None. All findings verified against official sources.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - @fastify/bearer-auth v10.1.2 verified on npm and GitHub; Fastify 5 compatibility confirmed in README
- Architecture: HIGH - Scoped plugin registration verified via Fastify Hooks docs (encapsulation) and @fastify/bearer-auth README (scoped examples)
- Pitfalls: HIGH - All pitfalls verified against official documentation (timing-safe comparison, hook return values, error handler behavior)
- Error sanitization: HIGH - Issue #4513 confirms the problem; setErrorHandler docs confirm the solution pattern

**Research date:** 2026-02-06
**Valid until:** 2026-03-08 (30 days -- @fastify/bearer-auth v10 and Fastify 5 are stable)
