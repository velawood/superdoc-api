# External Integrations

**Analysis Date:** 2026-02-06

## APIs & External Services

**Not applicable** - This codebase contains no external API integrations. All operations are performed locally on document files.

## Data Storage

**Databases:**
- None - No database connectivity

**File Storage:**
- Local filesystem only - All input/output is file-based (DOCX documents, JSON metadata files)
- DOCX files handled via archiver/unzipper packages for internal manipulation
- Working directory must have read/write permissions

**Caching:**
- None

## Authentication & Identity

**Auth Provider:**
- None - No external authentication

**Author Attribution:**
- Track changes metadata: Author name and email configured per-operation
  - Default: `{ name: 'AI Assistant', email: 'ai@example.com' }`
  - Configurable via `user` option in `src/editorFactory.mjs` or CLI flags
  - Embedded in DOCX file comments and track changes (Word-native metadata)

## Monitoring & Observability

**Error Tracking:**
- None

**Logs:**
- Console logging only - Messages written to `stdout` and `stderr`
- No structured logging, no log aggregation
- Log calls: `console.log()`, `console.error()`
- Typical messages: operation progress, block counts, output file paths

## CI/CD & Deployment

**Hosting:**
- Cloud-agnostic - Runs as Node.js process
- Compatible with: Lambda, Cloud Functions, containers, server, CLI

**CI Pipeline:**
- None configured in this repository
- Tests run via `npm test` command (Node.js native test runner)

## Environment Configuration

**Required env vars:**
- None - All configuration is file-based or passed via CLI arguments

**Secrets location:**
- No secrets management required
- No API keys, credentials, or sensitive data to manage

## Webhooks & Callbacks

**Incoming:**
- None - CLI tool, not a server

**Outgoing:**
- None - No outbound integrations

## Programmatic Integration Points

The library can be imported and used programmatically:

**Main Functions:**
- `extractDocumentIR()` - `src/irExtractor.mjs` - Extract document structure
- `readDocument()` - `src/documentReader.mjs` - Read document for LLM consumption
- `applyEdits()` - `src/editApplicator.mjs` - Apply tracked changes to document
- `validateEdits()` - `src/editApplicator.mjs` - Validate edits before application
- `mergeEditFiles()` - `src/editMerge.mjs` - Merge edits from multiple sources

**No external libraries required for programmatic use** - All dependencies bundled via npm.

## Data Flow

1. **Input:** DOCX file (from filesystem)
2. **Processing:** SuperDoc editor + transformation modules
3. **Output:** Modified DOCX file (to filesystem) + optional JSON metadata
4. **No network calls** at any stage

---

*Integration audit: 2026-02-06*
