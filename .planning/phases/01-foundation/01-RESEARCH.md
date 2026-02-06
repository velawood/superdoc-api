# Phase 1: Foundation - Research

**Researched:** 2026-02-06
**Domain:** Fastify 5 server bootstrap, error handling, request tracing, API versioning
**Confidence:** HIGH

## Summary

Phase 1 delivers a running Fastify 5 server with five capabilities: health check endpoint, request ID tracing, structured error responses, correct HTTP status codes, and `/v1/` API versioning. This is a greenfield server setup with no dependency on existing domain modules (SuperDoc, JSDOM).

Research verified all Fastify 5 APIs needed for this phase against official documentation (fastify.dev) and npm registry. The standard approach is straightforward: create a Fastify instance with custom `genReqId` and `requestIdHeader` for tracing, use `register()` with `{ prefix: '/v1' }` for versioning, implement `setErrorHandler()` and `setNotFoundHandler()` for structured errors, and add an `onSend` hook to echo the request ID as `X-Request-Id` in every response.

One critical finding: Fastify 5 officially supports Node.js 20+ only. The project's `package.json` currently declares `"node": ">=18.0.0"` in engines. This must be updated to `>=20.0.0` for Fastify 5 compatibility. The development environment runs Node.js v24.11.0, so no local issue exists.

**Primary recommendation:** Use Fastify 5.7.x with built-in features only (no extra plugins needed for Phase 1). The entire phase can be implemented with `fastify` as the sole new dependency, plus `pino-pretty` as a dev dependency for readable local logs.

## Standard Stack

The established libraries/tools for this phase:

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| fastify | 5.7.4 | HTTP server, routing, request lifecycle, error handling | Official latest; built-in JSON schema validation, Pino logging, request ID generation, plugin-based routing with prefix support |
| pino | (transitive via fastify) | Structured JSON logging | Ships with Fastify; zero-config structured logging with request correlation |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pino-pretty | 13.1.3 | Human-readable log output | Development only; pipe stdout through it or use Fastify `transport` option |

### Not Needed for Phase 1

These were identified in prior project research but are NOT required until later phases:

| Library | Phase Needed | Purpose |
|---------|-------------|---------|
| @fastify/multipart (9.4.0) | Phase 3-4 | File upload parsing |
| @fastify/cors (11.2.0) | Phase 2+ (if needed) | CORS headers |
| @fastify/swagger (9.6.1) | v2 features | OpenAPI spec generation |
| @fastify/swagger-ui (5.2.5) | v2 features | Swagger UI serving |
| dotenv (17.2.4) | Phase 2 | .env file loading for API keys |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Fastify built-in `genReqId` + `onSend` hook | fastify-request-id plugin (1.0.1) | Plugin last published 2022, only 1.0.1; Fastify's built-in approach is 10 lines of code and fully current. Do not use the plugin. |
| Fastify built-in `setErrorHandler` | fastify-http-errors-enhanced | Adds dependency for something Fastify handles natively. Not needed. |
| `crypto.randomUUID()` for request IDs | uuid package | `crypto.randomUUID()` is built into Node.js 20+. No external package needed. |

**Installation:**

```bash
npm install fastify
npm install -D pino-pretty
```

## Architecture Patterns

### Recommended Project Structure for Phase 1

```
src/
  server.mjs              # Fastify instance creation, plugin registration, listen
  app.mjs                 # Fastify app factory (creates and configures instance, exported for testing)
  routes/
    health.mjs            # GET /health route (plain plugin function)
  plugins/
    request-id.mjs        # onSend hook to echo X-Request-Id in responses
    error-handler.mjs     # setErrorHandler + setNotFoundHandler
  # --- EXISTING (unchanged) ---
  blockOperations.mjs
  chunking.mjs
  ... (all existing domain modules)
```

**Key principle:** Separate the app factory (`app.mjs`) from the server start (`server.mjs`). The app factory creates and configures the Fastify instance and returns it. The server file imports the app, calls `listen()`, and handles process signals. This separation enables testing via `fastify.inject()` without starting a real server.

### Pattern 1: App Factory Pattern

**What:** Export a function that builds and returns a configured Fastify instance.
**When to use:** Always. This is the standard Fastify testing pattern.
**Source:** Fastify Getting Started guide (https://fastify.dev/docs/latest/Guides/Getting-Started/)

```javascript
// src/app.mjs
import Fastify from 'fastify';
import crypto from 'node:crypto';
import healthRoutes from './routes/health.mjs';
import requestIdPlugin from './plugins/request-id.mjs';
import errorHandlerPlugin from './plugins/error-handler.mjs';

export default function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    // Use client-provided X-Request-Id or generate a UUID
    requestIdHeader: 'x-request-id',
    genReqId: (req) => crypto.randomUUID(),
  });

  // Register plugins
  app.register(requestIdPlugin);
  app.register(errorHandlerPlugin);

  // Register versioned routes
  app.register(healthRoutes, { prefix: '/v1' });

  return app;
}
```

```javascript
// src/server.mjs
import buildApp from './app.mjs';

const app = buildApp();

try {
  await app.listen({ port: parseInt(process.env.PORT || '3000', 10), host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
```

### Pattern 2: Request ID Tracing via Built-in Features + onSend Hook

**What:** Fastify reads the `X-Request-Id` header from the incoming request (if present) via `requestIdHeader`, or generates a UUID via `genReqId`. An `onSend` hook copies `request.id` to the `X-Request-Id` response header.
**When to use:** Every request, unconditionally.
**Source:** Fastify Server docs (https://fastify.dev/docs/latest/Reference/Server/) - `requestIdHeader` and `genReqId` options

```javascript
// src/plugins/request-id.mjs
async function requestIdPlugin(fastify, opts) {
  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Request-Id', request.id);
    return payload;
  });
}

export default requestIdPlugin;
```

**How it works:**
1. Fastify checks for `X-Request-Id` header in incoming request (configured via `requestIdHeader: 'x-request-id'`)
2. If present, uses that value as `request.id` (echo back client-provided ID)
3. If absent, calls `genReqId(req)` which returns `crypto.randomUUID()`
4. The `onSend` hook sets `X-Request-Id` on every outgoing response
5. Pino automatically includes `request.id` as `reqId` in all log lines for this request

### Pattern 3: Structured Error Handler

**What:** A single `setErrorHandler` plus `setNotFoundHandler` that produces the required error JSON format.
**When to use:** Register once at app level before `listen()`.
**Source:** Fastify Errors docs (https://fastify.dev/docs/latest/Reference/Errors/)

```javascript
// src/plugins/error-handler.mjs
async function errorHandlerPlugin(fastify, opts) {
  // Handle 404 - unknown routes
  fastify.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        details: [],
      },
    });
  });

  // Handle all other errors
  fastify.setErrorHandler((error, request, reply) => {
    request.log.error(error);

    // Fastify validation errors have error.validation array
    if (error.validation) {
      reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          details: error.validation.map((v) => ({
            field: v.instancePath || v.params?.missingProperty || 'unknown',
            message: v.message,
          })),
        },
      });
      return;
    }

    // Use error.statusCode if set, otherwise 500
    const statusCode = error.statusCode || 500;
    reply.status(statusCode).send({
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: statusCode >= 500
          ? 'An internal server error occurred'
          : error.message,
        details: [],
      },
    });
  });
}

export default errorHandlerPlugin;
```

### Pattern 4: API Versioning via Plugin Prefix

**What:** All API routes are registered inside a plugin with `{ prefix: '/v1' }`.
**When to use:** Always. This is Fastify's built-in approach to URL prefixing.
**Source:** Fastify Routes docs (https://fastify.dev/docs/latest/Reference/Routes/)

```javascript
// In app.mjs:
app.register(healthRoutes, { prefix: '/v1' });
// Health route defined as GET '/' inside the plugin becomes GET /v1/health
// if the route itself is defined as GET '/health'
```

**Important note on health endpoint location:** The health check must be accessible at `/health` (root-level, outside /v1/) for infrastructure probes (load balancers, K8s). Register it both at root AND under /v1/:

```javascript
// Root health (for infrastructure probes)
app.register(healthRoutes);
// Versioned health (for API consistency)
app.register(healthRoutes, { prefix: '/v1' });
```

Alternatively, register health only at root level and all other routes under `/v1/`. The requirement says "All endpoints are mounted under the /v1/ URL prefix" which likely means API endpoints, with health being infrastructure. **This is a design decision the planner should make explicit.**

### Pattern 5: Health Check Route

**What:** A simple GET endpoint returning `{"status":"ok"}`.
**When to use:** Every server should have this.

```javascript
// src/routes/health.mjs
async function healthRoutes(fastify, opts) {
  fastify.get('/health', async (request, reply) => {
    return { status: 'ok' };
  });
}

export default healthRoutes;
```

### Anti-Patterns to Avoid

- **Mixing callback and promise plugin APIs:** Fastify 5 requires plugins to use one pattern consistently. Use async functions exclusively (the project is ESM).
- **Putting business logic in hooks:** Hooks are for cross-cutting concerns (tracing, auth). Route handlers are for business logic.
- **Using `request.connection`:** Removed in Fastify 5. Use `request.socket` instead.
- **JSON Schema shorthand:** Fastify 5 removed shorthand. Always provide full JSON Schema with `type` property.
- **Custom logger via `logger` option:** In Fastify 5, use `loggerInstance` for custom loggers. The `logger` option only accepts Pino configuration objects or boolean.

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Request ID generation | Custom middleware or third-party UUID lib | Fastify's `requestIdHeader` + `genReqId` options | Built-in, integrates with Pino logging, handles client echo |
| UUID generation | `uuid` npm package | `crypto.randomUUID()` (Node.js built-in) | Zero dependencies, available in Node.js 20+, cryptographically random |
| Request logging | Custom console.log middleware | Pino via Fastify's `logger: true` | Structured JSON, request correlation, configurable levels |
| 404 handling | Manual route-not-found checks | `fastify.setNotFoundHandler()` | Built-in, encapsulated, runs full lifecycle hooks |
| Validation error formatting | Manual try/catch around JSON.parse | Fastify JSON Schema validation + `schemaErrorFormatter` | Compiled Ajv validators, automatic 400 responses, standard format |

**Key insight:** Fastify 5 provides built-in solutions for every Phase 1 requirement. The only custom code needed is: (a) the structured error response format, (b) the onSend hook for X-Request-Id, and (c) the health check route handler.

## Common Pitfalls

### Pitfall 1: Node.js Version Mismatch

**What goes wrong:** Fastify 5 is installed but the deployment environment runs Node.js 18.
**Why it happens:** The project's `package.json` currently declares `"node": ">=18.0.0"` in engines, but Fastify 5 officially supports only Node.js 20+.
**How to avoid:** Update `package.json` engines to `"node": ">=20.0.0"` when installing Fastify 5. Verify CI/CD and deployment environments run Node.js 20+.
**Warning signs:** Cryptic failures, missing APIs (e.g., `crypto.randomUUID` edge cases on older Node 18 builds).
**Confidence:** HIGH (verified via https://fastify.dev/docs/latest/Reference/LTS/)

### Pitfall 2: Not Returning Payload from onSend Hook

**What goes wrong:** The onSend hook modifies the reply headers but forgets to return the payload, causing empty responses.
**Why it happens:** Fastify's onSend hook expects you to return the (possibly modified) payload. If you return nothing, the payload becomes `undefined`.
**How to avoid:** Always `return payload;` from async onSend hooks, even when only modifying headers.
**Warning signs:** Empty response bodies, Content-Length: 0.
**Confidence:** HIGH (verified via Fastify Hooks docs)

### Pitfall 3: Error Handler Not Setting Status Code Explicitly

**What goes wrong:** Custom error handler sends a structured JSON body but the HTTP status is 200 because the status code was not set.
**Why it happens:** Fastify documentation states: "the headers and status code will not be automatically set if a custom error handler is provided." When you override `setErrorHandler`, you take full responsibility for `reply.status()`.
**How to avoid:** Always call `reply.status(statusCode)` before `reply.send()` in the error handler.
**Warning signs:** Error responses with HTTP 200 status.
**Confidence:** HIGH (verified via Fastify Errors docs)

### Pitfall 4: Forgetting setNotFoundHandler for Custom 404s

**What goes wrong:** `setErrorHandler` is configured for structured errors, but 404s bypass it and return Fastify's default plain-text 404.
**Why it happens:** Fastify's not-found handling is separate from the error handler. Unknown routes trigger `setNotFoundHandler`, not `setErrorHandler`.
**How to avoid:** Always configure both `setErrorHandler` AND `setNotFoundHandler` to produce the same structured error format.
**Warning signs:** 404 responses have a different format than other errors.
**Confidence:** HIGH (verified via Fastify Server docs - setNotFoundHandler section)

### Pitfall 5: Fastify 5 JSON Schema Shorthand Removal

**What goes wrong:** Route schemas defined with shorthand syntax (e.g., `{ name: { type: 'string' } }`) fail silently or throw.
**Why it happens:** Fastify 5 removed `jsonShortHand` support. Full JSON Schema with `type: 'object'` wrapper is required.
**How to avoid:** Always provide full JSON Schema: `{ type: 'object', properties: { ... }, required: [...] }`.
**Warning signs:** Schema validation not working, unexpected 500 errors on route registration.
**Confidence:** HIGH (verified via Fastify v5 Migration Guide)

### Pitfall 6: Plugin Registration After listen()

**What goes wrong:** Plugins or error handlers registered after `fastify.listen()` are silently ignored.
**Why it happens:** Fastify freezes its configuration after `ready()` (which `listen()` calls internally).
**How to avoid:** Register all plugins, hooks, and handlers before calling `listen()`. Use the app factory pattern where configuration happens in `buildApp()` and `listen()` happens in `server.mjs`.
**Warning signs:** Custom error handler not being called, hooks not firing.
**Confidence:** HIGH (standard Fastify behavior)

## Code Examples

Verified patterns from official sources:

### Complete Server Bootstrap (ESM)

```javascript
// src/app.mjs
import Fastify from 'fastify';
import crypto from 'node:crypto';

export default function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger !== undefined ? opts.logger : {
      level: process.env.LOG_LEVEL || 'info',
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
  });

  // Echo request ID in every response
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Request-Id', request.id);
    return payload;
  });

  // Structured 404 handler
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
        details: [],
      },
    });
  });

  // Structured error handler
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);

    if (error.validation) {
      reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          details: error.validation.map((v) => ({
            field: v.instancePath || v.params?.missingProperty || 'unknown',
            message: v.message,
          })),
        },
      });
      return;
    }

    const statusCode = error.statusCode || 500;
    reply.status(statusCode).send({
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: statusCode >= 500
          ? 'An internal server error occurred'
          : error.message,
        details: [],
      },
    });
  });

  // Health check at root level
  app.get('/health', async () => ({ status: 'ok' }));

  // Versioned API routes
  app.register(async function v1Routes(v1) {
    v1.get('/health', async () => ({ status: 'ok' }));
    // Future routes will be registered here
  }, { prefix: '/v1' });

  return app;
}
```

```javascript
// src/server.mjs
import buildApp from './app.mjs';

const app = buildApp();

try {
  const address = await app.listen({
    port: parseInt(process.env.PORT || '3000', 10),
    host: '0.0.0.0',
  });
  app.log.info(`Server listening on ${address}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
```

### Testing with fastify.inject()

```javascript
// tests/health.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import buildApp from '../src/app.mjs';

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const app = buildApp({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { status: 'ok' });
  });

  it('includes X-Request-Id header in response', async () => {
    const app = buildApp({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    assert.ok(response.headers['x-request-id']);
    // UUID v4 format: 8-4-4-4-12 hex chars
    assert.match(response.headers['x-request-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('echoes client-provided X-Request-Id', async () => {
    const app = buildApp({ logger: false });
    const clientId = 'client-provided-id-123';

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': clientId },
    });

    assert.strictEqual(response.headers['x-request-id'], clientId);
  });
});

describe('Error responses', () => {
  it('returns structured 404 for unknown routes', async () => {
    const app = buildApp({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: '/nonexistent',
    });

    assert.strictEqual(response.statusCode, 404);
    const body = JSON.parse(response.body);
    assert.ok(body.error);
    assert.strictEqual(body.error.code, 'NOT_FOUND');
    assert.ok(body.error.message);
    assert.ok(Array.isArray(body.error.details));
  });

  it('includes X-Request-Id on error responses', async () => {
    const app = buildApp({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: '/nonexistent',
    });

    assert.ok(response.headers['x-request-id']);
  });
});

describe('API versioning', () => {
  it('mounts health under /v1/ prefix', async () => {
    const app = buildApp({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/health',
    });

    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { status: 'ok' });
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Fastify 4 with `logger: customInstance` | Fastify 5 with `loggerInstance: customInstance` | Fastify 5.0.0 (Sep 2024) | Logger config option split; `logger` only accepts Pino options or boolean |
| JSON Schema shorthand in route schemas | Full JSON Schema required (with `type` property) | Fastify 5.0.0 (Sep 2024) | All schemas must be complete JSON Schema objects |
| `request.connection` | `request.socket` | Fastify 5.0.0 (Sep 2024) | Connection property removed |
| Node.js 14/16/18 support | Node.js 20+ only | Fastify 5.0.0 (Sep 2024) | Minimum Node.js version is now 20 |
| `uuid` npm package | `crypto.randomUUID()` built-in | Node.js 19+ (stable) | No dependency needed for UUID generation |

**Deprecated/outdated:**
- `jsonShortHand` option: removed in Fastify 5, no replacement needed (just write full schemas)
- `useSemicolonDelimiter`: now defaults to `false` (was `true` in v4)
- Callback + promise mixing in plugins: no longer allowed in Fastify 5

## Open Questions

Things that couldn't be fully resolved:

1. **Health endpoint placement: root-only vs. root + /v1/**
   - What we know: Success criteria says "All endpoints are mounted under the /v1/ URL prefix" and "GET /health returns {status:ok}"
   - What's unclear: Should `/health` ONLY exist at `/v1/health`, or should it also be at root `/health` for infrastructure probes?
   - Recommendation: Register health at both `/health` (root, for load balancers/K8s) and `/v1/health` (versioned, for API consistency). The planner should make this explicit. Infrastructure probes typically check root-level paths.

2. **Pino pretty printing in development**
   - What we know: `pino-pretty` can be used via Fastify's `transport` option or by piping stdout
   - What's unclear: Whether to configure it in-app via `transport` or recommend `node src/server.mjs | npx pino-pretty`
   - Recommendation: Use `transport` option in development for simplicity: `logger: { level: 'info', transport: { target: 'pino-pretty' } }`. Use plain JSON in production (no transport). The planner should decide how to switch between dev/prod logging.

3. **Error response format: `statusCode` field in body**
   - What we know: The requirement specifies `{"error":{"code":"...","message":"...","details":[...]}}`. Fastify's default format includes a `statusCode` field at the top level.
   - What's unclear: Whether to include `statusCode` in the response body alongside the `error` object for convenience.
   - Recommendation: Follow the requirement exactly. Do not include `statusCode` in the body (it's in the HTTP status line). Keep the response body clean: `{"error":{...}}` only.

## Sources

### Primary (HIGH confidence)
- Fastify Server Reference (https://fastify.dev/docs/latest/Reference/Server/) - Server options, genReqId, requestIdHeader, logger, listen()
- Fastify Errors Reference (https://fastify.dev/docs/latest/Reference/Errors/) - setErrorHandler signature, error properties
- Fastify Routes Reference (https://fastify.dev/docs/latest/Reference/Routes/) - Route prefix, plugin-based prefixing, schema validation
- Fastify Hooks Reference (https://fastify.dev/docs/latest/Reference/Hooks/) - onSend, onRequest, hook execution order
- Fastify Getting Started Guide (https://fastify.dev/docs/latest/Guides/Getting-Started/) - ESM setup, plugin pattern, async/await
- Fastify LTS Reference (https://fastify.dev/docs/latest/Reference/LTS/) - Node.js 20+ requirement for Fastify 5
- Fastify v5 Migration Guide (https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/) - Breaking changes
- Fastify Plugins Reference (https://fastify.dev/docs/latest/Reference/Plugins/) - ESM plugin syntax, encapsulation
- Fastify Validation and Serialization (https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) - schemaErrorFormatter, validation errors
- npm registry - Verified versions: fastify@5.7.4, pino@10.3.0, pino-pretty@13.1.3

### Secondary (MEDIUM confidence)
- Fastify error handling patterns (https://dev.to/eomm/fastify-error-handlers-53ol) - Error handler practical patterns
- Fastify v5 analysis (https://encore.dev/blog/fastify-v5) - Breaking changes summary

### Tertiary (LOW confidence)
- None. All findings verified against official sources.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All versions verified via npm registry, APIs verified via official docs
- Architecture: HIGH - Patterns verified against Fastify official docs (Getting Started, Plugins, Routes, Hooks)
- Pitfalls: HIGH - All pitfalls verified against Fastify v5 Migration Guide and official reference docs

**Critical finding:** Node.js engine requirement must be updated from >=18.0.0 to >=20.0.0 for Fastify 5 compatibility.

**Research date:** 2026-02-06
**Valid until:** 2026-03-08 (30 days -- Fastify 5 is stable, no major changes expected)
