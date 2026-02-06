# Architecture

**Analysis Date:** 2026-02-06

## Pattern Overview

**Overall:** Multi-layer pipeline architecture with distinct phases for document processing, ID management, and edit application.

**Key Characteristics:**
- Separation of concerns across specialized modules
- Headless editor abstraction for Node.js DOCX manipulation
- Intermediate representation (IR) as central data model
- ID-based position-independent editing using dual UUID + sequential IDs
- Pipeline stages: Extract → Read/Chunk → Validate → Apply
- CLI-driven orchestration layer

## Layers

**Presentation Layer (CLI):**
- Purpose: Command dispatch and user-facing interface
- Location: `superdoc-redline.mjs`
- Contains: Commander.js CLI commands (extract, read, validate, apply, merge, parse-edits)
- Depends on: All domain modules, file I/O
- Used by: End users and AI agents

**Document I/O Layer:**
- Purpose: DOCX file reading/writing and headless editor creation
- Location: `src/editorFactory.mjs`
- Contains: Editor instantiation with JSDOM virtual DOM, file loading, buffer handling
- Depends on: @harbour-enterprises/superdoc library, jsdom
- Used by: IR extractor, edit applicator

**IR Extraction Layer:**
- Purpose: Transform raw DOCX documents into structured intermediate representation
- Location: `src/irExtractor.mjs`
- Contains: Block extraction, ID assignment, block structure analysis
- Depends on: Editor factory, ID manager, clause parser, block utilities
- Used by: Document reader, edit applicator, validation

**ID Management Layer:**
- Purpose: Maintain dual UUID/sequential ID mapping for position-independent edits
- Location: `src/idManager.mjs`
- Contains: ID generation, UUID↔seqId bidirectional mapping, ID resolution
- Depends on: crypto.randomUUID()
- Used by: IR extractor, edit applicator, block operations

**Document Reading Layer:**
- Purpose: Prepare documents for LLM consumption with automatic chunking
- Location: `src/documentReader.mjs`
- Contains: Token estimation, chunking orchestration, format selection
- Depends on: IR extractor, chunking module
- Used by: CLI read command

**Chunking Layer:**
- Purpose: Split large document IRs into manageable chunks while preserving structure
- Location: `src/chunking.mjs`
- Contains: Token estimation, chunk boundary detection at heading levels, metadata generation
- Depends on: None (pure utilities)
- Used by: Document reader

**Edit Application Layer:**
- Purpose: Execute document modifications with track changes support
- Location: `src/editApplicator.mjs`
- Contains: Edit validation, sorting for safe application, operation execution, comment handling
- Depends on: IR extractor, block operations, edit merge (for normalization)
- Used by: CLI apply command

**Block Operations Layer:**
- Purpose: Low-level document modifications via ProseMirror transactions
- Location: `src/blockOperations.mjs`
- Contains: Replace/delete/insert/comment operations, ID resolution, diff application
- Depends on: Word diff, text utilities
- Used by: Edit applicator

**Edit Merge Layer:**
- Purpose: Combine edits from multiple sources with conflict resolution
- Location: `src/editMerge.mjs`
- Contains: Multi-file merge, conflict detection/resolution strategies, edit normalization
- Depends on: File I/O
- Used by: CLI merge command, edit applicator

**Text Processing Layer:**
- Purpose: Diff computation, text normalization, fuzzy matching
- Location: `src/wordDiff.mjs`, `src/textUtils.mjs`, `src/fuzzyMatch.mjs`
- Contains: Word-level diff via DMP, text normalization, fuzzy regex matching
- Depends on: diff-match-patch library
- Used by: Block operations

**Parsing Layer:**
- Purpose: Document structure analysis (clauses, headings, defined terms)
- Location: `src/clauseParser.mjs`, `src/markdownEditsParser.mjs`
- Contains: Clause numbering detection, heading analysis, clause hierarchy building, markdown edit parsing
- Depends on: None
- Used by: IR extractor, markdown format support

## Data Flow

**Extract Workflow:**

1. User → CLI extract command with DOCX path
2. `editorFactory.createHeadlessEditor()` loads DOCX into virtual DOM
3. `irExtractor.extractDocumentIR()` processes loaded document
4. `idManager` generates/registers block IDs
5. Block iteration via `editor.state.doc.descendants()`
6. `clauseParser.analyzeHeading()` and `clauseParser.parseClauseNumber()` determine block type
7. JSON IR written to file with blocks, outline, defined terms, ID mapping

**Read Workflow:**

1. User → CLI read command with DOCX path
2. `documentReader.readDocument()` extracts IR and estimates tokens
3. `chunking.chunkDocument()` splits into token-aware chunks at heading boundaries
4. Each chunk includes full outline for LLM context
5. JSON output with metadata, block ranges, CLI commands for navigation

**Validate Workflow:**

1. User → CLI validate command with DOCX + edits JSON
2. `editApplicator.validateEdits()` loads document and parses edits
3. For each edit: verify block ID exists via `blockOperations.resolveBlockId()`
4. Type-specific validation (e.g., text presence for word-diff operations)
5. Report issues/warnings without modifying document

**Apply Workflow:**

1. User → CLI apply command with DOCX + edits JSON/markdown + output path
2. Optional markdown parsing via `markdownEditsParser.parseMarkdownEdits()`
3. `editApplicator.applyEdits()` loads document
4. Validation runs first (unless skipped)
5. Edits sorted in descending position order for safe application
6. For each edit: `blockOperations.replaceBlockById()`, `deleteBlockById()`, etc.
7. Word-level diff applied if `diff: true`
8. Transactions dispatched via `dispatchTransaction()`
9. Modified document exported via `editor.exportXml()`
10. DOCX written to output path with track changes metadata

**Merge Workflow:**

1. User → CLI merge command with multiple edit files
2. `editMerge.mergeEditFiles()` loads all files
3. Conflict detection when same block edited by multiple sources
4. Conflict strategy applied (error/first/last/combine)
5. Merged edits array written to output file
6. Optional validation against document IR

## State Management

**Document State:**
- Loaded in memory as ProseMirror document via SuperDoc editor
- Mutations via transactions (immutable updates)
- No persistent state between commands

**ID Mapping State:**
- Ephemeral: generated fresh per extraction
- Exported in IR as idMapping object for later reference
- Restored on demand when resolving block IDs during edit application

**Edit State:**
- JSON/markdown structures loaded from files
- Sorted and validated before application
- Execution order matters (descending position)

## Key Abstractions

**Block:**
- Represents a content unit (paragraph, heading, list item, etc.)
- Properties: `id` (seqId), `type`, `text`, `level` (for headings), `parent`
- Lives in: IR blocks array
- Pattern: Extracted from ProseMirror nodes, assigned stable IDs

**DocumentIR (Intermediate Representation):**
- Portable JSON format of structured document
- Properties: `metadata`, `blocks[]`, `outline[]`, `definedTerms{}`, `idMapping{}`
- Purpose: Decouples document analysis from editing, enables offline processing
- Example: `{metadata: {blockCount: 142}, blocks: [{id: "b001", type: "paragraph", text: "..."}]}`

**Edit:**
- Instruction for a single document modification
- Properties: `operation` (replace/delete/comment/insert), `blockId`, `newText`, `comment`, `diff`
- Pattern: Applied in position order, validated before application
- Example: `{operation: "replace", blockId: "b005", newText: "Updated text", diff: true}`

**IdManager:**
- Maintains bidirectional UUID↔seqId mapping
- Purpose: Provide human-readable IDs (b001) while preserving SuperDoc's native UUIDs
- Methods: generateId(), registerExistingId(), resolveToUuid(), exportMapping()

**Editor (Headless):**
- SuperDoc editor instance without DOM/view
- Initialized in JSDOM sandbox
- Methods: loadXmlData(), descendants(), dispatch(), exportXml()
- Lifecycle: Created per document, destroyed after operation

## Entry Points

**CLI Entry Point:**
- Location: `superdoc-redline.mjs`
- Triggers: User runs `node superdoc-redline.mjs <command>`
- Responsibilities: Parse arguments, dispatch to command handlers, handle errors, exit codes

**extract Command:**
- Location: `superdoc-redline.mjs` lines 58-98
- Triggers: `superdoc-redline extract -i doc.docx -o ir.json`
- Responsibilities: Load DOCX, extract IR, output JSON

**read Command:**
- Location: `superdoc-redline.mjs` lines 104-144
- Triggers: `superdoc-redline read -i doc.docx [--chunk N]`
- Responsibilities: Extract IR, estimate tokens, chunk if needed, format output

**apply Command:**
- Location: `superdoc-redline.mjs` lines 191-283
- Triggers: `superdoc-redline apply -i doc.docx -o out.docx -e edits.json`
- Responsibilities: Load DOCX, validate edits, apply modifications, export DOCX

**merge Command:**
- Location: `superdoc-redline.mjs` lines 289-350
- Triggers: `superdoc-redline merge file1.json file2.json -o merged.json`
- Responsibilities: Load multiple edit files, detect conflicts, merge, output combined edits

## Error Handling

**Strategy:** Fail-fast with detailed error messages. Validation before application prevents data loss.

**Patterns:**

**Position Resolution Errors:**
- Module: `blockOperations.resolveBlockId()`
- Approach: Returns null if block ID not found
- Handler: `editApplicator` marks edit as skipped with reason
- Outcome: Can skip invalid edit or fail entire batch (configurable)

**Edit Validation:**
- Module: `editApplicator.validateEdits()`
- Checks: Block existence, text presence for diff operations, truncation risk
- Result: Array of issues + warnings
- Handler: CLI reports issues, exits 1 if any blocking issues

**Transaction Errors:**
- Module: `blockOperations` via ProseMirror
- Approach: Catch transaction dispatch errors
- Handler: Log error, mark edit as skipped
- Fallback: Continues with next edit unless `skipInvalid: false`

**File I/O Errors:**
- Module: CLI commands (readFile, writeFile)
- Approach: Try-catch with descriptive error logging
- Handler: Error message to stderr, process.exit(1)

## Cross-Cutting Concerns

**Logging:**
- Approach: console.log/console.error via CLI commands
- Levels: Informational (success summaries), Error (failures), Verbose (--verbose flag for debugging)
- Pattern: Each command logs before/after state

**Validation:**
- Entry point: `editApplicator.validateEdits()` called before application
- Scope: Block IDs exist, edit types valid, text presence for operations, truncation risk
- Output: `ValidationResult` with issues array and warnings array
- Used by: apply command (configurable via --validate flag)

**Authentication:**
- Approach: Author metadata passed through edits
- Fields: `{name: "AI Assistant", email: "ai@example.com"}` (defaults)
- Used by: Track changes metadata, comment authorship
- Pattern: Set via CLI flags (--author-name, --author-email) or edit config

**Performance:**
- Token estimation: `chunking.estimateTokens()` uses character count / 4
- Chunking: O(blocks) to compute boundaries
- Diff: DMP library optimized for character/word-level comparison
- No caching: Fresh processing per command (stateless)

