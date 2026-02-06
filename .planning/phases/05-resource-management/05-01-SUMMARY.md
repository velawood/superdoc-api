---
phase: 05-resource-management
plan: 01
subsystem: runtime-stability
tags: [jsdom, memory-management, semaphore, fastify, resource-cleanup]
requires: [04-01, 04-02]
provides:
  - "Deterministic JSDOM cleanup via editorFactory cleanup function"
  - "Global Fastify concurrency limiter for document processing"
  - "Global post-response cleanup hook for editor/semaphore release"
  - "Read route semaphore acquisition + error-path cleanup"
affects: [06-apply-endpoint-core]
tech-stack:
  added: [async-sema]
  patterns:
    - "Factory returns { editor, cleanup } instead of raw editor"
    - "Deferred window.close() via setImmediate to reduce JSDOM retention"
    - "Semaphore acquire in route, release in onResponse hook"
key-files:
  created:
    - src/plugins/concurrency-limiter.mjs
    - src/plugins/resource-cleanup.mjs
  modified:
    - package.json
    - package-lock.json
    - src/editorFactory.mjs
    - src/irExtractor.mjs
    - src/routes/read.mjs
    - src/app.mjs
    - src/editApplicator.mjs
duration: 15m
completed: 2026-02-06
---

# Phase 05 Plan 01 Summary

Implemented resource lifecycle controls to prevent JSDOM leaks and unbounded concurrent document processing.

## Accomplishments

1. Added `async-sema` and created a global concurrency plugin.
2. Refactored `createHeadlessEditor()` to return `{ editor, cleanup }`.
3. Implemented cleanup contract:
   - `cleanup()` destroys the editor.
   - `window.close()` is deferred with `setImmediate(...)`.
   - cleanup is idempotent and handles already-closed/already-destroyed states.
4. Updated IR extraction flows to consume and call cleanup:
   - `extractDocumentIR()`
   - `extractDocumentIRFromBuffer()`
   - `createEditorWithIR()`
5. Added `resource-cleanup` plugin:
   - Runs `request.editorCleanup()` on `onResponse`.
   - Releases `fastify.documentSemaphore` in a separate try/catch so release still happens if cleanup throws.
6. Updated `/v1/read`:
   - Acquires semaphore before editor creation.
   - Stores cleanup on `request.editorCleanup` for success-path `onResponse` cleanup.
   - On extraction errors, runs immediate cleanup + semaphore release and nulls `request.editorCleanup` to avoid double cleanup.
7. Updated app plugin registration order to:
   - `request-id` -> `error-handler` -> `multipart` -> `concurrency-limiter` -> `resource-cleanup` -> routes.

## Verification

Executed successfully:

- `node --check src/editorFactory.mjs`
- `node --check src/irExtractor.mjs`
- `node --check src/plugins/concurrency-limiter.mjs`
- `node --check src/plugins/resource-cleanup.mjs`
- `node --check src/routes/read.mjs`
- `node --check src/app.mjs`
- `node --check src/editApplicator.mjs`
- `node -e "import('./src/editorFactory.mjs').then(m => console.log(typeof m.createHeadlessEditor))"`
- `node -e "import('./src/irExtractor.mjs').then(m => console.log(typeof m.extractDocumentIR))"`
- `node -e "import('./src/app.mjs').then(m => { const app = m.default({ logger: false, apiKey: 'test' }); app.ready().then(() => { console.log('has semaphore:', !!app.documentSemaphore); app.close(); }); })"`
- `node -e "import('./src/app.mjs').then(() => console.log('OK'))"`
- `node --test tests_and_others/tests/read.test.mjs`
- `node --test tests_and_others/tests/server.test.mjs`
- `node --test tests_and_others/tests/auth.test.mjs`
- `node --test tests_and_others/tests/editApplicator.test.mjs`

All passed.

## Deviation From Plan

- Updated `src/editApplicator.mjs` to the new `createHeadlessEditor()` return shape (`{ editor, cleanup }`).
- This was required to prevent immediate breakage in existing edit/apply workflows and tests.

## Self-Check

PASSED
