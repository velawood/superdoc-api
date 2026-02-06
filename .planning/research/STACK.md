# Technology Stack

**Project:** superdoc-api (HTTP API layer for superdoc-redline)
**Researched:** 2026-02-06
**Research mode:** Ecosystem survey with comparison
**Overall confidence:** MEDIUM -- versions verified via npm registry where possible; unable to hit WebSearch/WebFetch/npm-view in this session, so version numbers are based on training data (cutoff ~May 2025) and flagged accordingly.

---

## Recommended Stack

### HTTP Framework

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| **Fastify** | ^5.x | HTTP server, routing, request lifecycle | See detailed rationale below | MEDIUM |

**Rationale -- why Fastify over Express, Hono, or Koa:**

1. **Schema-based validation built in.** Fastify uses JSON Schema natively for request/response validation. For this API, every request includes multipart file uploads and JSON bodies that must be validated (edit configs with specific shapes). Fastify validates at the framework level with compiled validators (Ajv) rather than requiring separate middleware. Express requires adding express-validator or Joi manually.

2. **Plugin architecture matches this project's needs.** Fastify's plugin system (`@fastify/multipart`, `@fastify/swagger`, `@fastify/cors`, `@fastify/rate-limit`) provides first-party, maintained plugins for every capability this API needs. Express equivalents exist but are community-maintained with varying quality.

3. **Structured logging via Pino.** Fastify ships with Pino as its default logger. For a production API handling file processing, structured JSON logging is essential for debugging failed requests, tracking processing times, and monitoring memory usage during JSDOM-heavy operations. Express requires bolting on morgan + winston or pino-http.

4. **Performance.** Fastify benchmarks at 2-5x Express throughput. While this API is I/O bound (DOCX processing), the lower per-request overhead matters when JSDOM already consumes significant memory per request.

5. **TypeScript-friendly even in JS.** Fastify's schema-based approach generates type hints and OpenAPI docs from the same schema definitions, even in a pure JS ESM project.

6. **ESM support.** Fastify 5.x has full ESM support, matching the existing codebase's `"type": "module"` configuration.

**Why NOT Express:**
- Express 5 has been in beta/RC for years. Express 4 lacks native async error handling (requires express-async-errors wrapper), has no built-in schema validation, no structured logging, and requires assembling middleware for every capability Fastify provides out of the box.
- The ecosystem is massive but many middleware packages are unmaintained.
- For a new greenfield API in 2025/2026, Express is the legacy choice.

**Why NOT Hono:**
- Hono excels at edge/serverless deployments (Cloudflare Workers, Deno Deploy, Bun). This API requires Node.js 18+ with JSDOM -- it cannot run on edge runtimes.
- Hono's Node.js adapter works but multipart file handling is less mature than @fastify/multipart.
- Hono lacks the plugin ecosystem depth for production concerns (rate limiting, swagger UI, CORS) -- these exist but are thinner than Fastify's.
- Hono would be the right choice if this were a lightweight JSON API without file processing. It is not.

**Why NOT Koa:**
- Koa is a minimal middleware framework. It requires assembling everything (router, body parser, file upload, error handling). For a focused API with 2-3 endpoints, this assembly tax is not justified.
- Koa's ecosystem has stalled relative to Fastify.

### File Upload Handling

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| **@fastify/multipart** | ^9.x | Multipart form data parsing for DOCX uploads | First-party Fastify plugin, Buffer mode for in-memory processing | MEDIUM |

**Rationale:**

The core requirement is: receive a DOCX file as multipart upload, hold it in memory as a Buffer, pass to `createHeadlessEditor(buffer)`. No disk writes needed.

`@fastify/multipart` provides:
- **Buffer mode** via `file.toBuffer()` -- exactly what this API needs. No temp files.
- **File size limits** configurable per-route (critical for preventing OOM from oversized DOCX uploads).
- **Field validation** -- can reject requests missing required fields before processing.
- Built on Busboy internally, the most battle-tested multipart parser in Node.js.

**Why NOT multer:** Multer is Express middleware. Using it with Fastify requires compatibility layers that defeat the purpose. Also, multer defaults to disk storage and requires explicit configuration for memory storage.

**Why NOT busboy directly:** @fastify/multipart already wraps busboy. Using busboy directly adds unnecessary complexity.

**Why NOT formidable:** formidable is disk-first and heavier than needed for this use case.

### Input Validation

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| **Fastify JSON Schema** (built-in, Ajv) | n/a | Request/response schema validation | Zero-dependency; Fastify compiles schemas at startup for fast runtime validation | HIGH |
| **Ajv** (transitive via Fastify) | ^8.x | JSON Schema compilation | Comes with Fastify, used for validating edit config JSON payloads | HIGH |

**Rationale:**

The edit configuration JSON has a well-defined shape (see `EditConfig` typedef in `editApplicator.mjs`):
```json
{
  "version": "string (optional)",
  "author": {"name": "string", "email": "string"},
  "edits": [
    {"operation": "replace|delete|comment|insert", "blockId": "string", ...}
  ]
}
```

Fastify's built-in JSON Schema validation handles this natively. Define the schema once, get:
- Request validation (reject malformed payloads before hitting business logic)
- Response serialization (fast JSON output)
- OpenAPI doc generation (via @fastify/swagger)

**Why NOT Zod:** Zod is excellent for TypeScript projects but adds a dependency. Fastify's native approach is lighter and doubles as OpenAPI source. If the project later migrates to TypeScript, Zod + fastify-type-provider-zod would be the upgrade path, but for pure JS ESM, JSON Schema is the right call.

### API Documentation

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| **@fastify/swagger** | ^9.x | OpenAPI spec generation from route schemas | Auto-generates OpenAPI 3.x spec from Fastify route definitions | MEDIUM |
| **@fastify/swagger-ui** | ^5.x | Swagger UI serving | Serves interactive API docs at /docs | MEDIUM |

**Rationale:**

With only 2-3 endpoints, hand-writing OpenAPI YAML is feasible but unnecessary. Fastify's swagger plugins generate the spec directly from the route schemas already defined for validation. Single source of truth: the route schema IS the documentation.

### Authentication

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| **Custom Fastify hook** | n/a | API key authentication via Bearer token | Simple `onRequest` hook; no library needed for static API key auth | HIGH |

**Rationale:**

The authentication requirement is straightforward: validate `Authorization: Bearer <api-key>` header against a configured set of valid keys. This is 10-15 lines of code in a Fastify `onRequest` hook. No library needed.

```javascript
// Example pattern (not prescriptive implementation)
fastify.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health') return; // Skip health check
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing API key' });
    return;
  }
  const key = auth.slice(7);
  if (!validApiKeys.has(key)) {
    reply.code(403).send({ error: 'Invalid API key' });
    return;
  }
});
```

**Why NOT passport.js:** Passport is for OAuth/session-based auth. Massive overkill for API key validation.

**Why NOT @fastify/auth:** Useful for complex multi-strategy auth. Overkill here, but could be adopted later if auth requirements grow.

### Error Handling

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| **Fastify error handler** (built-in) | n/a | Structured error responses | Fastify's `setErrorHandler` provides centralized error-to-response mapping | HIGH |

**Rationale:**

Define custom error classes for domain errors (validation failures, processing errors, file too large) and map them to HTTP responses in a single error handler. Fastify's built-in support handles this cleanly:

- 400: Invalid edit config, malformed request
- 401/403: Auth failures
- 413: File too large
- 422: Edit validation failures (block not found, etc.)
- 500: Processing errors (JSDOM crash, SuperDoc failure)

The existing `editApplicator.mjs` already returns structured validation results with `issues[]` and `warnings[]`. These map directly to structured error response bodies.

### Logging

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| **Pino** (via Fastify) | ^9.x | Structured JSON logging | Ships with Fastify; structured logs essential for debugging file processing failures | MEDIUM |
| **pino-pretty** | ^13.x | Dev-mode human-readable logs | Pretty-print logs during development only | LOW |

**Rationale:**

Fastify initializes with Pino by default. This gives:
- Request ID per request (correlate upload + processing + response)
- Timing data (how long did JSDOM processing take?)
- Structured error context (which block failed, which edit index?)
- JSON output for production log aggregation

### CORS

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| **@fastify/cors** | ^10.x | Cross-origin request handling | First-party Fastify plugin; needed if API is called from browser-based clients | MEDIUM |

**Rationale:**

If the API is called from browser-based applications (e.g., a web UI that uploads DOCX files), CORS headers are required. @fastify/cors is the standard Fastify plugin. Configure to allow specific origins in production.

May not be needed initially if all clients are server-side (API-to-API). Include as optional.

### Process Management / Deployment

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| **Docker** | n/a | Containerized deployment | Reproducible builds, memory limits, easy horizontal scaling | HIGH |
| **Node.js cluster mode** or **PM2** | PM2 ^5.x | Process management for multi-core | JSDOM is single-threaded and CPU-bound during document load; multiple workers handle concurrent requests | MEDIUM |

**Rationale -- deployment strategy:**

This API has a specific performance characteristic: each request creates a JSDOM instance, loads a full DOCX into a ProseMirror editor, processes it, and exports. This is **CPU-bound and memory-intensive** per request. A single Node.js process can handle one document at a time efficiently.

**Recommended approach:**

1. **Docker container** with explicit memory limits (e.g., 2GB per container).
2. **Multiple Node.js worker processes** via PM2 cluster mode or Node.js `cluster` module to utilize multiple CPU cores.
3. **Reverse proxy** (nginx, Caddy, or cloud load balancer) in front for TLS termination, rate limiting, and request routing.

**Why PM2 over raw cluster module:** PM2 provides zero-downtime reload, process monitoring, log management, and memory restart thresholds (critical for JSDOM memory leaks). The `cluster` module is lighter but requires implementing these features manually.

**Why NOT serverless (Lambda/Cloud Functions):**
- JSDOM + SuperDoc cold start time is significant (loading the dependency tree takes seconds).
- Memory ceiling on Lambda (10GB max) may be constraining for large documents.
- The stateless request/response model fits serverless, but cold start cost makes it impractical for interactive use.
- Consider serverless only for batch/async processing, not interactive API.

### Configuration

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| **Environment variables** | n/a | Runtime configuration (API keys, port, log level) | Standard 12-factor app approach; no config library needed for small surface | HIGH |
| **dotenv** | ^16.x | .env file loading for development | Load .env file in dev; not needed in production (Docker/platform provides env vars) | MEDIUM |

**Rationale:**

Configuration surface is small:
- `PORT` -- HTTP listen port (default 3000)
- `API_KEYS` -- comma-separated list of valid API keys
- `LOG_LEVEL` -- Pino log level (default 'info')
- `MAX_FILE_SIZE_MB` -- Upload size limit (default 50MB)
- `NODE_ENV` -- production/development

No need for a config library (convict, config, etc.) for 5 environment variables.

### Testing

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| **Node.js built-in test runner** | n/a (Node.js 18+) | Unit and integration tests | Already used by existing codebase; no reason to change | HIGH |
| **undici** or **node:test** fetch | n/a | HTTP integration tests | Fastify's `inject()` method is preferred for testing without starting a server | HIGH |

**Rationale:**

The existing codebase uses `node --test` with `node:assert/strict`. Continue this convention for API tests. Fastify provides `fastify.inject()` for testing routes without starting a real HTTP server -- this is faster and more reliable than supertest.

```javascript
// Example pattern
const response = await fastify.inject({
  method: 'POST',
  url: '/apply',
  headers: { authorization: 'Bearer test-key' },
  payload: formData,
});
assert.strictEqual(response.statusCode, 200);
```

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| HTTP Framework | Fastify 5 | Express 4/5 | No native schema validation, no structured logging, async error handling requires wrappers, middleware assembly tax |
| HTTP Framework | Fastify 5 | Hono | Optimized for edge runtimes; Node.js adapter works but multipart/plugin ecosystem thinner; wrong tool for JSDOM-heavy API |
| HTTP Framework | Fastify 5 | Koa | Minimal framework requires assembling everything; ecosystem stalled |
| File Upload | @fastify/multipart | multer | Express-specific; disk-first defaults; incompatible with Fastify without adapter |
| File Upload | @fastify/multipart | formidable | Disk-first; heavier than needed for buffer-mode uploads |
| Validation | Fastify JSON Schema | Zod | Adds dependency; JSON Schema is native to Fastify and generates OpenAPI docs |
| Validation | Fastify JSON Schema | Joi | Slower than Ajv; doesn't integrate with Fastify's route schema system |
| Auth | Custom hook | Passport.js | Massive overkill for API key auth |
| Auth | Custom hook | @fastify/bearer-auth | Viable alternative; slightly overkill for static key lookup but acceptable |
| Docs | @fastify/swagger | swagger-jsdoc | Requires JSDoc annotations on top of route definitions; Fastify generates from route schemas directly |
| Logging | Pino (via Fastify) | Winston | Winston is slower, less structured by default, not integrated with Fastify |
| Process Mgmt | PM2 | Node cluster | PM2 adds monitoring, auto-restart, memory thresholds; cluster module requires DIY |
| Config | env vars + dotenv | convict | Config surface too small to justify a library |

---

## Full Dependency List

### Production Dependencies (to add)

```bash
# HTTP framework + plugins
npm install fastify @fastify/multipart @fastify/swagger @fastify/swagger-ui @fastify/cors

# Already installed (existing)
# @harbour-enterprises/superdoc, jsdom, diff-match-patch, archiver, unzipper, commander
```

### Development Dependencies (to add)

```bash
npm install -D pino-pretty dotenv
```

### Optional / Phase 2

```bash
# If rate limiting is needed at app level (vs. reverse proxy)
npm install @fastify/rate-limit

# If Bearer auth plugin preferred over custom hook
npm install @fastify/bearer-auth
```

---

## Version Confidence Notes

| Package | Stated Version | Confidence | Notes |
|---------|---------------|------------|-------|
| fastify | ^5.x | MEDIUM | Fastify 5 was released in 2024. Verify latest minor with `npm view fastify version` before installing. |
| @fastify/multipart | ^9.x | LOW | Version number from training data. Verify before installing. |
| @fastify/swagger | ^9.x | LOW | Version number from training data. Verify before installing. |
| @fastify/swagger-ui | ^5.x | LOW | Version number from training data. Verify before installing. |
| @fastify/cors | ^10.x | LOW | Version number from training data. Verify before installing. |
| pino | ^9.x | MEDIUM | Pino 9 was current as of training data. Comes with Fastify. |
| pino-pretty | ^13.x | LOW | Version number from training data. Verify before installing. |
| dotenv | ^16.x | MEDIUM | Stable, slow-moving package. Likely still current. |
| PM2 | ^5.x | MEDIUM | PM2 5 has been stable for years. |

**Action required:** Before implementing, run `npm view <package> version` for each package to confirm latest versions. The major version recommendations (Fastify 5, not 4) are HIGH confidence; the minor/patch versions need verification.

---

## Architecture Implications

### How the stack fits the existing codebase

The existing modules (`irExtractor`, `editApplicator`, `documentReader`, `editorFactory`) accept Buffers and return results programmatically. The API layer wraps these:

```
HTTP Request (multipart DOCX + JSON body)
  -> @fastify/multipart (parse upload to Buffer)
  -> Fastify JSON Schema (validate JSON fields)
  -> Existing module (e.g., applyEdits(buffer, editConfig))
  -> Fastify response (Buffer as DOCX download or JSON)
```

No changes to existing `src/` modules are needed. The API layer is purely additive.

### Key adaptation needed

The existing functions (`extractDocumentIR`, `applyEdits`, `readDocument`) take **file paths** as input and write output to **file paths**. The API layer needs **Buffer-in, Buffer-out** versions.

Two approaches:
1. **Temp file shim:** Write uploaded Buffer to temp file, call existing functions, read result file, return Buffer. Simple but adds disk I/O.
2. **Refactor to accept Buffers directly:** The core of each function already works with Buffers internally (`createHeadlessEditor(buffer)`). The file I/O is only at the edges. Extract the buffer-based core and expose it.

**Recommendation:** Approach 2 (refactor). The functions already do `readFile(inputPath)` to get a buffer and `writeFile(outputPath, buffer)` at the end. Factor out the middle portion that works on buffers. This keeps the CLI path intact while giving the API direct buffer access.

### Memory considerations

Each request creates:
- A JSDOM instance (~10-30MB per document depending on size)
- A ProseMirror editor state
- The input Buffer + output Buffer (2x document size)

For a 1MB DOCX, expect ~50-100MB of memory per concurrent request. With PM2 cluster mode running 4 workers on a 2GB container, this supports ~5-8 concurrent requests safely.

**Must configure:**
- `@fastify/multipart` file size limit (reject >50MB uploads)
- PM2 `max_memory_restart` threshold
- Fastify connection timeout for long-running processing

---

## Sources

- Existing codebase analysis: `/Users/alin/code/work/superdoc-api/package.json`, `src/editorFactory.mjs`, `src/editApplicator.mjs`, `superdoc-redline.mjs`
- Existing planning docs: `.planning/PROJECT.md`, `.planning/codebase/STACK.md`, `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md`
- Fastify documentation: https://fastify.dev/docs/latest/ (not fetched in this session; recommendations based on training data)
- @fastify/multipart: https://github.com/fastify/fastify-multipart (not fetched; recommendations based on training data)
- Version numbers: Based on training data with cutoff ~May 2025. Flagged as MEDIUM/LOW confidence. **Verify with `npm view` before installing.**

---

## What I Could NOT Verify

1. **Exact latest versions** of all Fastify ecosystem packages (WebSearch, WebFetch, and Bash were unavailable)
2. **Fastify 5 ESM compatibility** with `.mjs` extension files specifically (HIGH confidence it works based on Fastify 5 release notes in training data, but not live-verified)
3. **@fastify/multipart Buffer mode API** -- training data says `file.toBuffer()` exists; verify with Context7 or official docs before implementing
4. **PM2 compatibility with ESM modules** -- PM2 has historically had issues with ESM. Verify `pm2 start server.mjs` works, or use an ecosystem.config.cjs wrapper

These gaps should be resolved during the implementation phase with live documentation checks.
