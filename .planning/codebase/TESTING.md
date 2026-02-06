# Testing Patterns

**Analysis Date:** 2026-02-06

## Test Framework

**Runner:**
- Node.js built-in test module (node:test)
- No external test framework (Jest, Vitest, Mocha) configured
- Executed via `npm test` which runs: `node --test tests_and_others/tests/*.test.mjs`

**Assertion Library:**
- Node.js built-in assert module with strict mode
- Import pattern: `import assert from 'node:assert/strict';`
- Provides: assert.equal(), assert.ok(), assert.deepEqual(), assert.strictEqual(), etc.

**Run Commands:**
```bash
npm test                    # Run all tests
node --test tests_and_others/tests/*.test.mjs  # Explicit run
node --test tests_and_others/tests/chunking.test.mjs  # Single test file
```

## Test File Organization

**Location:**
- Co-located in `tests_and_others/tests/` directory (separate from `src/`)
- All test files in single directory (flat structure, not mirrored to source structure)

**Naming:**
- Pattern: `{module}.test.mjs`
- Examples:
  - `chunking.test.mjs` for `src/chunking.mjs`
  - `editApplicator.test.mjs` for `src/editApplicator.mjs`
  - `wordDiff.test.mjs` for `src/wordDiff.mjs`
  - `cli.test.mjs` for CLI commands in `superdoc-redline.mjs`

**Structure:**
```
tests_and_others/
├── tests/
│   ├── chunking.test.mjs
│   ├── editApplicator.test.mjs
│   ├── wordDiff.test.mjs
│   ├── integration.test.mjs
│   ├── cli.test.mjs
│   ├── fixtures/              # Test data files
│   │   ├── sample.docx
│   │   ├── asset-purchase.docx
│   │   └── ...
│   └── output/                # Generated test outputs
└── ...
```

## Test Structure

**Suite Organization:**
```javascript
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

describe('Module or Feature Name', () => {
  describe('Nested Suite Name', () => {
    it('should perform specific behavior', () => {
      // Arrange
      const input = 'test value';

      // Act
      const result = functionUnderTest(input);

      // Assert
      assert.equal(result, 'expected value');
    });
  });
});
```

**Patterns:**
- Top-level describe() wraps entire test file
- Nested describe() blocks organize tests by feature/function
- Single responsibility per test: one behavior per it() block
- Descriptive test names starting with "should" or verb

**Setup and Teardown:**
- before() - Runs once before all tests in suite (load fixtures)
- after() - Runs once after all tests (cleanup temp files)
- beforeEach() - Runs before each test (reset state)
- Cleanup of temporary files in after() with error suppression:

```javascript
after(async () => {
  const tempFiles = [
    '/tmp/test-ir.json',
    '/tmp/valid-edits.json',
    '/tmp/apply-edits.json'
  ];
  for (const file of tempFiles) {
    try {
      await unlink(file);
    } catch (e) {
      // Ignore if file doesn't exist
    }
  }
});
```

## Mocking

**Framework:** No external mocking library detected

**Patterns:**
- Test helpers (factory functions) create mock objects
- Example from `chunking.test.mjs`:

```javascript
function createMockIR(numBlocks, textLength = 100) {
  const blocks = [];
  for (let i = 0; i < numBlocks; i++) {
    blocks.push({
      id: `uuid-${i}`,
      seqId: `b${String(i + 1).padStart(3, '0')}`,
      type: i % 10 === 0 ? 'heading' : 'paragraph',
      text: 'A'.repeat(textLength),
      startPos: i * 100,
      endPos: i * 100 + textLength
    });
  }
  return {
    blocks,
    outline: [{ id: 'uuid-0', seqId: 'b001', title: 'Section 1', children: [] }],
    metadata: { filename: 'test.docx', version: '0.2.0', blockCount: numBlocks },
    idMapping: Object.fromEntries(blocks.map(b => [b.id, b.seqId]))
  };
}
```

- CLI tests use execSync() to run actual commands (integration testing approach)
- Real document fixtures stored in `tests_and_others/tests/fixtures/`

**What to Mock:**
- Complex object structures for unit tests (factory functions)
- File system reads/writes for isolated tests
- Mock data generators for large datasets (token estimation tests)

**What NOT to Mock:**
- Actual file operations in integration tests
- Document editor operations (tested with real DOCX files)
- CLI execution (tested by running actual CLI)

## Fixtures and Factories

**Test Data:**
- Factory functions for creating test objects (e.g., createMockIR())
- Minimal object creation with required fields:

```javascript
const block = { text: 'Hello world' };
const edits = { edits: [{ blockId: ir.blocks[0].seqId, operation: 'comment', comment: 'test' }] };
```

- Real fixture files for end-to-end testing:

```javascript
const sampleDocx = path.join(fixturesDir, 'sample.docx');
const assetPurchaseDocx = path.join(fixturesDir, 'asset-purchase.docx');
```

**Location:**
- Mock objects created inline in test files with helper functions
- Real fixture files in `tests_and_others/tests/fixtures/`
- Output files written to `tests_and_others/tests/output/` for verification

## Coverage

**Requirements:** Not enforced (no coverage configuration detected)

**View Coverage:**
Not implemented. Coverage would require external tools (nyc, c8, etc.) which are not in dependencies.

## Test Types

**Unit Tests:**
- Scope: Individual functions with isolated inputs/outputs
- Examples: `estimateTokens()`, `tokenize()`, `validateNewText()`, `replaceSmartQuotes()`
- Approach: Mock data, focused assertions, fast execution
- From `tests_and_others/tests/fuzzyMatch.test.mjs`:

```javascript
describe('replaceSmartQuotes', () => {
  it('replaces left double quotes', () => {
    assert.strictEqual(replaceSmartQuotes(LEFT_DOUBLE + 'hello'), '"hello');
  });
});
```

**Integration Tests:**
- Scope: Multi-function workflows and CLI commands
- Examples:
  - Full workflow: extract → read → validate → apply
  - Merge multiple edit files
  - CLI command execution
- Approach: Real document fixtures, file operations, realistic data
- From `tests_and_others/tests/cli.test.mjs`:

```javascript
describe('CLI: extract', () => {
  it('extracts IR from document', () => {
    const output = runCLI(`extract -i "${SAMPLE_DOCX}" -o /tmp/test-ir.json`);
    assert.ok(output.includes('Extraction complete'));
  });

  it('creates valid JSON output', async () => {
    runCLI(`extract -i "${SAMPLE_DOCX}" -o /tmp/test-ir.json`);
    const irJson = await readFile('/tmp/test-ir.json', 'utf-8');
    const ir = JSON.parse(irJson);
    assert.ok(ir.blocks);
  });
});
```

**E2E Tests:**
- Not formally separated from integration tests
- CLI tests are functionally E2E (run actual executables, verify file outputs)

## Common Patterns

**Async Testing:**
```javascript
describe('with real documents', () => {
  let sampleIR;

  before(async () => {
    sampleIR = await extractDocumentIR(path.join(fixturesDir, 'sample.docx'));
  });

  it('returns single chunk for small document', () => {
    const chunks = chunkDocument(sampleIR, 100000);
    assert.equal(chunks.length, 1);
  });
});

// Or inline:
it('applies comment edit to document', async () => {
  runCLI(`extract -i "${SAMPLE_DOCX}" -o /tmp/test-ir.json`);
  const irJson = await readFile('/tmp/test-ir.json', 'utf-8');
  const ir = JSON.parse(irJson);
  assert.ok(ir.blocks.length > 0);
});
```

**Error Testing:**
```javascript
it('fails gracefully with missing file', () => {
  const output = runCLI('extract -i /nonexistent.docx -o /tmp/out.json', true);
  assert.ok(output.toLowerCase().includes('error'));
});

it('detects invalid block IDs', async () => {
  const invalidEdits = { edits: [{ blockId: 'b999', operation: 'comment', comment: 'test' }] };
  await writeFile('/tmp/valid-edits.json', JSON.stringify(invalidEdits));

  const output = runCLI(`validate -i "${SAMPLE_DOCX}" -e /tmp/valid-edits.json`, true);
  const result = JSON.parse(output);

  assert.equal(result.valid, false);
  assert.equal(result.issues[0].type, 'missing_block');
});
```

**Edge Case Testing:**
```javascript
it('handles block with undefined text', () => {
  const block = {};
  const tokens = estimateBlockTokens(block);
  assert.equal(tokens, 50, 'Should return just overhead for undefined text');
});

it('handles empty document', () => {
  const emptyIR = {
    blocks: [],
    outline: [],
    metadata: { filename: 'empty.docx' },
    idMapping: {}
  };
  const chunks = chunkDocument(emptyIR, 100000);
  assert.equal(chunks.length, 1);
});

it('preserves document structure in real documents', () => {
  const chunks = chunkDocument(assetPurchaseIR, 5000);
  for (const chunk of chunks) {
    assert.ok(chunk.metadata, 'Chunk should have metadata');
    assert.ok(typeof chunk.metadata.chunkIndex === 'number');
    assert.ok(Array.isArray(chunk.outline), 'Chunk should have outline array');
    assert.ok(Array.isArray(chunk.blocks), 'Chunk should have blocks array');
  }
});
```

**Helper Utilities in Tests:**
```javascript
/**
 * Run a CLI command and return the output.
 * @param {string} args - CLI arguments
 * @param {boolean} expectError - Whether to expect an error exit code
 * @returns {string} - stdout + stderr combined
 */
function runCLI(args, expectError = false) {
  try {
    const output = execSync(`node "${CLI_PATH}" ${args}`, {
      cwd: __dirname,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return output;
  } catch (error) {
    if (expectError) {
      return (error.stdout || '') + (error.stderr || '');
    }
    throw error;
  }
}
```

## Test Count and Coverage

**15 test files** in `tests_and_others/tests/`:
- `chunking.test.mjs` - Token estimation and document chunking
- `editApplicator.test.mjs` - Edit validation and application
- `wordDiff.test.mjs` - Word-level diff computation
- `fuzzyMatch.test.mjs` - Fuzzy text matching with smart quotes
- `markdownEditsParser.test.mjs` - Markdown edit format parsing
- `blockOperations.test.mjs` - Block-level operations on documents
- `clauseParser.test.mjs` - Clause extraction from documents
- `documentReader.test.mjs` - Document reading and chunking
- `editMerge.test.mjs` - Merging multiple edit files
- `idManager.test.mjs` - UUID and sequential ID management
- `irExtractor.test.mjs` - Intermediate representation extraction
- `multiAgent.test.mjs` - Multi-agent edit workflows
- `integration.test.mjs` - Full workflow end-to-end
- `cli.test.mjs` - CLI command testing
- `wordDiffApplication.test.mjs` - Applying word diffs to text

---

*Testing analysis: 2026-02-06*
