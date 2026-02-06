# Superdoc API

## What This Is

An HTTP API that exposes superdoc-redline's document editing and extraction capabilities as a hosted service. End users POST DOCX files and edits (JSON or markdown format) and receive edited documents or structured IR back — no Node.js installation required.

## Core Value

Users can programmatically edit DOCX documents with track changes via simple HTTP requests, without installing any local tooling.

## Requirements

### Validated

- ✓ Extract structured IR from DOCX documents — existing CLI
- ✓ Read documents with auto-chunking for LLM consumption — existing CLI
- ✓ Apply ID-based edits with track changes (replace, delete, insert, comment) — existing CLI
- ✓ Word-level diff for minimal tracked changes — existing CLI
- ✓ Validate edits against document before applying — existing CLI
- ✓ Parse markdown edits to JSON format — existing CLI
- ✓ Recompress DOCX output files — existing CLI
- ✓ Dual UUID/seqId block identification system — existing CLI

### Active

- [ ] POST endpoint to apply edits (docx + JSON/markdown edits → redlined docx)
- [ ] POST endpoint to extract/read document (docx → IR JSON with all chunks)
- [ ] Auto-validation before applying edits (reject with detailed errors if invalid)
- [ ] Auto-recompression of output DOCX files
- [ ] API key authentication (Bearer token)
- [ ] Multipart file upload handling for DOCX files
- [ ] Proper error responses with structured JSON error bodies
- [ ] Health check endpoint

### Out of Scope

- Merge endpoint — multi-agent merge is an orchestration concern, not a single-request operation
- find-block endpoint — search is part of the read/extract workflow
- User management / signup — API keys managed outside the service
- File storage — stateless request/response only, no persisted documents
- WebSocket or streaming — simple request/response is sufficient
- Rate limiting — handled at infrastructure level (reverse proxy / API gateway)
- OAuth / complex auth — API key is sufficient for programmatic access

## Context

- Existing CLI is production-grade with comprehensive test coverage
- Core editing logic is well-separated from CLI layer (Commander.js)
- All domain modules (irExtractor, editApplicator, documentReader, etc.) are importable ESM modules
- SuperDoc requires JSDOM virtual DOM — memory-intensive per document load
- DOCX files can be large; recompression reduces ~6x size overhead from SuperDoc output
- The service is stateless — each request loads, processes, and returns independently

## Constraints

- **Runtime**: Node.js 18+ — required by SuperDoc and existing codebase
- **Language**: JavaScript ESM — must integrate with existing modules, no rewrite
- **Dependencies**: @harbour-enterprises/superdoc, jsdom, diff-match-patch — non-negotiable core deps
- **Stateless**: No server-side file storage — process and return in single request/response

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Hosted service (not Docker-first) | End users should not need to run anything locally | — Pending |
| API key auth | Simple, sufficient for programmatic access | — Pending |
| Always recompress output | Users should always get compact DOCX files | — Pending |
| Auto-validate before apply | Fail fast with clear errors rather than partial application | — Pending |
| Return all chunks at once for read | Simpler API surface; pagination adds complexity without clear need yet | — Pending |

---
*Last updated: 2026-02-06 after initialization*
