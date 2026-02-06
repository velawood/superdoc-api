# Coding Conventions

**Analysis Date:** 2026-02-06

## Naming Patterns

**Files:**
- Module files use `.mjs` extension (ES modules)
- Descriptive, camelCase names that reflect module purpose
  - Examples: `editApplicator.mjs`, `documentReader.mjs`, `wordDiff.mjs`
- Test files follow `{module}.test.mjs` pattern
  - Examples: `editApplicator.test.mjs`, `chunking.test.mjs`

**Functions:**
- camelCase for exported functions: `validateEditsAgainstIR()`, `estimateTokens()`, `computeWordDiff()`
- camelCase for private functions: `countOutlineItems()`, `findBreakPoint()`, `encodeText()`
- Verb-noun pattern for action functions: `replaceBlockById()`, `deleteBlockById()`, `addCommentToBlock()`
- Boolean functions use `is*` or `has*` prefix: `isTocBlock()`, `detectTocStructure()`

**Variables:**
- camelCase for local variables and constants: `blockTokens`, `editsByBlockId`, `totalChunks`
- UPPER_CASE for regex constants: `TOKEN_REGEX = /(\w+|[^\w\s]+|\s+)/g`
- Single uppercase letter for loop iterators in small scopes: `for (const e of edits)`
- Descriptive names for important values: `availableForBlocks`, `fixedOverhead`, `blockRange`

**Types:**
- JSDoc typedef blocks for complex types (see "Comments" section)
- PascalCase for typedef names: `BlockRange`, `ChunkMetadata`, `Edit`, `ValidationResult`
- `[fieldName]` notation for JSDoc property documentation

## Code Style

**Formatting:**
- No linting configuration file detected (eslint/prettier not configured)
- Consistent style observed across codebase:
  - 2-space indentation
  - Semicolons required at end of statements
  - Double quotes for strings
  - Single quotes acceptable for character constants
  - Space before opening brace: `if (condition) {`
  - No space between function name and parentheses for calls

**Example formatting from `src/idManager.mjs`:**
```javascript
export class IdManager {
  constructor() {
    this.uuidToSeq = new Map();  // UUID -> seqId
    this.seqToUuid = new Map();  // seqId -> UUID
    this.counter = 0;
  }

  generateId() {
    const uuid = crypto.randomUUID();
    const seqId = this.formatSeqId(++this.counter);
    return { uuid, seqId };
  }
}
```

## Import Organization

**Order:**
1. Node.js built-in modules (`fs/promises`, `path`, `child_process`)
2. Third-party packages (`commander`, `jsdom`, `archiver`)
3. Local project modules (relative imports starting with `./` or `../`)

**Examples from codebase:**
```javascript
// From src/editApplicator.mjs
import { readFile, writeFile } from 'fs/promises';
import { createHeadlessEditor } from './editorFactory.mjs';
import { extractIRFromEditor } from './irExtractor.mjs';
import {
  replaceBlockById,
  deleteBlockById,
  insertAfterBlock,
  addCommentToBlock
} from './blockOperations.mjs';
```

**Path Aliases:**
- No path alias configuration detected
- All imports use relative paths (`./`, `../`)

## Error Handling

**Patterns:**
- Try-catch for defensive error handling of external operations:
  - Editor selection/blur operations (may fail but don't affect output)
  - File system operations (JSON parsing, file write failures)
  - Optional cleanup operations
- Errors are caught and handled with meaningful context
- Silent catch blocks used only when error is non-critical to result

**Example from `src/editApplicator.mjs`:**
```javascript
try {
  if (editor.commands && editor.commands.setTextSelection) {
    editor.commands.setTextSelection(1);
  } else if (editor.commands && editor.commands.blur) {
    editor.commands.blur();
  }
} catch (e) {
  // Ignore selection errors - they don't affect document output
}
```

**Validation pattern:**
- Functions validate inputs and return structured result objects with `valid` field
- Issues reported in `issues` array with `type`, `editIndex`, `blockId`, `message` fields
- Warnings tracked separately for non-blocking issues

```javascript
// From validateEditsAgainstIR return structure
{
  valid: boolean,
  issues: Array<{type, editIndex, blockId, message}>,
  warnings: Array<ValidationWarning>,
  summary: {totalEdits, validEdits, invalidEdits, warningCount}
}
```

## Logging

**Framework:** Console methods only (no logging framework)

**Patterns:**
- `console.log()` for informational output in CLI commands
- Progress messages include operation name and result counts
- Verbose logging controlled by options parameter in functions (rarely used)
- Error messages go to stderr via `console.error()` (implicit in Node.js execution)

**Example from `superdoc-redline.mjs`:**
```javascript
console.log(`Extracting IR from: ${inputPath}`);
console.log(`Extraction complete!`);
console.log(`Blocks: ${ir.blocks.length}`);
```

## Comments

**When to Comment:**
- Complex algorithms explaining the approach (diff algorithm, chunking logic)
- Non-obvious regex patterns explaining what they match
- Design decisions explaining why a particular approach was chosen
- Edge cases and workarounds explaining limitations

**JSDoc/TSDoc:**
- Comprehensive JSDoc for all exported functions
- @typedef blocks for complex data structures
- @param with type and description for all parameters
- @returns with type and description for return values
- Multi-line descriptions for complex logic

**Example from `src/wordDiff.mjs`:**
```javascript
/**
 * Compute word-level diff between two texts
 *
 * @param {string} text1 - Original text
 * @param {string} text2 - Modified text
 * @returns {Array<[number, string]>} - Array of [operation, text] tuples
 *   where operation is: 0 (equal), -1 (delete), 1 (insert)
 */
export function computeWordDiff(text1, text2) {
```

**Inline comments:**
- Short, single-line comments on same line or above code
- Explain "why" not "what" - code is clear on what it does
- Useful for tracking precision expectations

```javascript
// Token regex - matches words, punctuation, and whitespace separately
const TOKEN_REGEX = /(\w+|[^\w\s]+|\s+)/g;

// Add overhead for JSON structure (~50 tokens for block metadata)
const structureOverhead = 50;
```

## Function Design

**Size:**
- Typically 30-80 lines for complex functions
- Longer functions (100+ lines) used for orchestration with clear logical sections
- Examples: `applyEdits()` (145 lines), `chunkDocument()` (100+ lines with internal helpers)

**Parameters:**
- Positional parameters for required arguments
- Options object as last parameter for optional/configuration parameters
- Default values specified in function signature: `export function chunkDocument(ir, maxTokens = 100000)`
- JSDoc specifies parameter types as `@param {Type} name - description`

**Return Values:**
- Single value for simple operations: `function tokenize(text)` returns `string[]`
- Structured objects for complex results:

```javascript
// From chunking.mjs
export function chunkDocument(ir, maxTokens = 100000) {
  // Returns array of chunk objects
  return chunks;  // Each chunk: {metadata, outline, blocks, idMapping}
}

// From wordDiff.mjs
export function getDiffStats(text1, text2) {
  // Returns: {added, deleted, unchanged, totalBefore, totalAfter, percentChanged}
  return { added, deleted, unchanged, totalBefore, totalAfter, percentChanged };
}
```

## Module Design

**Exports:**
- Mix of individual function exports and class exports
- No barrel files (index.js pattern) - each module imported directly
- Example imports from CLI show fine-grained imports:
  ```javascript
  import { extractDocumentIR } from './src/irExtractor.mjs';
  import { applyEdits, validateEdits } from './src/editApplicator.mjs';
  ```

**Classes:**
- Used for stateful abstractions: `IdManager` for managing UUID/seqId mapping
- Constructor initializes state with Maps/counters
- Methods use camelCase: `generateId()`, `registerExistingId()`, `getSeqId()`, `resolveToUuid()`

**Internal Helpers:**
- Private functions (no export keyword) used extensively
- Examples: `countOutlineItems()`, `findBreakPoint()`, `createNewChunk()`, `encodeText()`
- Single underscore prefix not used (convention not followed)

---

*Convention analysis: 2026-02-06*
