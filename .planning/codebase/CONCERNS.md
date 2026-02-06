# Codebase Concerns

**Analysis Date:** 2026-02-06

## Tech Debt

**TOC Block Editing Limitations:**
- Issue: Table of Contents blocks with deeply nested link structures cause track changes to fail with ProseMirror schema validation errors
- Files: `src/editApplicator.mjs` (lines 104-154, 483-499, 600-610), `src/blockOperations.mjs` (lines 467-493)
- Impact: Users cannot edit TOC blocks with track changes enabled. Detection and error messaging exist but the feature itself is fundamentally blocked by ProseMirror's constraint handling
- Fix approach: Accept as a permanent limitation rather than attempt to circumvent ProseMirror schema. Document clearly in skill files. Consider offering fallback: offer "editing mode" (without track changes) as alternative, or manual post-processing guidance

**Truncation Warning Handling Complexity:**
- Issue: Multiple layers of truncation detection (newText validation, content corruption patterns, JSON truncation patterns) with overlapping concerns
- Files: `src/editApplicator.mjs` (lines 157-261, 706-731)
- Impact: Validation is thorough but confusing. Multiple warning types (content_warning, content_warning_strict, content_corruption) make it hard for consumers to know which warnings are recoverable
- Fix approach: Consolidate warning categories into two: "recoverable" (reductions, slight truncations) vs "critical" (JSON corruption patterns). Update `validateNewText` to use consistent severity levels

**Position Mapping Fragility in blockOperations:**
- Issue: `buildPositionMap` function iterates character-by-character through document to map text positions to editor positions. This is O(n*m) when called repeatedly and fragile to whitespace/encoding variations
- Files: `src/blockOperations.mjs` (lines 195-240)
- Impact: Can produce undefined entries in map if document structure doesn't match expected text layout (e.g., with complex markup, bookmarks). Falls back to verbose logging but doesn't fail fast
- Fix approach: Cache position maps per editor state; add defensive validation that rejects operations if more than 5% of positions are undefined; consider using SuperDoc's native block helpers if available

**Word Diff Fallback Pattern:**
- Issue: `replaceBlockById` uses word-level diff with fallback to full replacement if diff fails (lines 540-558). Fallback silently uses full replacement without warning, losing the intent of diff-mode
- Files: `src/blockOperations.mjs` (lines 540-558)
- Impact: Silent degradation. Users expect word-level diff but may get full replacement, losing visibility of what changed
- Fix approach: Always log warnings when fallback occurs; add option to fail instead of fallback; consider making fallback behavior explicit in result details

---

## Known Bugs

**Document Size Regression:**
- Symptoms: Output DOCX files are ~6x larger than input (e.g., 400KB → 2.5MB)
- Files: `src/editApplicator.mjs` (line 423), `src/editorFactory.mjs` (line 40-54)
- Cause: Unknown - likely related to SuperDoc editor state serialization or media handling when exporting with track changes
- Workaround: Documented in README "Known Issues and Workarounds" (line 745-774)
- Severity: High (file bloat causes storage/transmission issues)
- Investigation needed: Check if SuperDoc has settings to compress output or strip redundant metadata

**Amended Document IR Extraction Corruption:**
- Symptoms: When extracting IR from documents with track changes/amendments, deleted and inserted text appear concatenated in block text
- Files: `src/irExtractor.mjs` (lines 136-185)
- Cause: Node text extraction doesn't distinguish between deleted (tracked) and inserted text
- Trigger: Extract IR from .docx with existing tracked changes/revisions
- Workaround: Accept the document first, then extract IR
- Severity: Medium (affects multi-revision workflows)

**TextSelection Warning Suppression:**
- Symptoms: ProseMirror warns "TextSelection endpoint not pointing into a node with inline content" during export
- Files: `src/editApplicator.mjs` (lines 405-422)
- Cause: After bulk edits, cursor position may be invalid. The warning is benign but confusing to users
- Current mitigation: Suppress the specific warning message during export (lines 406-414)
- Concern: Suppression is fragile - relies on exact warning message text. If SuperDoc/ProseMirror changes message, suppression breaks
- Fix approach: Request native API from SuperDoc to suppress selection warnings, or find root cause and fix cursor positioning

---

## Security Considerations

**No Input Sanitization on Block Content:**
- Risk: Text passed in `newText` field is directly inserted into document without sanitization
- Files: `src/blockOperations.mjs` (lines 356-390, 410-427), `src/editApplicator.mjs` (lines 503-533)
- Current mitigation: SuperDoc's insertContent command likely handles encoding, but not verified
- Recommendations:
  - Document that special characters/markup are NOT interpreted (only plain text is inserted)
  - Add test coverage for control characters, RTL text, zero-width characters
  - Consider adding explicit text encoding validation if XSS could be vector

**Edit File Format Not Validated:**
- Risk: `editConfig` JSON structure from users is not validated against schema
- Files: `src/editApplicator.mjs` (lines 273-352), `src/editMerge.mjs` (lines 117-250)
- Current mitigation: Validation catches missing required fields, but doesn't validate field types or lengths
- Recommendations:
  - Add JSON schema validation (e.g., Zod or joi) for edit file format
  - Validate that `newText` length is within reasonable bounds (prevent memory exhaustion attacks)
  - Validate blockId format to prevent injection via field names

**No Rate Limiting on File Operations:**
- Risk: CLI tool can process arbitrarily large edit batches without throttling
- Files: `src/editApplicator.mjs` (line 360-380), `src/editMerge.mjs` (line 130-250)
- Current mitigation: None observed
- Recommendations:
  - Add limit on maximum number of edits per batch (e.g., 1000)
  - Add memory usage monitoring during edit application

---

## Performance Bottlenecks

**Defined Terms Extraction O(n²) Complexity:**
- Problem: Second pass of `extractDefinedTerms` checks every extracted term against every block (lines 294-306 in `src/irExtractor.mjs`)
- Files: `src/irExtractor.mjs` (lines 272-309)
- Cause: No index built; uses string.includes() which is O(m) for each of n terms against n blocks
- Impact: On large documents (1000+ blocks with 100+ defined terms), extraction becomes slow
- Improvement path: Build inverted index of term positions first; use Set for O(1) lookup

**Position Mapping is Recalculated Per Operation:**
- Problem: Each word diff operation rebuilds the full position map (line 294 in `src/blockOperations.mjs`)
- Files: `src/blockOperations.mjs` (lines 265-454)
- Cause: No caching of position maps between operations
- Impact: When applying multiple edits to same block, position map is recalculated each time
- Improvement path: Cache position map keyed by (editorState hash, blockId); invalidate on document mutation

**IR Extraction Traverses Document Multiple Times:**
- Problem: Block extraction, outline building, and defined terms extraction all traverse blocks separately
- Files: `src/irExtractor.mjs` (lines 29-76)
- Impact: Moderate (3 traversals instead of 1)
- Improvement path: Single-pass extraction building all three structures

**Editor Initialization for Validation:**
- Problem: `validateEdits` function creates a full editor just to validate (line 625-631 in `src/editApplicator.mjs`)
- Files: `src/editApplicator.mjs` (lines 625-631)
- Impact: Validation is 10-50ms slower than needed; primarily affects CLI performance
- Improvement path: Add a lightweight validation-only path that doesn't load the editor

---

## Fragile Areas

**Editor State Assumption in blockOperations:**
- Files: `src/blockOperations.mjs` (lines 95-115, 195-240)
- Why fragile: Code assumes `editor.state.doc.descendants` will always find blocks by matching `node.attrs.sdBlockId`. If SuperDoc changes attribute naming or node structure, lookups break silently (return null)
- Safe modification:
  - Always null-check results from getBlockInfo
  - Add logging when attribute lookups fail
  - Test with different SuperDoc versions
- Test coverage: Moderate - `blockOperations.test.mjs` covers happy path but limited edge cases

**Markdown Edit Parser Regex Patterns:**
- Files: `src/markdownEditsParser.mjs` (lines 79, 89)
- Why fragile: Regex patterns for table and newText section parsing are tightly coupled to markdown format. Minor formatting changes (extra spaces, different heading levels) cause parsing to fail silently
- Safe modification:
  - Add lenient whitespace handling
  - Test with various markdown formatting (different # levels, spacing)
  - Add error reporting when table parsing fails
- Test coverage: `markdownEditsParser.test.mjs` exists but check if edge cases covered

**Fuzzy Match Tier-Based Strategy:**
- Files: `src/fuzzyMatch.mjs` (lines 107-154)
- Why fragile: Three-tier matching (exact → smart quote → fuzzy regex) with no fallback. If all three fail, returns null silently. Fuzzy regex can produce false positives with markdown-heavy text
- Safe modification:
  - Add logging to track which tier matched
  - Add optional fourth tier: Levenshtein distance for close matches
  - Test with various text encodings
- Test coverage: `fuzzyMatch.test.mjs` exists; verify coverage

**Edit Merge Conflict Resolution with Source Tracking:**
- Files: `src/editMerge.mjs` (lines 117-250, 177-181)
- Why fragile: Conflict detection only checks `blockId` but not operation type. Two edits for different operations on same block (replace + comment) are not flagged as conflicts but should be
- Safe modification:
  - Group conflicts by (blockId, operation) tuple instead of just blockId
  - Test multi-agent scenarios with overlapping but non-conflicting operations
- Test coverage: `editMerge.test.mjs` exists; verify conflict scenario coverage

---

## Scaling Limits

**Document Size:**
- Current capacity: Successfully tested with 100+ page contracts
- Limit: No hard limit observed, but performance degrades with 1000+ blocks due to traversal costs
- Scaling path:
  - Implement block index/caching
  - Add lazy loading for outline/defined terms
  - Consider pagination for chunk reading

**Edit Batch Size:**
- Current capacity: No documented limit observed; tests use <50 edits
- Limit: Likely ~1000 edits before memory becomes issue (especially with word diff)
- Scaling path:
  - Add batch processing mode (apply N edits, checkpoint, apply next N)
  - Add memory monitoring during apply

**Concurrent Operations:**
- Current capacity: Sequential only (no async parallelization)
- Limit: Cannot apply edits to multiple files in parallel from CLI
- Scaling path: Would require significant refactoring (editor state management per file)

---

## Dependencies at Risk

**@harbour-enterprises/superdoc (^1.0.0):**
- Risk: Single point of failure for all editor functionality. Any breaking change requires major refactoring
- Impact: Unable to edit if SuperDoc API changes (especially around Editor.loadXmlData, editor.state.doc.descendants, commands API)
- Migration plan:
  - Keep version lock tight in package-lock.json (currently done)
  - Add integration tests with specific SuperDoc versions
  - Consider wrapper abstraction for SuperDoc API calls to isolate changes

**JSDOM (^24.0.0):**
- Risk: Provides virtual DOM for headless editing. Updates could introduce subtle behavioral changes
- Impact: Document parsing/export could be affected
- Migration plan: Monitor JSDOM changelog; pin major version; test against new versions before upgrading

**archiver & unzipper (compression libraries):**
- Risk: DOCX file handling depends on these. Any breaking change breaks document I/O
- Impact: Cannot read/write DOCX files
- Migration plan: These are relatively stable; less risk than SuperDoc

---

## Missing Critical Features

**No Validation of Block ID References:**
- Problem: If `edits.json` references block ID that doesn't exist, the edit is silently skipped with error reporting. No way to distinguish intentional deletion from typo
- Blocks: `src/editApplicator.mjs` (lines 476-481)
- Risk: Users don't notice when edits fail due to wrong block ID
- Suggestion: Add strict mode that requires all referenced blocks to exist before processing

**No Schema Validation for Edit Format:**
- Problem: Edit files have no formal schema. Different sources may create different formats that work but are hard to standardize
- Files: `src/editApplicator.mjs`, `src/editMerge.mjs`
- Suggestion: Add JSON schema file (`edits-schema.json`) and validate all inputs against it

**No Versioning/Migration for Edit Format:**
- Problem: If edit format changes (new operation types, field structure), old edit files break
- Files: All edit-related modules
- Risk: Hard to maintain backward compatibility
- Suggestion: Add version-aware parser that handles multiple edit format versions

**No Audit Trail:**
- Problem: No record of which edits were applied, when, by whom, or what the document state was before/after
- Impact: Difficult to debug multi-agent workflows or trace change origins
- Suggestion: Add optional audit log output (append-only JSON file with edit results, timestamps, block checksums)

---

## Test Coverage Gaps

**TOC Block Edge Cases:**
- What's not tested: Different types of TOC structures (nested bookmarks, hyperlinks, page breaks)
- Files: `tests_and_others/tests/editApplicator.test.mjs` (has TOC detection tests but limited edge cases)
- Risk: TOC detection heuristics (lines 113-127 in `src/editApplicator.mjs`) may false-positive or false-negative
- Priority: Medium (workaround exists)

**Position Mapping Failures:**
- What's not tested: Documents with complex internal structure (multiple runs, bookmarks, form fields, comments)
- Files: `tests_and_others/tests/blockOperations.test.mjs`
- Risk: Position map undefined entries could corrupt text in edge cases
- Priority: High (affects edit correctness)

**Amended Document IR Extraction:**
- What's not tested: IR extraction from documents with existing track changes at various stages
- Files: `tests_and_others/tests/irExtractor.test.mjs`
- Risk: Users working with amended documents may get corrupted IR
- Priority: Medium (workaround documented)

**Multi-Agent Merge with Same-Block Different-Operations:**
- What's not tested: Merge where two agents edit same block with different operations (replace + comment, or insert before + insert after)
- Files: `tests_and_others/tests/editMerge.test.mjs`
- Risk: Conflict detection assumes conflicts only occur for same operation type
- Priority: Medium (edge case in multi-agent workflows)

**CLI Error Handling:**
- What's not tested: Malformed edit files, missing input files, corrupted DOCX, permission errors
- Files: `tests_and_others/tests/cli.test.mjs`
- Risk: Unclear error messages, confusing exit codes
- Priority: Low (UX issue, not data corruption)

**Fuzzy Matching with RTL/Special Text:**
- What's not tested: Matching in documents with right-to-left text (Arabic, Hebrew), emoji, control characters
- Files: `tests_and_others/tests/fuzzyMatch.test.mjs`
- Risk: Fuzzy matching may fail in multilingual documents
- Priority: Low (affects international contracts)

---

## Summary of Risk Assessment

| Issue | Severity | Effort to Fix | Recommendation |
|-------|----------|---------------|-----------------|
| TOC Block Limitations | High | N/A (fundamental) | Document clearly, offer non-tracked alternative |
| Document Size Regression | High | Unknown | Investigate SuperDoc export options |
| Position Mapping Fragility | High | Medium | Add caching and validation |
| Word Diff Silent Fallback | Medium | Low | Log warnings, make behavior explicit |
| Performance: O(n²) defined terms | Medium | Low | Add indexing |
| Edit Format No Schema | Medium | Medium | Add JSON schema validation |
| Security: No input sanitization | Medium | Low | Add character validation tests |
| Test coverage gaps | Medium | Medium | Expand edge case coverage |
| No audit trail | Low | Medium | Add optional audit log feature |

---

*Concerns audit: 2026-02-06*
