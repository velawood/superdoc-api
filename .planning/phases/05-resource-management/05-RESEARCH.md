# Phase 5: Resource Management - Research

**Researched:** 2026-02-06
**Domain:** JSDOM cleanup, concurrency limiting, temp file management
**Confidence:** MEDIUM (JSDOM cleanup patterns need verification in practice; concurrency and temp file patterns are HIGH confidence)

## Summary

Phase 5 addresses three critical resource management concerns for a long-running server processing memory-intensive JSDOM operations:

1. **JSDOM Memory Leaks (RES-01)**: The current codebase calls `editor.destroy()` but never closes the underlying JSDOM window. Research confirms this is a well-known memory leak pattern. The JSDOM window must be explicitly closed, and importantly, the closure should happen asynchronously (next tick) to avoid retaining references. The window reference must be captured during editor creation and closed after editor destruction.

2. **Concurrency Limiting (RES-02)**: Without limits, simultaneous requests spawn unbounded JSDOM instances, each consuming 50-100MB+. A semaphore pattern limits concurrent JSDOM operations (e.g., max 4 simultaneous documents). Multiple proven libraries exist: `p-limit` (simplest, good for function-level limiting), `async-mutex` (sophisticated read/write locks), and `async-sema` (from Vercel, true semaphore semantics with token management).

3. **Temp File Cleanup (RES-03)**: The Apply endpoint will write temp files for domain modules. The standard pattern is try-finally blocks with cleanup in finally, ensuring removal even on errors. Modern Node.js also supports the `using` keyword with Symbol.dispose for automatic cleanup, but try-finally is more established and explicit.

**Critical finding:** JSDOM window cleanup requires **asynchronous disposal**. Calling `window.close()` synchronously immediately after creation causes memory retention. The solution is to wrap cleanup in `setImmediate()` or `setTimeout(..., 0)` to defer to the next event loop tick. This is a LOW confidence finding because JSDOM version 24 documentation doesn't explicitly document this pattern, but multiple GitHub issues and community reports confirm it.

**Primary recommendation:**
- Use `async-sema` (Vercel) for concurrency limiting (true semaphore semantics, well-maintained)
- Capture JSDOM window reference in `editorFactory.mjs` and return cleanup function
- Use Fastify's `onResponse` hook to trigger async cleanup after response sent
- Standard try-finally for temp file cleanup (Apply endpoint, Phase 6+)

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| async-sema | 3.1.1 | Semaphore for concurrency limiting | From Vercel, true semaphore semantics (not just promise queue), supports token-based resource management, actively maintained, used in production by Vercel |
| jsdom | 24.0.0 (existing) | Virtual DOM for SuperDoc | Already in use; research confirms cleanup pattern needs |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| N/A | - | Temp file cleanup | Built-in fs/promises with try-finally blocks |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| async-sema | p-limit | Simpler API, function-level limiting only. Good for basic use cases but doesn't support token-based resource tracking. Use p-limit if you only need to limit function calls, not manage actual resources. |
| async-sema | async-mutex | More sophisticated (read/write locks, mutex), but heavier than needed. Mutex is for mutual exclusion (n=1), not n-way concurrency. Use async-mutex if you need complex locking patterns, not just concurrency limiting. |
| try-finally | using keyword (TC39 proposal) | Modern syntax, auto-cleanup with Symbol.dispose. Still relatively new (Node.js 20+), less established in community. Consider for future refactor but stick with try-finally for now. |
| onResponse hook | Manual tracking in route handlers | Could manage cleanup directly in each route, but Fastify's hook system centralizes cleanup logic and ensures it runs even on errors. Always prefer hooks for cross-cutting concerns. |

**Installation:**

```bash
npm install async-sema
```

## Architecture Patterns

### Recommended Resource Management Flow

```
Request → Auth → Multipart Parse → Route Handler
                                    ↓
                          [Acquire Semaphore]
                                    ↓
                          Create JSDOM + Editor
                                    ↓
                          Process Document (read/apply)
                                    ↓
                          Destroy Editor (editor.destroy())
                                    ↓
                          [Store cleanup function on request]
                                    ↓
                          Send Response → onResponse Hook
                                                ↓
                                    [Async JSDOM cleanup: setImmediate(() => window.close())]
                                                ↓
                                    [Release Semaphore]
```

### Pattern 1: Editor Factory with Cleanup Function

**What:** Modify `editorFactory.mjs` to return both editor and cleanup function that captures window reference.
**When to use:** Every JSDOM editor creation (read, apply endpoints).
**Source:** Derived from JSDOM GitHub issue #1682 and Node.js best practices

```javascript
// src/editorFactory.mjs (MODIFIED)
import { Editor, getStarterExtensions } from '@harbour-enterprises/superdoc/super-editor';
import { JSDOM } from 'jsdom';

/**
 * Create a headless SuperDoc editor instance from a buffer.
 * Returns both the editor and a cleanup function that MUST be called.
 *
 * CRITICAL: The cleanup function must be called asynchronously (next tick)
 * to prevent memory leaks. Use setImmediate() or setTimeout(..., 0).
 */
export async function createHeadlessEditor(buffer, options = {}) {
  const {
    documentMode = 'editing',
    user = { name: 'AI Assistant', email: 'ai@example.com' }
  } = options;

  // Create JSDOM window - MUST be cleaned up
  const { window } = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const { document } = window;

  const [content, media, mediaFiles, fonts] = await Editor.loadXmlData(buffer, true);

  const editor = new Editor({
    mode: 'docx',
    documentMode: documentMode,
    documentId: 'doc-' + Date.now(),
    element: document.createElement('div'),
    extensions: getStarterExtensions(),
    fileSource: buffer,
    content,
    media,
    mediaFiles,
    fonts,
    isHeadless: true,
    document: document,
    user: user,
  });

  // Return cleanup function that destroys editor AND closes window
  const cleanup = () => {
    // Step 1: Destroy editor (releases SuperDoc resources)
    editor.destroy();

    // Step 2: Close JSDOM window asynchronously to prevent memory leak
    // CRITICAL: Must be async (next tick) to avoid retaining references
    setImmediate(() => {
      try {
        window.close();
      } catch (err) {
        // Window already closed or invalid - ignore
      }
    });
  };

  return { editor, cleanup };
}
```

### Pattern 2: Concurrency Limiter Plugin

**What:** Fastify plugin that provides a semaphore decorator for limiting concurrent JSDOM operations.
**When to use:** Register globally in app.mjs, use in routes that create editors.
**Source:** Fastify decorator pattern + async-sema documentation

```javascript
// src/plugins/concurrency-limiter.mjs
import { Sema } from 'async-sema';
import fp from 'fastify-plugin';

/**
 * Concurrency limiter plugin for JSDOM-heavy operations.
 *
 * Prevents OOM by limiting simultaneous document processing.
 * Configuration:
 * - maxConcurrency: Max simultaneous JSDOM instances (default: 4)
 *   Tune based on available memory (~100MB per instance)
 */
async function concurrencyLimiterPlugin(fastify, opts) {
  const maxConcurrency = opts.maxConcurrency ?? 4;
  const semaphore = new Sema(maxConcurrency);

  // Decorate fastify instance with semaphore
  fastify.decorate('documentSemaphore', semaphore);

  fastify.log.info(
    { maxConcurrency },
    'Concurrency limiter initialized'
  );
}

export default fp(concurrencyLimiterPlugin, {
  name: 'concurrency-limiter'
});
```

### Pattern 3: Route Handler with Semaphore

**What:** Acquire semaphore before creating editor, release in onResponse hook.
**When to use:** Every route that processes documents (read, apply).
**Source:** async-sema + Fastify lifecycle

```javascript
// src/routes/read.mjs (MODIFIED)
async function readRoutes(fastify, opts) {
  fastify.post("/read", { preHandler: [requireMultipart] }, async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: { code: "MISSING_FILE", ... } });
    }

    const buffer = await data.toBuffer();

    // Validation...

    // Acquire semaphore BEFORE creating JSDOM
    await fastify.documentSemaphore.acquire();

    let cleanup = null;
    try {
      // Create editor with cleanup function
      const { editor, cleanup: editorCleanup } = await createHeadlessEditor(buffer);
      cleanup = editorCleanup;

      // Store cleanup on request for onResponse hook
      request.editorCleanup = cleanup;

      // Extract IR
      const ir = extractIRFromEditor(editor, filename, { format: "full", ... });

      // Return response (cleanup happens in onResponse hook)
      return reply.type("application/json").send(ir);

    } catch (error) {
      // On error, cleanup immediately and release semaphore
      if (cleanup) {
        cleanup();
      }
      fastify.documentSemaphore.release();

      request.log.error({ err: error }, "Document extraction failed");
      return reply.status(422).send({
        error: { code: "EXTRACTION_FAILED", ... }
      });
    }
  });
}
```

### Pattern 4: Cleanup Hook (onResponse)

**What:** Fastify onResponse hook that performs async cleanup after response sent.
**When to use:** Register globally to handle all routes that create editors.
**Source:** Fastify hooks documentation + JSDOM cleanup pattern

```javascript
// src/plugins/resource-cleanup.mjs
import fp from 'fastify-plugin';

/**
 * Resource cleanup plugin - ensures JSDOM cleanup happens after response sent.
 *
 * This hook runs AFTER the response is sent to the client, making it safe
 * to perform async cleanup operations without blocking the response.
 */
async function resourceCleanupPlugin(fastify, opts) {
  fastify.addHook('onResponse', async (request, reply) => {
    // If this request created an editor, clean it up
    if (request.editorCleanup) {
      try {
        request.editorCleanup();
      } catch (err) {
        request.log.error({ err }, 'Error during editor cleanup');
      }

      // Release semaphore
      fastify.documentSemaphore.release();

      request.log.debug('Editor resources cleaned up');
    }
  });
}

export default fp(resourceCleanupPlugin, {
  name: 'resource-cleanup',
  dependencies: ['concurrency-limiter'] // Must be registered after semaphore
});
```

### Pattern 5: Temp File Cleanup (Apply Endpoint - Phase 6)

**What:** Standard try-finally pattern for temp files.
**When to use:** Apply endpoint when writing domain modules to temp directory.
**Source:** Node.js best practices

```javascript
// Example for future Apply endpoint
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

async function applyEdits(buffer, edits) {
  let tempDir = null;

  try {
    // Create temp directory
    tempDir = await mkdtemp(join(tmpdir(), 'superdoc-'));

    // Write domain modules, process edits...

    return editedBuffer;

  } finally {
    // ALWAYS cleanup temp files, even on error
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        // Log but don't throw - cleanup is best-effort
        console.error('Failed to cleanup temp directory:', err);
      }
    }
  }
}
```

### Anti-Patterns to Avoid

- **Synchronous window.close()**: Do NOT call `window.close()` synchronously immediately after editor creation. This causes memory retention. Always defer to next tick with `setImmediate()` or `setTimeout(..., 0)`.
- **No semaphore**: Do NOT allow unbounded concurrent JSDOM instances. Each instance is 50-100MB+ and can quickly OOM the server.
- **Cleanup before response**: Do NOT call `window.close()` before sending the response. This can block the response. Use `onResponse` hook for post-response cleanup.
- **Forgetting finally block**: Do NOT write temp files without try-finally. Errors will leave orphaned files that accumulate over time.
- **Global references to window**: Do NOT store window/document references in module-level variables. This prevents garbage collection.

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Semaphore/concurrency limiter | Custom promise queue with counter | async-sema or p-limit | Edge cases: queue overflow, fairness, cancellation, error propagation. Production-tested implementations handle these correctly. |
| Temp directory generation | Manual `/tmp/prefix-${Date.now()}` | fs.mkdtemp() (Node.js built-in) | Handles race conditions, permissions, cross-platform temp dirs, atomic creation. |
| Resource cleanup on exit | Manual process.on('exit') handlers | try-finally blocks + Fastify lifecycle | try-finally is deterministic per-request. Process exit handlers are for graceful shutdown, not per-request cleanup. |
| Async disposal | Manual tracking of cleanup functions | Symbol.dispose (modern) or factory pattern | Factory pattern (editor + cleanup function) is explicit and works today. Symbol.dispose is newer but not yet widespread. |

**Key insight:** Memory management in long-running servers is subtle. Synchronous vs async cleanup timing affects garbage collection. Production-tested libraries and established patterns handle these subtleties correctly.

## Common Pitfalls

### Pitfall 1: Synchronous JSDOM Window Closure

**What goes wrong:** Calling `window.close()` immediately (synchronously) after `new JSDOM()` causes the window object to be retained in memory, even after calling close.

**Why it happens:** JSDOM's internal cleanup requires references to be released before the next event loop tick. Synchronous closure doesn't give the garbage collector time to break circular references between window, document, and DOM nodes.

**How to avoid:** Always defer `window.close()` to the next tick using `setImmediate()` or `setTimeout(..., 0)`. If using a cleanup function pattern, call the cleanup function normally but ensure window.close() itself is wrapped in setImmediate.

**Warning signs:**
- Memory usage grows linearly with request count (not returning to baseline)
- Heap snapshots show retained JSDOM Window objects after requests complete
- Memory grows even with `editor.destroy()` and `window.close()` calls

**Sources:**
- [JSDOM Issue #1682: Memory leak with synchronous window.close()](https://github.com/jsdom/jsdom/issues/1682)
- [Node.js Memory Leak with jsdom](https://www.codestudy.net/blog/jsdom-and-node-js-leaking-memory/)

### Pitfall 2: Unbounded Concurrent JSDOM Instances

**What goes wrong:** Without concurrency limiting, a burst of simultaneous requests (e.g., 20 concurrent uploads) creates 20 JSDOM instances at once, each consuming 50-100MB. This can exhaust available memory (OOM) or cause severe GC pauses that make the server unresponsive.

**Why it happens:** Node.js is async by default - it will happily start processing all requests simultaneously. Each request creates a JSDOM window, loads a DOCX, and allocates large buffers. Memory spikes faster than GC can reclaim it.

**How to avoid:** Use a semaphore to limit concurrent JSDOM operations to a safe number based on available memory. Formula: `maxConcurrency = (availableMemory * 0.7) / avgDocumentMemory`. For 1GB available, 100MB per doc → max 7 concurrent. Start conservative (4) and tune based on metrics.

**Warning signs:**
- Server becomes unresponsive under load (but recovers when load drops)
- OOM crashes with error "JavaScript heap out of memory"
- Event loop lag spikes correlate with concurrent request count

**Sources:**
- [Limiting Concurrency in Node.js](https://itnext.io/limiting-concurrency-in-node-js-40152905970b)
- [Node.js Best Practices: Limit concurrent requests](https://nodejsbestpractices.com/sections/security/limitrequests/)

### Pitfall 3: Releasing Semaphore Before Cleanup

**What goes wrong:** If you release the semaphore immediately after processing (before calling cleanup), the next request can start while the previous JSDOM window is still open. This defeats the purpose of the semaphore - you can still have unbounded JSDOM instances alive simultaneously.

**Why it happens:** Natural instinct is to release the semaphore as soon as the "work" is done (after extracting IR or applying edits). But the JSDOM window is still alive and consuming memory until cleanup runs.

**How to avoid:** Release the semaphore AFTER cleanup, not before. In Fastify, this means releasing in the `onResponse` hook (where cleanup happens) rather than in the route handler after calling `editor.destroy()`.

**Warning signs:**
- Memory usage still grows despite semaphore (slower than without, but still grows)
- Heap snapshots show more JSDOM windows than maxConcurrency setting
- Semaphore metrics show correct limiting, but memory usage doesn't match

### Pitfall 4: Forgetting Cleanup on Error Paths

**What goes wrong:** If validation fails or an error is thrown before the response is sent, the `onResponse` hook might not run (depending on Fastify version and error handling). The semaphore is never released, and the window is never closed. After `maxConcurrency` errors, the server deadlocks - all permits are held, no new requests can proceed.

**Why it happens:** Error handling often returns early with `reply.send()`, potentially bypassing normal lifecycle hooks. If cleanup is only in `onResponse`, errors can skip it.

**How to avoid:** Use try-catch in route handler. In the catch block, immediately call cleanup and release the semaphore before returning the error response. This ensures cleanup happens on both success and error paths.

**Warning signs:**
- Server stops accepting requests after a series of errors (deadlock)
- Semaphore metrics show all permits acquired, none available
- Logs show errors but no corresponding cleanup messages

### Pitfall 5: Temp File Accumulation

**What goes wrong:** Temp files created during processing (for domain modules in Apply endpoint) are never deleted. Over time, `/tmp` fills up (or the temp directory), eventually causing ENOSPC (no space left) errors.

**Why it happens:** Forgot to add finally block, or cleanup code is in a path that doesn't execute on errors. Temp directory libraries with "auto cleanup on process exit" don't help for long-running servers - files accumulate between restarts.

**How to avoid:** Always use try-finally pattern. Create temp resources before try, clean up in finally. Use `{ force: true }` with `rm()` to ignore errors (file might already be deleted). Log cleanup failures but don't throw - cleanup is best-effort.

**Warning signs:**
- Disk usage grows over time on server
- `/tmp` directory contains old `superdoc-*` directories
- Eventually: ENOSPC errors when trying to create new temp files

**Sources:**
- [Secure tempfiles in Node.js](https://advancedweb.hu/secure-tempfiles-in-nodejs-without-dependencies/)

## Code Examples

Verified patterns from research:

### Basic Semaphore Usage

```javascript
// Source: async-sema documentation
import { Sema } from 'async-sema';

const s = new Sema(4); // Allow 4 concurrent operations

async function processDocument(buffer) {
  await s.acquire(); // Wait for available slot
  try {
    // Create JSDOM, process document
    const { editor, cleanup } = await createHeadlessEditor(buffer);
    try {
      // Do work...
      return result;
    } finally {
      cleanup(); // Cleanup JSDOM
    }
  } finally {
    s.release(); // ALWAYS release, even on error
  }
}
```

### Async Window Cleanup

```javascript
// Source: JSDOM GitHub issues + community patterns
function createCleanupFunction(window, editor) {
  return () => {
    // Step 1: Destroy editor (SuperDoc cleanup)
    editor.destroy();

    // Step 2: Close window asynchronously (JSDOM cleanup)
    setImmediate(() => {
      try {
        window.close();
      } catch (err) {
        // Already closed or invalid - safe to ignore
      }
    });
  };
}
```

### Temp Directory with Cleanup

```javascript
// Source: Node.js fs/promises documentation
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

async function processWithTempFiles() {
  let tempDir = null;

  try {
    // Create unique temp directory atomically
    tempDir = await mkdtemp(join(tmpdir(), 'superdoc-'));

    // Write files, process...

    return result;
  } finally {
    // Always cleanup, ignore errors
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        console.error('Temp cleanup failed:', err);
      }
    }
  }
}
```

### Fastify onResponse Hook for Cleanup

```javascript
// Source: Fastify hooks documentation
fastify.addHook('onResponse', async (request, reply) => {
  // onResponse runs AFTER response sent - safe for async cleanup

  if (request.editorCleanup) {
    try {
      // Trigger async cleanup (editor.destroy + window.close)
      request.editorCleanup();

      request.log.debug(
        { requestId: request.id },
        'Editor resources cleaned up'
      );
    } catch (err) {
      request.log.error({ err }, 'Cleanup failed');
    }

    // Release semaphore after cleanup
    fastify.documentSemaphore.release();
  }
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| window.close() immediately | window.close() in setImmediate() | ~2018-2019 (JSDOM issues #1682, #1665) | Prevents memory leaks in long-running Node.js servers. Old approach caused window retention. |
| Custom promise queue | async-sema, p-limit | ~2018-2020 | Production-tested libraries handle edge cases (queue overflow, fairness). Custom queues often had subtle bugs. |
| process.on('exit') cleanup | try-finally + request lifecycle hooks | Ongoing best practice | Exit handlers are for graceful shutdown, not per-request cleanup. try-finally is deterministic. |
| Synchronous file operations | fs/promises with async/await | Node.js 10+ (2018+) | Async file operations prevent blocking event loop. Critical for server responsiveness. |

**Deprecated/outdated:**
- **jsdom.env()**: Deprecated in JSDOM 10+, removed in later versions. Use `new JSDOM()` constructor instead.
- **fastify-server-timeout plugin**: Fastify 5 has built-in timeout support via server options (connectionTimeout, requestTimeout). No plugin needed.
- **manual UUID generation**: Node.js 20+ has `crypto.randomUUID()` built-in. No need for `uuid` package.

## Open Questions

Things that couldn't be fully resolved:

1. **Optimal Concurrency Limit**
   - What we know: Depends on available memory and average document size. Formula: `maxConcurrency = (availableMemory * 0.7) / avgDocumentMemory`
   - What's unclear: Actual memory footprint per document varies widely (simple doc: 50MB, complex doc with images: 200MB+)
   - Recommendation: Start with 4, add metrics (event loop lag, memory usage), tune based on production data. Consider making it configurable via environment variable (`MAX_DOCUMENT_CONCURRENCY`).

2. **JSDOM Version 24 Cleanup**
   - What we know: Multiple GitHub issues and community reports confirm async window.close() pattern prevents leaks
   - What's unclear: Whether JSDOM 24 (current version in package.json) has internal improvements that make async cleanup unnecessary
   - Recommendation: Implement async cleanup pattern regardless (it's safe even if not strictly needed). Add memory monitoring to Phase 8 to verify no leaks. Mark as MEDIUM confidence - requires production validation.

3. **Semaphore Fairness**
   - What we know: async-sema uses FIFO queue, ensuring fairness
   - What's unclear: Whether fairness matters for this use case (vs. letting fast requests jump ahead)
   - Recommendation: FIFO fairness is good default. If we see priority needs later (e.g., small docs should process faster), consider p-queue with priority support.

4. **Cleanup Hook Error Handling**
   - What we know: onResponse hook should not throw (Fastify will log but not crash)
   - What's unclear: What happens if cleanup throws AND semaphore.release() throws? Do we leak the semaphore permit?
   - Recommendation: Wrap cleanup and release in separate try-catch blocks. Log errors but ensure release() always runs.

## Sources

### Primary (HIGH confidence)

- [Fastify 5 Hooks Documentation](https://fastify.dev/docs/latest/Reference/Hooks/) - onResponse hook for cleanup
- [Fastify 5 Lifecycle Documentation](https://fastify.dev/docs/latest/Reference/Lifecycle/) - request lifecycle flow
- [async-sema GitHub Repository](https://github.com/vercel/async-sema) - semaphore implementation
- [Node.js fs/promises Documentation](https://nodejs.org/api/fs.html#promises-api) - mkdtemp, rm for temp file management
- [Handling HTTP timeouts in Fastify](https://nearform.com/digital-community/handling-http-timeouts-in-fastify/) - Nearform article on timeout configuration

### Secondary (MEDIUM confidence)

- [JSDOM Issue #1682: Memory leak with window.close()](https://github.com/jsdom/jsdom/issues/1682) - async cleanup pattern
- [Limiting Concurrency in Node.js](https://itnext.io/limiting-concurrency-in-node-js-40152905970b) - concurrency patterns
- [Advanced Concurrency Patterns in JavaScript](https://medium.com/@artemkhrenov/advanced-concurrency-patterns-in-javascript-semaphore-mutex-read-write-lock-deadlock-prevention-79e8bffb5b81) - semaphore concepts
- [p-limit vs async-mutex comparison](https://npm-compare.com/async,p-all,p-limit,p-queue) - library tradeoffs
- [Preventing Memory Leaks in Node.js](https://betterstack.com/community/guides/scaling-nodejs/high-performance-nodejs/nodejs-memory-leaks/) - general best practices
- [Secure tempfiles in Node.js](https://advancedweb.hu/secure-tempfiles-in-nodejs-without-dependencies/) - temp file patterns

### Tertiary (LOW confidence - requires validation)

- [Node.js Memory Leak with jsdom](https://www.codestudy.net/blog/jsdom-and-node-js-leaking-memory/) - community blog post on JSDOM leaks
- [JSDOM memory leak discussions](https://github.com/jsdom/jsdom/issues/1665) - older GitHub issue thread
- Various Medium articles on concurrency - useful for concepts but not authoritative for API details

## Metadata

**Confidence breakdown:**
- Concurrency limiting (async-sema): HIGH - Well-documented, production-tested, clear API
- Temp file cleanup (try-finally): HIGH - Standard Node.js pattern, built-in APIs
- JSDOM cleanup pattern: MEDIUM - Multiple sources confirm async pattern, but JSDOM 24 docs don't explicitly document it. Needs production validation with memory monitoring.
- Fastify hooks integration: HIGH - Official documentation, established patterns

**Research date:** 2026-02-06
**Valid until:** 30 days (stable domain, but JSDOM versions evolve - recheck if upgrading JSDOM)

**Key unknowns requiring production validation:**
1. Actual memory footprint per document (affects optimal concurrency limit)
2. Whether JSDOM 24 still requires async window.close() pattern (GitHub issues are 2018-2019, potentially fixed)
3. Error handling edge cases in cleanup hooks (unlikely but worth monitoring)

**Next steps for planner:**
- Create tasks for modifying editorFactory.mjs to return cleanup function
- Create concurrency-limiter plugin with async-sema
- Create resource-cleanup plugin with onResponse hook
- Update read.mjs route to use semaphore + cleanup pattern
- Add environment variable for MAX_DOCUMENT_CONCURRENCY (default: 4)
- Document temp file cleanup pattern for Phase 6 (Apply endpoint)
