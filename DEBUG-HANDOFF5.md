# DEBUG-HANDOFF5: JSON Output Length Causes Content Omission

## Issue Summary

When reviewing contracts, the LLM must output a complete `edits.json` file containing all amendments. For large reviews, this JSON file can exceed **7,000 tokens**. During generation of such long structured output, the LLM experiences **content omission** - edits identified during analysis are silently dropped from the final output.

This is distinct from the "methodology gap" diagnosis in DEBUG-HANDOFF4. The evidence shows the LLM **knew** about missed items but failed to include them when generating the JSON.

---

## Evidence

### Quantitative Analysis

| File | Edit Count | Tokens | Purpose |
|------|------------|--------|---------|
| `singapore-edits.json` | 66 | ~7,300 | Main output |
| `fix-missed-uk-terms.json` | 8 | ~650 | Missing items |

### The Smoking Gun: TUPE/TULRCA Awareness

The main edits file contains **10 comments** mentioning TUPE or TULRCA:

```
b450:  "Singapore does not have TUPE - adapt employee transfer provisions"
b454:  "Replace TUPE reference with Singapore Employment Act"
b456:  "Replace TUPE and TULRCA references with Singapore Employment Act"
b465:  "Remove TUPE reference as Singapore does not have equivalent"
b466:  "Remove TUPE reference"
b467:  "Replace TUPE reference with Singapore employment legislation"
b468:  "Remove TUPE reference"
b745:  "Remove TUPE reference as Singapore does not have equivalent"
b1304: "Remove TUPE and EU Directive references"
```

**The LLM clearly knew these UK terms existed.** It correctly adapted 9+ operational clauses that *referenced* TUPE/TULRCA.

**But:** The definition blocks (b257 TULRCA, b258 TUPE) have **no delete edits** in the main file.

### Pattern of Omission

Items in the fix file share characteristics:

| Block | Type | Complexity |
|-------|------|------------|
| b257 | DELETE | Simple (no newText) |
| b258 | DELETE | Simple (no newText) |
| b236 | REPLACE | Short newText |
| b260 | REPLACE | Short newText |
| b442-b444 | REPLACE | Short newText |
| b731 | REPLACE | Short newText |

These are all **low-complexity edits** - either deletions or simple term replacements. They got dropped while the LLM focused on outputting the more complex replacement clauses.

---

## Root Cause Analysis

### Why DEBUG-HANDOFF4's Diagnosis Was Incomplete

DEBUG-HANDOFF4 concluded:
> "Chunk size of 10K tokens is adequate. The issue is about task coverage, not attention within chunks."

This conflates two different operations:

| Operation | Token Limit | Actual Issue |
|-----------|-------------|--------------|
| **Reading** document chunks | 10K tokens | Working fine |
| **Outputting** edits JSON | ~7,300 tokens | **Content omission** |

The 10K chunk limit helps with **input processing**. It does nothing for **output generation**.

### LLM Output Generation Constraints

When generating long structured output, the LLM must simultaneously:

1. Maintain JSON syntax (braces, commas, quotes, escaping)
2. Track which edits have been written
3. Remember which edits remain to write
4. Generate accurate `newText` content for each edit

As output length increases, the LLM's ability to track "what remains" degrades. Items perceived as lower priority (simple deletions) get dropped.

### The 66-Edit Threshold

With 66 edits averaging ~110 tokens each, the LLM must:
- Generate ~7,300 tokens of structured JSON
- Maintain perfect syntax throughout
- Not "forget" any of the 66+ items

This exceeds reliable output generation capacity for structured data.

---

## Proposed Solutions

### Solution 1: Markdown Tables Instead of JSON (Recommended)

**Replace JSON edits format with Markdown tables.**

#### Current Format (JSON)
```json
{
  "edits": [
    {
      "blockId": "b257",
      "operation": "delete",
      "comment": "DELETE TULRCA definition"
    },
    {
      "blockId": "b165",
      "operation": "replace",
      "newText": "Business Day: a day other than a Saturday...",
      "diff": true,
      "comment": "Change England to Singapore"
    }
  ]
}
```

#### Proposed Format (Markdown)
```markdown
## Edits

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b257 | delete | - | DELETE TULRCA definition |
| b165 | replace | true | Change England to Singapore |

### b165 newText
Business Day: a day other than a Saturday, Sunday or public holiday in Singapore when banks in Singapore are open for business.

### b180 newText
Companies Act: the Companies Act 1967 of Singapore.
```

#### Why Markdown is Better

| Aspect | JSON | Markdown |
|--------|------|----------|
| Syntax errors | Fatal (invalid JSON) | Recoverable (table row still readable) |
| Missing comma | Breaks entire file | No commas needed |
| Quote escaping | Complex (`\"`) | Natural (no escaping in fenced blocks) |
| Partial output | Unusable | Still parseable |
| Human readable | Requires formatting | Native |
| LLM generation | High cognitive load | Lower cognitive load |

#### Implementation

Add a new CLI command to parse markdown edits:

```bash
# Convert markdown edits to JSON
node superdoc-redline.mjs parse-edits --input edits.md --output edits.json

# Or apply directly from markdown
node superdoc-redline.mjs apply --input contract.docx --edits edits.md --output amended.docx
```

The parser would:
1. Extract the table rows for block ID, operation, diff flag, comment
2. Extract `### bXXX newText` sections for replacement text
3. Generate the internal JSON structure
4. Validate and apply

---

### Solution 2: Incremental Edit Generation

**Write edits to file incrementally during Pass 2, not all at once.**

#### Current Workflow
```
Pass 2: Review all chunks → Accumulate edits in memory → Output complete JSON
```

#### Proposed Workflow
```
Pass 2: Review chunk 0 → Write edits 1-15 to file
        Review chunk 1 → Append edits 16-30 to file
        Review chunk 2 → Append edits 31-45 to file
        ...
        Finalize → Validate complete file
```

#### Implementation in Skill Document

```markdown
## Incremental Edit File Construction

After reviewing each chunk in Pass 2:

1. **Immediately write new edits** to a working file
2. Use a simple append format (JSONL or markdown)
3. Never accumulate more than 15-20 edits before writing
4. After all chunks: consolidate into final format

### JSONL Append Format

Each chunk appends lines like:
```jsonl
{"blockId":"b165","operation":"replace","newText":"...","diff":true}
{"blockId":"b180","operation":"replace","newText":"...","diff":true}
```

Final step converts JSONL to proper JSON array.
```

---

### Solution 3: Chunked Output with Merge

**Sub-agents output smaller edit files that are merged.**

This is already supported by the agentic skill but not enforced. Make it mandatory:

```markdown
## Mandatory Output Chunking

Each sub-agent MUST output ≤20 edits per file:

- Agent A (b001-b200): edits-a1.json (edits 1-20), edits-a2.json (edits 21-40)
- Agent B (b201-b400): edits-b1.json (edits 1-15)
- etc.

Orchestrator merges all files:
```bash
node superdoc-redline.mjs merge edits-*.json -o merged-edits.json
```
```

---

### Solution 4: Structured Checklist Verification

**Add explicit checklist output before JSON generation.**

```markdown
## Pre-JSON Verification Checklist

Before generating the edits file, output this checklist:

### Deletions Required
- [ ] b257 TULRCA definition - DELETE
- [ ] b258 TUPE definition - DELETE

### Compound Terms
- [ ] b236 "VAT Records" → "GST Records"
- [ ] b260 VAT Records definition → GST Records

### Term Replacements
- [ ] b165 Business Day (England → Singapore)
- [ ] b180 Companies Act
...

**Verify all boxes are checked, THEN generate JSON.**
```

This creates an intermediate artifact that can be validated before the high-stakes JSON generation.

---

## Recommended Implementation Priority

| Priority | Solution | Effort | Impact |
|----------|----------|--------|--------|
| 1 | **Markdown format** | Medium | High - eliminates syntax pressure |
| 2 | Structured checklist | Low | Medium - catches omissions |
| 3 | Incremental generation | Low | Medium - reduces batch size |
| 4 | Chunked output + merge | Already exists | Medium - enforce usage |

---

## Implementation Specification: Markdown Edit Format

### Full Format Specification

```markdown
# Edits: [Document Name]
# Author: [Name]
# Date: [Date]

## Metadata
- **Version**: 0.2.0
- **Author Name**: AI Legal Counsel
- **Author Email**: ai@counsel.com

## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b257 | delete | - | DELETE TULRCA definition |
| b258 | delete | - | DELETE TUPE definition |
| b165 | replace | true | Change Business Day to Singapore |
| b180 | replace | false | Replace Companies Act definition |
| b500 | comment | - | Review needed: verify CPF rates |
| b450 | insert | - | Insert after b449: Singapore employment provisions |

## Replacement Text

### b165 newText
Business Day: a day other than a Saturday, Sunday or public holiday in Singapore when banks in Singapore are open for business.

### b180 newText
Companies Act: the Companies Act 1967 of Singapore.

### b450 insertText
The Buyer shall offer employment to each Transferring Employee on terms substantially similar to their existing terms of employment. Each Transferring Employee who accepts such offer shall resign from the Seller's employment with effect from the Effective Time.
```

### Table Column Definitions

| Column | Required | Values | Notes |
|--------|----------|--------|-------|
| Block | Yes | `b###` | Block ID from document IR |
| Op | Yes | `delete`, `replace`, `comment`, `insert` | Operation type |
| Diff | For replace | `true`, `false`, `-` | Word-level diff mode |
| Comment | No | Free text | Rationale for edit |

### Operation Types

| Op | Requires newText | Requires insertText | Description |
|----|------------------|---------------------|-------------|
| `delete` | No | No | Remove block entirely |
| `replace` | Yes | No | Replace block content |
| `comment` | No | No | Add review comment only |
| `insert` | No | Yes | Insert new block after specified block |

### newText / insertText Sections

- Header format: `### b### newText` or `### b### insertText`
- Content: Everything until the next `###` header or end of file
- Whitespace: Leading/trailing whitespace trimmed
- Multi-paragraph: Preserved as-is

---

## Parser Implementation

### File: `src/markdownEditsParser.mjs`

```javascript
/**
 * Parse markdown edit format into JSON edit structure
 * @param {string} markdown - Raw markdown content
 * @returns {object} - JSON edit structure compatible with superdoc-redlines
 */
export function parseMarkdownEdits(markdown) {
  const result = {
    version: '0.2.0',
    author: { name: 'Unknown', email: '' },
    edits: []
  };

  const lines = markdown.split('\n');

  // 1. Parse metadata section
  const metadataMatch = markdown.match(/## Metadata\n([\s\S]*?)(?=\n## )/);
  if (metadataMatch) {
    const authorNameMatch = metadataMatch[1].match(/Author Name\*\*:\s*(.+)/);
    const authorEmailMatch = metadataMatch[1].match(/Author Email\*\*:\s*(.+)/);
    if (authorNameMatch) result.author.name = authorNameMatch[1].trim();
    if (authorEmailMatch) result.author.email = authorEmailMatch[1].trim();
  }

  // 2. Parse edits table
  const tableMatch = markdown.match(/\| Block \| Op \| Diff \| Comment \|\n\|[-|]+\|\n([\s\S]*?)(?=\n## |\n### |$)/);
  if (tableMatch) {
    const tableRows = tableMatch[1].trim().split('\n');
    for (const row of tableRows) {
      const cells = row.split('|').map(c => c.trim()).filter(c => c);
      if (cells.length >= 2) {
        const edit = {
          blockId: cells[0],
          operation: cells[1]
        };

        // Parse diff flag
        if (cells[2] && cells[2] !== '-') {
          edit.diff = cells[2] === 'true';
        }

        // Parse comment
        if (cells[3]) {
          edit.comment = cells[3];
        }

        result.edits.push(edit);
      }
    }
  }

  // 3. Parse newText and insertText sections
  const textSections = markdown.matchAll(/### (b\d+) (newText|insertText)\n([\s\S]*?)(?=\n### |\n## |$)/g);
  for (const match of textSections) {
    const blockId = match[1];
    const textType = match[2];
    const content = match[3].trim();

    // Find corresponding edit and attach text
    const edit = result.edits.find(e => e.blockId === blockId);
    if (edit) {
      if (textType === 'newText') {
        edit.newText = content;
      } else if (textType === 'insertText') {
        edit.text = content;
        // For insert, blockId becomes afterBlockId
        edit.afterBlockId = edit.blockId;
        delete edit.blockId;
      }
    }
  }

  // 4. Validate required fields
  for (const edit of result.edits) {
    if (edit.operation === 'replace' && !edit.newText) {
      console.warn(`Warning: Block ${edit.blockId} is 'replace' but missing newText section`);
    }
    if (edit.operation === 'insert' && !edit.text) {
      console.warn(`Warning: Insert after ${edit.afterBlockId} is missing insertText section`);
    }
  }

  return result;
}

/**
 * Convert JSON edits back to markdown format
 * @param {object} json - JSON edit structure
 * @returns {string} - Markdown format
 */
export function editsToMarkdown(json) {
  let md = `# Edits\n\n`;
  md += `## Metadata\n`;
  md += `- **Version**: ${json.version || '0.2.0'}\n`;
  md += `- **Author Name**: ${json.author?.name || 'Unknown'}\n`;
  md += `- **Author Email**: ${json.author?.email || ''}\n\n`;

  md += `## Edits Table\n\n`;
  md += `| Block | Op | Diff | Comment |\n`;
  md += `|-------|-----|------|--------|\n`;

  for (const edit of json.edits) {
    const blockId = edit.blockId || edit.afterBlockId;
    const diff = edit.diff !== undefined ? String(edit.diff) : '-';
    const comment = edit.comment || '';
    md += `| ${blockId} | ${edit.operation} | ${diff} | ${comment} |\n`;
  }

  md += `\n## Replacement Text\n\n`;

  for (const edit of json.edits) {
    if (edit.newText) {
      md += `### ${edit.blockId} newText\n${edit.newText}\n\n`;
    }
    if (edit.text && edit.operation === 'insert') {
      md += `### ${edit.afterBlockId} insertText\n${edit.text}\n\n`;
    }
  }

  return md;
}
```

### CLI Integration: `superdoc-redline.mjs`

```javascript
import { parseMarkdownEdits, editsToMarkdown } from './src/markdownEditsParser.mjs';

// Add parse-edits command
program
  .command('parse-edits')
  .description('Convert markdown edits to JSON format')
  .requiredOption('-i, --input <file>', 'Input markdown file (.md)')
  .requiredOption('-o, --output <file>', 'Output JSON file (.json)')
  .option('--validate <docx>', 'Validate block IDs against document')
  .action(async (options) => {
    const markdown = await fs.readFile(options.input, 'utf-8');
    const edits = parseMarkdownEdits(markdown);

    // Optional validation against source document
    if (options.validate) {
      const validBlockIds = await getBlockIdsFromDocument(options.validate);
      for (const edit of edits.edits) {
        const blockId = edit.blockId || edit.afterBlockId;
        if (!validBlockIds.has(blockId)) {
          console.error(`Error: Block ${blockId} not found in document`);
          process.exit(1);
        }
      }
    }

    await fs.writeFile(options.output, JSON.stringify(edits, null, 2));
    console.log(`Converted ${edits.edits.length} edits to ${options.output}`);
  });

// Add to-markdown command
program
  .command('to-markdown')
  .description('Convert JSON edits to markdown format')
  .requiredOption('-i, --input <file>', 'Input JSON file (.json)')
  .requiredOption('-o, --output <file>', 'Output markdown file (.md)')
  .action(async (options) => {
    const json = JSON.parse(await fs.readFile(options.input, 'utf-8'));
    const markdown = editsToMarkdown(json);
    await fs.writeFile(options.output, markdown);
    console.log(`Converted ${json.edits.length} edits to ${options.output}`);
  });

// Modify apply command to auto-detect format
program
  .command('apply')
  // ... existing options ...
  .action(async (options) => {
    let edits;

    // Auto-detect format by extension
    if (options.edits.endsWith('.md')) {
      const markdown = await fs.readFile(options.edits, 'utf-8');
      edits = parseMarkdownEdits(markdown);
    } else {
      edits = JSON.parse(await fs.readFile(options.edits, 'utf-8'));
    }

    // ... rest of apply logic ...
  });
```

---

## Error Handling

### Recoverable Errors (Markdown Advantage)

| Error Type | JSON Behavior | Markdown Behavior |
|------------|---------------|-------------------|
| Missing comma | Parse fails entirely | N/A - no commas |
| Unclosed quote | Parse fails entirely | Row still readable |
| Missing newText section | N/A | Warning, edit skipped |
| Malformed table row | N/A | Warning, row skipped |
| Truncated output | Unusable | Partial edits recovered |

### Parser Error Handling

```javascript
// Example: Graceful handling of malformed rows
function parseTableRow(row) {
  try {
    const cells = row.split('|').map(c => c.trim()).filter(c => c);
    if (cells.length < 2) {
      console.warn(`Skipping malformed row: ${row}`);
      return null;
    }
    return {
      blockId: cells[0],
      operation: cells[1],
      diff: cells[2] === 'true' ? true : cells[2] === 'false' ? false : undefined,
      comment: cells[3] || ''
    };
  } catch (e) {
    console.warn(`Error parsing row: ${row} - ${e.message}`);
    return null;
  }
}
```

---

## Example Files

### Example: `singapore-edits.md`

```markdown
# Edits: UK Asset Purchase Agreement → Singapore

## Metadata
- **Version**: 0.2.0
- **Author Name**: AI Legal Counsel
- **Author Email**: ai@counsel.sg

## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b257 | delete | - | DELETE TULRCA definition - no SG equivalent |
| b258 | delete | - | DELETE TUPE definition - no SG equivalent |
| b165 | replace | true | Change Business Day: England → Singapore |
| b180 | replace | true | Companies Act 2006 → Companies Act 1967 |
| b236 | replace | true | VAT Records → GST Records in Records definition |
| b260 | replace | true | VAT Records definition → GST Records |
| b427 | replace | true | VAT → GST |
| b450 | replace | false | Complete rewrite: TUPE → offer-and-accept model |

## Replacement Text

### b165 newText
Business Day: a day other than a Saturday, Sunday or public holiday in Singapore when banks in Singapore are open for business.

### b180 newText
Companies Act: the Companies Act 1967 of Singapore.

### b236 newText
Records: all records and other storage media, regardless of form or characteristics, containing or relating to Business Information or on or in which Business Information is recorded or stored, whether machine-readable or not (including computer disks, hard drives, servers, universal serial bus (USB) sticks, the cloud, books, photographs and other documentary materials) [including OR excluding] the GST Records.

### b260 newText
GST Records: all records of the Business, which under the Goods and Services Tax Act 1993 of Singapore are required to be preserved.

### b427 newText
Goods and Services Tax

### b450 newText
The parties agree that the sale and purchase pursuant to this agreement shall not automatically transfer the contracts of employment of the Employees to the Buyer (as Singapore does not have legislation equivalent to the UK Transfer of Undertakings (Protection of Employment) Regulations). The Buyer shall, subject to the terms of this agreement, offer employment to the Employees on terms no less favourable than their current terms of employment, and the Seller shall procure that each Employee who accepts such offer resigns from the Seller's employment with effect from the Effective Time.
```

### Conversion Commands

```bash
# Convert markdown to JSON
node superdoc-redline.mjs parse-edits \
  -i singapore-edits.md \
  -o singapore-edits.json \
  --validate "Precedent - PLC - Asset purchase agreement.docx"

# Apply directly from markdown (auto-detects format)
node superdoc-redline.mjs apply \
  --input "Precedent - PLC - Asset purchase agreement.docx" \
  --output "singapore-amended.docx" \
  --edits singapore-edits.md

# Convert existing JSON to markdown for review
node superdoc-redline.mjs to-markdown \
  -i singapore-edits.json \
  -o singapore-edits-review.md
```

---

## Updated Skill Document Sections

### For CONTRACT-REVIEW-SKILL.md

Add new section:

```markdown
## Output Format: Markdown Preferred

### Why Markdown Over JSON

When generating edit lists, use **Markdown tables** instead of JSON:

1. **No syntax errors** - Missing commas don't break the file
2. **Easier generation** - Less cognitive load on structured output
3. **Partial recovery** - Incomplete output is still parseable
4. **Human readable** - Easy to review before applying

### Markdown Edit Format

\`\`\`markdown
## Edits for [Contract Name]

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b257 | delete | - | DELETE TULRCA definition |
| b258 | delete | - | DELETE TUPE definition |
| b165 | replace | true | Change Business Day to Singapore |

### b165 newText
Business Day: a day other than a Saturday, Sunday or public holiday in Singapore when banks in Singapore are open for business.
\`\`\`

### Converting to JSON

\`\`\`bash
node superdoc-redline.mjs parse-edits --input edits.md --output edits.json
\`\`\`
```

### For CONTRACT-REVIEW-AGENTIC-SKILL.md

Update sub-agent instructions:

```markdown
## Sub-Agent Output Format

Output your edits in **Markdown format**, not JSON:

1. Create a table with columns: Block, Op, Diff, Comment
2. For each replacement, add a `### bXXX newText` section
3. Maximum 20 edits per output file
4. Orchestrator will convert and merge

This prevents content omission during long output generation.
```

---

## Validation Test

After implementing markdown support, verify with:

```bash
# 1. Review contract, output markdown
# (Agent generates edits.md with 66 edits)

# 2. Parse to JSON
node superdoc-redline.mjs parse-edits -i edits.md -o edits.json

# 3. Validate
node superdoc-redline.mjs validate -i contract.docx -e edits.json

# 4. Check for previously-missed items
grep -E "b257|b258|b236|b260" edits.json
# Should find all 4 blocks
```

---

## Summary

| Issue | Root Cause | Fix |
|-------|------------|-----|
| TULRCA/TUPE definitions not deleted | Content omission during 7,300-token JSON output | Use markdown format |
| VAT Records not changed | Same - low-complexity edits dropped | Same |
| "Methodology gap" diagnosis | Misidentified - agent knew about items | Corrected diagnosis |

**The problem is not reading comprehension. The problem is output generation at scale.**

Markdown tables remove the syntax pressure that causes omissions. The LLM can focus on content rather than JSON structure.

---

## Testing Specification

### Unit Tests: `tests/markdownEditsParser.test.mjs`

```javascript
import { describe, it, expect } from 'vitest';
import { parseMarkdownEdits, editsToMarkdown } from '../src/markdownEditsParser.mjs';

describe('parseMarkdownEdits', () => {

  describe('table parsing', () => {

    it('should parse delete operations', () => {
      const md = `
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b257 | delete | - | DELETE TULRCA |
`;
      const result = parseMarkdownEdits(md);
      expect(result.edits).toHaveLength(1);
      expect(result.edits[0]).toEqual({
        blockId: 'b257',
        operation: 'delete',
        comment: 'DELETE TULRCA'
      });
    });

    it('should parse replace operations with diff flag', () => {
      const md = `
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b165 | replace | true | Change jurisdiction |

### b165 newText
Business Day: a day in Singapore.
`;
      const result = parseMarkdownEdits(md);
      expect(result.edits[0]).toEqual({
        blockId: 'b165',
        operation: 'replace',
        diff: true,
        comment: 'Change jurisdiction',
        newText: 'Business Day: a day in Singapore.'
      });
    });

    it('should parse replace operations with diff: false', () => {
      const md = `
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b450 | replace | false | Complete rewrite |

### b450 newText
Entirely new clause text here.
`;
      const result = parseMarkdownEdits(md);
      expect(result.edits[0].diff).toBe(false);
    });

    it('should parse comment operations', () => {
      const md = `
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b500 | comment | - | REVIEW: Check CPF rates |
`;
      const result = parseMarkdownEdits(md);
      expect(result.edits[0]).toEqual({
        blockId: 'b500',
        operation: 'comment',
        comment: 'REVIEW: Check CPF rates'
      });
    });

    it('should parse insert operations', () => {
      const md = `
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b449 | insert | - | Insert Singapore employment clause |

### b449 insertText
The Buyer shall offer employment to each Employee.
`;
      const result = parseMarkdownEdits(md);
      expect(result.edits[0]).toEqual({
        afterBlockId: 'b449',
        operation: 'insert',
        comment: 'Insert Singapore employment clause',
        text: 'The Buyer shall offer employment to each Employee.'
      });
    });

  });

  describe('metadata parsing', () => {

    it('should parse author metadata', () => {
      const md = `
## Metadata
- **Version**: 0.2.0
- **Author Name**: AI Legal Counsel
- **Author Email**: ai@counsel.sg

## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b257 | delete | - | Test |
`;
      const result = parseMarkdownEdits(md);
      expect(result.version).toBe('0.2.0');
      expect(result.author.name).toBe('AI Legal Counsel');
      expect(result.author.email).toBe('ai@counsel.sg');
    });

    it('should use defaults when metadata missing', () => {
      const md = `
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b257 | delete | - | Test |
`;
      const result = parseMarkdownEdits(md);
      expect(result.version).toBe('0.2.0');
      expect(result.author.name).toBe('Unknown');
    });

  });

  describe('newText section parsing', () => {

    it('should handle multi-line newText', () => {
      const md = `
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b450 | replace | false | Multi-line |

### b450 newText
First paragraph of the clause.

Second paragraph with more content.

Third paragraph concluding the clause.
`;
      const result = parseMarkdownEdits(md);
      expect(result.edits[0].newText).toContain('First paragraph');
      expect(result.edits[0].newText).toContain('Second paragraph');
      expect(result.edits[0].newText).toContain('Third paragraph');
    });

    it('should handle newText with special characters', () => {
      const md = `
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b165 | replace | true | Special chars |

### b165 newText
"Quoted text" with [brackets] and (parentheses) and 'apostrophes'.
`;
      const result = parseMarkdownEdits(md);
      expect(result.edits[0].newText).toContain('"Quoted text"');
      expect(result.edits[0].newText).toContain('[brackets]');
    });

    it('should handle multiple newText sections', () => {
      const md = `
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b165 | replace | true | First |
| b180 | replace | true | Second |

### b165 newText
Content for b165.

### b180 newText
Content for b180.
`;
      const result = parseMarkdownEdits(md);
      expect(result.edits[0].newText).toBe('Content for b165.');
      expect(result.edits[1].newText).toBe('Content for b180.');
    });

  });

  describe('error handling', () => {

    it('should skip malformed table rows', () => {
      const md = `
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b257 | delete | - | Valid row |
| malformed row without pipes
| b258 | delete | - | Another valid row |
`;
      const result = parseMarkdownEdits(md);
      expect(result.edits).toHaveLength(2);
      expect(result.edits[0].blockId).toBe('b257');
      expect(result.edits[1].blockId).toBe('b258');
    });

    it('should warn on missing newText for replace', () => {
      const consoleSpy = vi.spyOn(console, 'warn');
      const md = `
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b165 | replace | true | Missing newText |
`;
      parseMarkdownEdits(md);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('b165')
      );
    });

    it('should handle empty input gracefully', () => {
      const result = parseMarkdownEdits('');
      expect(result.edits).toEqual([]);
    });

    it('should handle truncated output (partial recovery)', () => {
      const md = `
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b257 | delete | - | First |
| b258 | delete | - | Second |
| b165 | replace | true | Third |

### b165 newText
This text is trunc`;  // Simulates truncated LLM output

      const result = parseMarkdownEdits(md);
      // Should recover the delete operations even if newText is truncated
      expect(result.edits).toHaveLength(3);
      expect(result.edits[0].operation).toBe('delete');
      expect(result.edits[1].operation).toBe('delete');
      // Replace edit exists but with truncated newText
      expect(result.edits[2].newText).toBe('This text is trunc');
    });

  });

});

describe('editsToMarkdown', () => {

  it('should round-trip JSON → Markdown → JSON', () => {
    const originalJson = {
      version: '0.2.0',
      author: { name: 'Test', email: 'test@test.com' },
      edits: [
        { blockId: 'b257', operation: 'delete', comment: 'Delete this' },
        { blockId: 'b165', operation: 'replace', newText: 'New text', diff: true, comment: 'Replace' }
      ]
    };

    const markdown = editsToMarkdown(originalJson);
    const recoveredJson = parseMarkdownEdits(markdown);

    expect(recoveredJson.edits).toHaveLength(2);
    expect(recoveredJson.edits[0].blockId).toBe('b257');
    expect(recoveredJson.edits[1].newText).toBe('New text');
  });

});
```

### Integration Tests: `tests/markdownEditsIntegration.test.mjs`

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

const TEST_DIR = path.join(process.cwd(), 'tests', 'fixtures');
const CLI = 'node superdoc-redline.mjs';

describe('Markdown Edits Integration', () => {

  const testDocx = path.join(TEST_DIR, 'test-contract.docx');
  const testMd = path.join(TEST_DIR, 'test-edits.md');
  const testJson = path.join(TEST_DIR, 'test-edits.json');

  beforeAll(async () => {
    // Create test markdown file
    await fs.writeFile(testMd, `
## Metadata
- **Version**: 0.2.0
- **Author Name**: Test Agent
- **Author Email**: test@test.com

## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b165 | replace | true | Test replacement |

### b165 newText
Test replacement text for block b165.
`);
  });

  describe('parse-edits command', () => {

    it('should convert markdown to valid JSON', async () => {
      execSync(`${CLI} parse-edits -i ${testMd} -o ${testJson}`);

      const json = JSON.parse(await fs.readFile(testJson, 'utf-8'));
      expect(json.version).toBe('0.2.0');
      expect(json.edits).toHaveLength(1);
      expect(json.edits[0].blockId).toBe('b165');
      expect(json.edits[0].newText).toContain('Test replacement');
    });

    it('should validate against document when --validate flag used', async () => {
      // This should fail if b999 doesn't exist
      const invalidMd = path.join(TEST_DIR, 'invalid-edits.md');
      await fs.writeFile(invalidMd, `
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b999999 | delete | - | Invalid block |
`);

      expect(() => {
        execSync(`${CLI} parse-edits -i ${invalidMd} -o /dev/null --validate ${testDocx}`);
      }).toThrow();
    });

  });

  describe('apply command with markdown input', () => {

    it('should auto-detect and apply markdown edits', async () => {
      const outputDocx = path.join(TEST_DIR, 'output.docx');

      execSync(`${CLI} apply -i ${testDocx} -o ${outputDocx} -e ${testMd}`);

      // Verify output exists and has content
      const stats = await fs.stat(outputDocx);
      expect(stats.size).toBeGreaterThan(0);
    });

  });

  describe('to-markdown command', () => {

    it('should convert JSON edits to markdown', async () => {
      const inputJson = path.join(TEST_DIR, 'input.json');
      const outputMd = path.join(TEST_DIR, 'output.md');

      await fs.writeFile(inputJson, JSON.stringify({
        version: '0.2.0',
        author: { name: 'Test', email: 'test@test.com' },
        edits: [
          { blockId: 'b257', operation: 'delete', comment: 'Test delete' }
        ]
      }));

      execSync(`${CLI} to-markdown -i ${inputJson} -o ${outputMd}`);

      const markdown = await fs.readFile(outputMd, 'utf-8');
      expect(markdown).toContain('| b257 | delete |');
    });

  });

});
```

### Regression Test: Previously Missed Items

```javascript
describe('Regression: Content Omission Fix', () => {

  it('should not omit simple delete operations in large edit sets', async () => {
    // Simulate the original problem: 66 edits with some simple deletes
    const edits = [];

    // Add complex replacements (what the LLM focused on)
    for (let i = 1; i <= 60; i++) {
      edits.push({
        blockId: `b${400 + i}`,
        operation: 'replace',
        diff: true,
        comment: `Complex replacement ${i}`,
        newText: `Long replacement text for block ${400 + i} with lots of content...`
      });
    }

    // Add simple deletes (what got omitted before)
    edits.push({ blockId: 'b257', operation: 'delete', comment: 'DELETE TULRCA' });
    edits.push({ blockId: 'b258', operation: 'delete', comment: 'DELETE TUPE' });

    // Add simple replacements (also omitted before)
    edits.push({
      blockId: 'b236',
      operation: 'replace',
      diff: true,
      comment: 'VAT Records → GST Records',
      newText: 'GST Records reference'
    });
    edits.push({
      blockId: 'b260',
      operation: 'replace',
      diff: true,
      comment: 'VAT Records def → GST Records',
      newText: 'GST Records: definition text'
    });

    const json = { version: '0.2.0', author: { name: 'Test' }, edits };

    // Convert to markdown and back
    const markdown = editsToMarkdown(json);
    const recovered = parseMarkdownEdits(markdown);

    // Verify ALL edits are present, especially the simple ones
    expect(recovered.edits).toHaveLength(64);

    // Specifically verify the previously-omitted items
    const b257 = recovered.edits.find(e => e.blockId === 'b257');
    const b258 = recovered.edits.find(e => e.blockId === 'b258');
    const b236 = recovered.edits.find(e => e.blockId === 'b236');
    const b260 = recovered.edits.find(e => e.blockId === 'b260');

    expect(b257).toBeDefined();
    expect(b257.operation).toBe('delete');
    expect(b258).toBeDefined();
    expect(b258.operation).toBe('delete');
    expect(b236).toBeDefined();
    expect(b236.newText).toContain('GST Records');
    expect(b260).toBeDefined();
    expect(b260.newText).toContain('GST Records');
  });

});
```

### End-to-End Test: Full Contract Review

```bash
#!/bin/bash
# tests/e2e/full-review-test.sh

set -e

echo "=== E2E Test: Full Contract Review with Markdown Format ==="

TEST_DIR="tests/fixtures"
INPUT_DOC="$TEST_DIR/uk-asset-purchase.docx"
EDITS_MD="$TEST_DIR/singapore-edits.md"
OUTPUT_DOC="$TEST_DIR/singapore-output.docx"

# 1. Verify input exists
if [ ! -f "$INPUT_DOC" ]; then
  echo "ERROR: Test document not found: $INPUT_DOC"
  exit 1
fi

# 2. Apply edits from markdown
echo "Applying edits from markdown..."
node superdoc-redline.mjs apply \
  --input "$INPUT_DOC" \
  --output "$OUTPUT_DOC" \
  --edits "$EDITS_MD" \
  --author-name "E2E Test"

# 3. Verify output created
if [ ! -f "$OUTPUT_DOC" ]; then
  echo "ERROR: Output document not created"
  exit 1
fi

# 4. Read output and check for previously-missed items
echo "Verifying previously-missed items are now present..."

# Extract text and search for corrections
node superdoc-redline.mjs read --input "$OUTPUT_DOC" > "$TEST_DIR/output-text.txt"

# These should NOT appear (they should be deleted)
if grep -q "TULRCA" "$TEST_DIR/output-text.txt"; then
  echo "FAIL: TULRCA definition still present (should be deleted)"
  exit 1
fi

if grep -q "TUPE:" "$TEST_DIR/output-text.txt"; then
  echo "FAIL: TUPE definition still present (should be deleted)"
  exit 1
fi

# These should appear (replacements should be made)
if ! grep -q "GST Records" "$TEST_DIR/output-text.txt"; then
  echo "FAIL: 'GST Records' not found (VAT Records should be changed)"
  exit 1
fi

echo "=== E2E Test PASSED ==="
echo "All previously-omitted items are now correctly handled."
```

### Test Data: Minimal Reproduction Case

Create `tests/fixtures/omission-repro.md`:

```markdown
# Minimal Reproduction: Content Omission

This test verifies that simple edits are not omitted when mixed with complex edits.

## Metadata
- **Version**: 0.2.0
- **Author Name**: Test

## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b100 | replace | false | Complex edit 1 |
| b101 | replace | false | Complex edit 2 |
| b102 | replace | false | Complex edit 3 |
| b257 | delete | - | CRITICAL: Simple delete - must not be omitted |
| b258 | delete | - | CRITICAL: Simple delete - must not be omitted |
| b103 | replace | false | Complex edit 4 |
| b236 | replace | true | CRITICAL: Simple replace - must not be omitted |

### b100 newText
This is a long complex replacement text for block b100. It contains many words and spans multiple sentences. The purpose is to simulate the kind of complex edits that the LLM focuses on while potentially dropping simpler edits.

### b101 newText
Another long complex replacement for b101. More content here to increase the output size and cognitive load during generation.

### b102 newText
Yet another complex replacement for b102. Continuing to add content to simulate real-world edit complexity.

### b103 newText
Final complex replacement for b103. This represents the pattern where complex edits are generated correctly.

### b236 newText
GST Records
```

Run with:
```bash
node superdoc-redline.mjs parse-edits \
  -i tests/fixtures/omission-repro.md \
  -o tests/fixtures/omission-repro.json

# Verify all 7 edits present
cat tests/fixtures/omission-repro.json | jq '.edits | length'
# Expected: 7

# Verify critical deletes present
cat tests/fixtures/omission-repro.json | jq '.edits[] | select(.blockId == "b257")'
cat tests/fixtures/omission-repro.json | jq '.edits[] | select(.blockId == "b258")'
```

---

*Created: 4 February 2026*
*Issue Type: LLM output generation limit - content omission*
*Supersedes: DEBUG-HANDOFF4.md diagnosis*

---

## Implementation Afternote

**Date:** 4 February 2026

### Solutions Implemented

| Solution | Status | Notes |
|----------|--------|-------|
| **Solution 1: Markdown Format** | ✅ Implemented | Full implementation |
| Solution 2: Incremental Generation | ❌ Not implemented | See rationale below |
| Solution 3: Chunked Output + Merge | ✅ Already existed | No changes needed |
| **Solution 4: Structured Checklist** | ✅ Implemented | Added to skill documents |

### Implementation Details

**Solution 1 (Markdown Format):**
- Created `src/markdownEditsParser.mjs` with `parseMarkdownEdits()` and `editsToMarkdown()` functions
- Added CLI commands: `parse-edits` and `to-markdown`
- Updated `apply` command to auto-detect markdown (.md) vs JSON (.json) format
- Added 30 unit tests in `tests/markdownEditsParser.test.mjs`
- Updated documentation: README.md, SKILL.md, CONTRACT-REVIEW-SKILL.md, CONTRACT-REVIEW-AGENTIC-SKILL.md

**Solution 4 (Structured Checklist):**
- Added "Pre-Generation Verification Checklist" section to CONTRACT-REVIEW-SKILL.md
- Updated sub-agent prompt template in CONTRACT-REVIEW-AGENTIC-SKILL.md to require checklist before output
- Checklist covers: deletions, compound terms, base terms, jurisdiction changes, employment provisions

### Rationale for Not Implementing Solutions 2 and 3

**Solution 2 (Incremental Edit Generation):**
- The markdown format (Solution 1) already addresses the root cause by reducing cognitive load during generation
- Markdown's partial output recovery means truncated output is still usable
- Test results showed 73 edits generated successfully in a single markdown output with zero omissions
- Adding incremental file writes would add complexity (JSONL parsing, append logic, consolidation) without clear benefit given Solution 1's success
- **Recommendation:** Revisit only if content omission occurs with markdown format for very large edit sets (100+ edits)

**Solution 3 (Chunked Output + Merge):**
- Already existed in the codebase (implemented in Phase 5)
- The `merge` command supports combining edit files from multiple sub-agents
- No code changes needed - the skill documents already reference this capability
- Can be used in conjunction with markdown format for parallel sub-agent workflows

### Verification Test Results

Tested with `/claude-review` on the Asset Purchase Agreement (UK → Singapore conversion):

| Metric | Result |
|--------|--------|
| Total edits generated | 73 |
| Edits applied | 73 |
| Edits skipped | 0 |
| Output file | test8.docx |

**Critical blocks (previously omitted per this document):**
- b257 (TULRCA definition): ✅ DELETE edit present
- b258 (TUPE definition): ✅ DELETE edit present
- b236 (VAT Records in Records def): ✅ REPLACE edit present
- b260 (VAT Records definition): ✅ REPLACE edit present

All previously-omitted items were correctly captured using the markdown format.

---

*Implementation completed: 4 February 2026*
