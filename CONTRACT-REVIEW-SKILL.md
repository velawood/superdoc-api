---
name: Contract Review Skill
description: Comprehensive methodology for AI agents to systematically review and amend contracts using superdoc-redlines
---

# Contract Review Skill

## Overview

This skill document provides a **systematic methodology** for reviewing and amending legal contracts using the superdoc-redlines library. The key principles are:

1. **Chunked, systematic review** - Process documents in manageable chunks to ensure no clauses are missed
2. **Exact amendments at analysis time** - Draft the precise replacement text during analysis, not vague directions

---

## ⚠️ CRITICAL RULE: Exact Amendments Required

**When analyzing each chunk, you MUST draft the EXACT replacement text immediately.**

### ❌ WRONG: Vague Directions

```markdown
| Block ID | Issue | Proposed Amendment |
|----------|-------|-------------------|
| b165 | UK jurisdiction | Change "London" to "Singapore" |
| b180 | Wrong statute | Update to Singapore Companies Act |
```

### ✅ CORRECT: Exact Replacement Text

```markdown
| Block ID | Current Text | Exact New Text |
|----------|--------------|----------------|
| b165 | "Business Day: a day other than a Saturday, Sunday or public holiday in England when banks in London are open for business." | "Business Day: a day other than a Saturday, Sunday or public holiday in Singapore when banks in Singapore are open for business." |
| b180 | "Companies Acts: the Companies Act 1985 and the Companies Act 2006." | "Companies Act: the Companies Act 1967 of Singapore." |
```

### Why This Matters

1. **No interpretation gap** - The exact text eliminates ambiguity when creating edits
2. **Immediate validation** - You can verify the amendment makes grammatical/legal sense
3. **Faster execution** - No need to re-read clauses when building the edits.json file
4. **Quality control** - Seeing old vs new text side-by-side catches errors

## Critical Strategy: Chunked Review

### Why Chunking Matters

Large contracts (50+ pages) cannot be reliably processed in a single pass due to:
1. **Context window limits** - LLMs may truncate or hallucinate when processing too much text
2. **Attention degradation** - Quality of analysis decreases with document length
3. **Missed clauses** - Easy to skip definitions, schedules, or boilerplate sections
4. **Position drift** - Long documents increase risk of misaligned edit positions

### Recommended Token Limits

**⚠️ ALWAYS use 10,000 tokens per chunk maximum for thorough contract review.**

| Document Size | Chunk Size | Expected Chunks | Strategy |
|---------------|------------|-----------------|----------|
| < 20K tokens | 10K tokens | 1-2 chunks | Full systematic review |
| 20K - 50K tokens | 10K tokens | 2-5 chunks | Section-by-section |
| 50K - 150K tokens | 10K tokens | 5-15 chunks | Clause-by-clause |
| > 150K tokens | 10K tokens | 15+ chunks | Paragraph-level |

**Why 10K tokens?**
- Forces granular attention on each clause
- Prevents attention degradation
- Ensures no definitions or schedules are skipped
- Allows thorough drafting of exact amendments per chunk

### Library Chunking Support

The superdoc-redlines library provides **built-in chunking** with structured output:

```bash
# Set chunk size with --max-tokens
node superdoc-redline.mjs read --input contract.docx --max-tokens 10000 --chunk 0
```

**Structured JSON output:**
```json
{
  "success": true,
  "totalChunks": 5,
  "currentChunk": 0,
  "hasMore": true,
  "nextChunkCommand": "node superdoc-redline.mjs read --input \"contract.docx\" --chunk 1 --max-tokens 10000",
  "document": {
    "metadata": {
      "filename": "contract.docx",
      "chunkIndex": 0,
      "totalChunks": 5,
      "blockRange": { "start": "b001", "end": "b050" }
    },
    "outline": [ /* full document outline for context */ ],
    "blocks": [ /* blocks in this chunk with IDs */ ],
    "idMapping": { "uuid-1": "b001", "uuid-2": "b002" }
  }
}
```

**Key features:**
- `totalChunks` - Know upfront how many chunks to process
- `hasMore` - Boolean to control loop termination
- `nextChunkCommand` - Ready-to-run command for next chunk
- `outline` - Full document outline included in EVERY chunk for context
- `blockRange` - Shows which blocks (e.g., b001-b050) are in this chunk

---

## Systematic Review Workflow (Two-Pass)

**Contract review requires TWO passes through the document:**

```
┌─────────────────────────────────────────────────────────────────┐
│  PASS 1: DISCOVERY (Read-Only)                                  │
│  Purpose: Build complete Context Document                       │
│  Output: Term locations, UK provisions to change, dependencies  │
├─────────────────────────────────────────────────────────────────┤
│  PASS 2: AMENDMENT (With Full Context)                          │
│  Purpose: Draft exact amendments with cross-chunk awareness     │
│  Output: Master Amendment Plan + edits.json                     │
└─────────────────────────────────────────────────────────────────┘
```

### Why Two Passes?

When you change "VAT" to "GST" in the Definitions (Chunk 1), you need to know:
- Where else does "VAT" appear? (Chunks 3, 5, 7...)
- What other terms reference VAT?
- Are there cross-references to the VAT definition?

**You cannot know this if you only see one chunk at a time.**

---

## Setup Phase: Document Preparation

### Step 1: Get Document Statistics

```bash
cd /path/to/superdoc-redlines
node superdoc-redline.mjs read --input contract.docx --stats-only
```

**Output:**
```json
{
  "success": true,
  "stats": {
    "blockCount": 1337,
    "estimatedTokens": 43242,
    "recommendedChunks": 1
  }
}
```

### Step 2: Extract Structure

```bash
node superdoc-redline.mjs extract --input contract.docx --output contract-ir.json
```

This gives you block IDs (`b001`, `b002`, etc.) for the entire document.

---

## PASS 1: Discovery (Read-Only)

**Goal:** Read ALL chunks and build a **Context Document** - NO amendments yet.

### Step 1.1: Read Each Chunk (Discovery Mode)

```bash
# Read all chunks sequentially
node superdoc-redline.mjs read --input contract.docx --chunk 0 --max-tokens 10000
node superdoc-redline.mjs read --input contract.docx --chunk 1 --max-tokens 10000
# ... continue until hasMore: false
```

### Step 1.2: Build Context Document

As you read each chunk, populate the **Context Document**:

```markdown
# Context Document: [Contract Name]

## Document Statistics
- Total chunks: X
- Total blocks: Y
- Date: [date]

## 1. Defined Terms Registry

### Terms to Change (UK → Singapore)
| Term | Definition Block | All Usage Blocks | New Term |
|------|-----------------|------------------|----------|
| VAT | b259 | b259, b395, b396, b450, b512 | GST |
| HMRC | b210 | b210, b131, b445 | IRAS |
| DPA 1998 | b194 | b194, b892, b920 | PDPA |
| National Insurance | b400 | b400, b737, b956 | CPF |
| Companies Act 2006 | b180 | b180, b274, b844 | Companies Act 1967 |

### Compound Defined Terms
| Compound Term | Contains | Definition Block | Usage Blocks | New Term |
|---------------|----------|------------------|--------------|----------|
| VAT Records | VAT | b263 | b263, b512 | GST Records |
| VAT Returns | VAT | b264 | b264, b450 | GST Returns |

**⚠️ CRITICAL**: When changing a base term (e.g., VAT→GST), search for ALL compound terms that include it. Compound defined terms have their own definitions and must be tracked separately.

### UK-Specific Definitions to DELETE
| Term | Definition Block | Action | Rationale |
|------|-----------------|--------|-----------|
| TULRCA | b257 | DELETE | No Singapore equivalent |
| TUPE | b258 | DELETE | No Singapore equivalent - use offer-and-accept model |

**⚠️ CRITICAL**: These definitions MUST be deleted. The definition blocks themselves must be removed, not just the operational clauses that reference them.

### Other Defined Terms (Reference)
| Term | Definition Block | Usage Blocks |
|------|-----------------|--------------|
| Business | b163 | b163, b201, b305... |
| Completion | b182 | b182, b350, b380... |
| Assets | b161 | b161, b220, b310... |

## 2. UK-Specific Provisions to Delete/Replace

| Block ID | Provision | Action | Singapore Equivalent Needed? |
|----------|-----------|--------|------------------------------|
| b257 | TULRCA definition | DELETE | No - no equivalent |
| b258 | TUPE definition | DELETE | Yes - employment transfer provisions |
| b762-b770 | UK Merger Control | DELETE | Yes - CCCS provisions |
| b450-b460 | VAT TOGC provisions | DELETE | Yes - GST going concern provisions |

## 3. Cross-References Map

| Reference | Points To | Block IDs |
|-----------|----------|-----------|
| "as defined in clause 1" | Definitions section | b165, b302, b445 |
| "pursuant to clause 5" | Completion clause | b520, b612 |

## 4. Chunks Summary

| Chunk | Block Range | Key Sections | UK Provisions Found |
|-------|-------------|--------------|---------------------|
| 0 | b001-b150 | Parties, Recitals | Company registration |
| 1 | b151-b300 | Definitions | VAT, HMRC, TUPE, TULRCA, Companies Act |
| 2 | b301-b450 | Sale provisions | VAT references |
| 3 | b451-b600 | Completion | PAYE, NI references |
| 4 | b601-b750 | Employees | TUPE, Working Time Regs |
| 5 | b751-b900 | Warranties | Various statutory refs |
```

### Step 1.3: Definitions Audit (CRITICAL)

**⚠️ This step is MANDATORY. Failure to complete it results in missed deletions.**

During discovery, systematically scan the Definitions section and:

1. **List EVERY defined term** in the Definitions section
2. **Flag UK-specific definitions for DELETE**:
   - TUPE (Transfer of Undertakings regulations)
   - TULRCA (Trade Union and Labour Relations Act)
   - Working Time Regulations
   - Any UK statute that has no Singapore equivalent
3. **Identify compound defined terms**:
   - Search for terms that CONTAIN other terms being changed
   - Example: "VAT Records" contains "VAT" → must change to "GST Records"
   - Example: "VAT Returns" contains "VAT" → must change to "GST Returns"
4. **Record block IDs for ALL items requiring deletion**

```markdown
## Definitions Audit Results

### UK-Specific Definitions to DELETE (No Singapore Equivalent)
| Term | Block ID | Verified in Context Doc? |
|------|----------|-------------------------|
| TULRCA | b257 | [ ] |
| TUPE | b258 | [ ] |

### Compound Terms to CHANGE
| Compound Term | Base Term | Block ID | New Term |
|---------------|-----------|----------|----------|
| VAT Records | VAT | b263 | GST Records |
| VAT Returns | VAT | b264 | GST Returns |
```

### Step 1.4: Discovery Checklist

Before proceeding to Pass 2, verify:

- [ ] All chunks have been read
- [ ] All defined terms logged with ALL usage locations
- [ ] **DEFINITIONS AUDIT COMPLETE:**
  - [ ] Every definition in the Definitions section reviewed
  - [ ] UK-specific definitions flagged for DELETE with block IDs
  - [ ] Compound terms identified and added to tracking
- [ ] All UK-specific provisions identified
- [ ] Cross-references mapped
- [ ] Singapore equivalents identified for deletions

---

## PASS 2: Amendment (With Context)

**Goal:** Read each chunk AGAIN, now drafting exact amendments with full cross-chunk awareness.

### Step 2.1: Read Chunk with Context Document

For each chunk, you now have:
1. The chunk content
2. The Context Document showing where terms appear across ALL chunks

### Step 2.2: Draft Amendments Per Chunk

Now you can confidently amend because you KNOW:
- "VAT" appears in b259, b395, b396, b450, b512 → must change ALL of them
- When you see "VAT" in b395, you know the definition was changed in b259

```markdown
## Chunk [N] Amendments

### Block Range
- Start: b[XXX]
- End: b[YYY]

### Amendments (with cross-chunk awareness)

#### Amendment 1 (Block b395) - VAT Reference
**Context:** Definition changed from VAT→GST in b259 (Chunk 1)
**Current Text:** "...any VAT payable in respect of..."
**Exact New Text:** "...any GST payable in respect of..."
**Diff Mode:** true
```

### Step 2.3: Update Context Document

After amending each chunk, mark it complete:

```markdown
## 1. Defined Terms Registry (Updated)

| Term | Definition Block | All Usage Blocks | New Term | Status |
|------|-----------------|------------------|----------|--------|
| VAT | b259 | b259, b395, b396, b450, b512 | GST | ✓ All amended |
| HMRC | b210 | b210, b131, b445 | IRAS | ✓ All amended |
```

---

## Context Document Template

Create this file BEFORE starting Pass 2:

```markdown
# Context Document: [Contract Name]
# Created: [Date]
# Source: [filename.docx]

## 1. Defined Terms to Change
| Original | New | Def Block | Usage Blocks | Amended? |
|----------|-----|-----------|--------------|----------|
| VAT | GST | b259 | b259, b395, b396, b450 | [ ] |
| HMRC | IRAS | b210 | b210, b131 | [ ] |

## 2. Compound Defined Terms (CRITICAL)
**⚠️ These are separate defined terms that CONTAIN other terms being changed.**

| Compound Term | Contains | Def Block | Usage Blocks | New Term | Amended? |
|---------------|----------|-----------|--------------|----------|----------|
| VAT Records | VAT | b263 | b263, b512 | GST Records | [ ] |
| VAT Returns | VAT | b264 | b264, b450 | GST Returns | [ ] |

**How to find compound terms:**
1. For each term in "Defined Terms to Change", search the Definitions section for terms containing it
2. Example: Changing "VAT"? Search for "VAT " in all definition block text
3. Add any compound terms found to this table

## 3. UK Definitions to DELETE (No Singapore Equivalent)
**⚠️ These definition blocks MUST be deleted entirely.**

| Term | Def Block | Delete Edit Created? | Verified? |
|------|-----------|---------------------|-----------|
| TULRCA | b257 | [ ] | [ ] |
| TUPE | b258 | [ ] | [ ] |

## 4. UK Provisions to Delete + Singapore Insertions
| Block | UK Provision | Delete? | Insert SG Equivalent? | Insert After |
|-------|-------------|---------|----------------------|--------------|
| b762 | UK Merger Control | Yes | Yes - CCCS | b761 |

## 5. Global Find-Replace Tracking
| Find | Replace | Blocks Affected | Completed |
|------|---------|-----------------|-----------|
| "England and Wales" | "Singapore" | b149, b150, b680 | [ ] |
| "sterling" | "Singapore Dollars" | b288, b330 | [ ] |

## 6. Amendment Progress
| Chunk | Blocks | Status | Amendments |
|-------|--------|--------|------------|
| 0 | b001-b100 | [ ] Pending | 0 |
| 1 | b101-b200 | [ ] Pending | 0 |
```

---

## Detailed Chunk Analysis (Pass 2)

For each chunk in Pass 2, create a **chunk analysis document** with **exact replacement text**:

```markdown
## Chunk [N] Analysis

### Block Range
- Start: b[XXX]
- End: b[YYY]
- Sections covered: [list major sections]

### Amendments Required

#### Amendment 1 (Block b165) - Jurisdiction
**Category:** Jurisdiction  
**Diff Mode:** `true` (word-level - only "England/London" → "Singapore" changes)  
**Current Text:**
> "Business Day: a day other than a Saturday, Sunday or public holiday in England when banks in London are open for business."

**Exact New Text:**
> "Business Day: a day other than a Saturday, Sunday or public holiday in Singapore when banks in Singapore are open for business."

**Rationale:** Updated jurisdiction from England/London to Singapore.

---

#### Amendment 2 (Block b180) - Statutory Reference
**Category:** Statutory Reference  
**Diff Mode:** `false` (full replace - definition structure changes significantly)  
**Current Text:**
> "Companies Acts: the Companies Act 1985 and the Companies Act 2006."

**Exact New Text:**
> "Companies Act: the Companies Act 1967 of Singapore."

**Rationale:** Replaced UK Companies Acts with Singapore equivalent. Note singular "Act" as Singapore has one consolidated statute. Cited with year of enactment (1967), not chapter number.

---

#### Amendment 3 (Block b257) - DELETE
**Category:** Employment Law  
**Current Text:**
> "TULRCA: the Trade Union and Labour Relations (Consolidation) Act 1992."

**Action:** DELETE entire block

**Rationale:** Singapore does not have equivalent legislation. Trade union matters governed by Trade Unions Act (Cap. 333).

---

### Chunk Summary
- Total amendments: 3
- Replacements: 2 (1 word-level diff, 1 full replace)
- Deletions: 1
- Comments only: 0
```

**⚠️ IMPORTANT**: The "Exact New Text" field must contain the COMPLETE replacement text, word-for-word, ready to be copied into the edits.json file.

### Final Output: Master Amendment Plan

After completing Pass 2 for ALL chunks, consolidate into the **Master Amendment Plan** with all exact amendments:

```markdown
# Amendment Plan: [Document Name]

## Summary Statistics
- Total blocks reviewed: X
- Total chunks processed: Y
- Total amendments needed: Z
  - Replacements: A
  - Deletions: B
  - Insertions: C
  - Comments only: D

## Amendments by Category

### 1. Jurisdiction Changes (N edits)
| # | Block ID | Diff | Exact New Text | Rationale |
|---|----------|------|----------------|-----------|
| 1 | b165 | true | "Business Day: a day other than a Saturday, Sunday or public holiday in Singapore when banks in Singapore are open for business." | Word swap: England/London→Singapore |
| 2 | b680 | true | "This agreement shall be governed by and construed in accordance with the laws of Singapore." | Word swap: England and Wales→Singapore |

### 2. Statutory References (N edits)
| # | Block ID | Diff | Exact New Text | Rationale |
|---|----------|------|----------------|-----------|
| 3 | b180 | false | "Companies Act: the Companies Act 1967 of Singapore." | Full rewrite: plural→singular, cited with year |
| 4 | b194 | false | "PDPA: the Personal Data Protection Act 2012 of Singapore." | Full rewrite: new definition name, cited with year |

### 3. Deletions (N edits)
| # | Block ID | Current Text (for reference) | Rationale |
|---|----------|------------------------------|-----------|
| 5 | b257 | "TULRCA: the Trade Union and Labour Relations..." | Not applicable in SG |
| 6 | b762 | "UK Merger Control Requirements..." | Replace with CCCS provisions |

### 4. Comments Only (N items)
| # | Block ID | Comment Text |
|---|----------|--------------|
| 7 | b400 | "REVIEW: Verify CPF contribution rates with Singapore counsel" |

## Ready for edits.json
All amendments above contain exact text ready for direct transfer to edits.json file.
```

**⚠️ The master plan IS the source of truth for edits.json** - no further interpretation or drafting should be needed when creating the final edit file.

---

## Amendment Categories for Jurisdiction Conversion

When converting a contract from one jurisdiction to another (e.g., UK → Singapore), systematically review these categories:

### 1. Governing Law & Jurisdiction
- Governing law clause
- Dispute resolution / arbitration
- Court jurisdiction
- Service of process

### 2. Statutory References

**⚠️ CITATION FORMAT: Always cite Singapore legislation with YEAR OF ENACTMENT, not chapter numbers.**

| Find | Replace With | Year |
|------|--------------|------|
| Companies Act 2006 | Companies Act 1967 | 1967 |
| Data Protection Act 1998/2018 / UK GDPR | Personal Data Protection Act 2012 | 2012 |
| Employment Rights Act 1996 | Employment Act 1968 | 1968 |
| Insolvency Act 1986 | Insolvency, Restructuring and Dissolution Act 2018 | 2018 |
| TUPE Regulations | N/A (not applicable - see note below) | - |
| Consumer Rights Act 2015 | Consumer Protection (Fair Trading) Act 2003 | 2003 |
| Value Added Tax Act 1994 | Goods and Services Tax Act 1993 | 1993 |
| Copyright, Designs and Patents Act 1988 | Copyright Act 2021 | 2021 |
| Bribery Act 2010 | Prevention of Corruption Act 1960 | 1960 |
| Competition Act 1998 / Enterprise Act 2002 | Competition Act 2004 | 2004 |

**❌ WRONG:** "Employment Act (Cap. 91)"  
**✅ CORRECT:** "Employment Act 1968"

### 3. Regulatory Bodies
| Find | Replace With |
|------|--------------|
| Companies House | ACRA (Accounting and Corporate Regulatory Authority) |
| HMRC | IRAS (Inland Revenue Authority of Singapore) |
| FCA | MAS (Monetary Authority of Singapore) |
| ICO | PDPC (Personal Data Protection Commission) |
| CMA (Competition) | CCCS (Competition and Consumer Commission of Singapore) |

### 4. Corporate Terminology
| Find | Replace With |
|------|--------------|
| registered in England and Wales | incorporated in Singapore |
| company number | unique entity number (UEN) |
| registered office | registered address |
| UK GAAP | SFRS (Singapore Financial Reporting Standards) |

### 5. Tax & Employment
| Find | Replace With |
|------|--------------|
| PAYE | Income tax withholding / IRAS |
| National Insurance | CPF (Central Provident Fund) |
| VAT | GST (Goods and Services Tax) |
| Employer's NI contributions | Employer's CPF contributions |

### 6. Specific Regulations to Remove/Replace
- TUPE (Transfer of Undertakings) → Not applicable in Singapore
- UK Merger Control (CMA) → CCCS merger notification regime
- UK Bribery Act → Prevention of Corruption Act 1960
- Contracts (Rights of Third Parties) Act 1999 → Contracts (Rights of Third Parties) Act 2001

---

## ⚠️ CRITICAL: Delete-and-Insert Principle

**When deleting a UK-specific provision, ALWAYS assess whether a corresponding Singapore provision should be inserted.**

### The Rule

```
DELETE UK provision → ASSESS Singapore equivalent → INSERT if appropriate
```

### Common Delete-and-Insert Scenarios

| UK Provision Deleted | Singapore Equivalent to INSERT |
|---------------------|-------------------------------|
| VAT provisions | GST provisions (rate: 9%) |
| PAYE/National Insurance | CPF contribution provisions |
| SDLT (Stamp Duty Land Tax) | BSD/ABSD/SSD stamp duty provisions |
| TUPE transfer provisions | Offer-and-acceptance employment transfer provisions |
| UK pension scheme references | CPF or private pension references |
| Working Time Regulations | Employment Act annual leave provisions |
| UK merger control (CMA) | CCCS voluntary notification provisions |

### Example: VAT → GST

**❌ WRONG approach:**
```json
{
  "blockId": "b450",
  "operation": "delete",
  "comment": "Deleted UK VAT provisions - not applicable"
}
```

**✅ CORRECT approach:**
```json
[
  {
    "blockId": "b450",
    "operation": "delete",
    "comment": "Deleted UK VAT provisions - replaced with Singapore GST"
  },
  {
    "afterBlockId": "b449",
    "operation": "insert",
    "text": "The sale of the Business as a going concern is intended to qualify as a transfer of a going concern for GST purposes under section 10(4) of the Goods and Services Tax Act 1993. The Buyer warrants that it is registered for GST and will remain so registered.",
    "comment": "Inserted Singapore GST equivalent provisions"
  }
]
```

### Assessment Checklist for Deletions

When you encounter a UK provision to delete, ask:

1. **Does Singapore have an equivalent regime?**
   - VAT → GST ✓
   - TUPE → No automatic transfer, but need employment provisions ✓
   - UK pension → CPF ✓

2. **Is the equivalent provision necessary for the transaction?**
   - Going concern relief? → GST provisions needed
   - Employee transfers? → Offer-and-acceptance provisions needed
   - Property transfer? → Stamp duty provisions needed

3. **What specific Singapore provisions should be inserted?**
   - Draft the EXACT text to insert
   - Reference correct Singapore statutes (with year)
   - Use appropriate terminology

---

## Creating the Edits File

### Output Format: Markdown Preferred

**⚠️ For large edit sets (>30 edits), use Markdown format instead of JSON.**

When generating long structured output (50+ edits, 5000+ tokens), JSON format increases the risk of:
- Syntax errors (missing commas, unclosed quotes)
- Content omission (simple edits dropped while generating complex ones)
- Unusable output (single syntax error breaks entire file)

Markdown tables eliminate these issues:

```markdown
## Edits Table

| Block | Op | Diff | Comment |
|-------|-----|------|---------|
| b257 | delete | - | DELETE TULRCA definition |
| b258 | delete | - | DELETE TUPE definition |
| b165 | replace | true | Change Business Day to Singapore |
| b180 | replace | false | Replace Companies Act definition |

## Replacement Text

### b165 newText
Business Day: a day other than a Saturday, Sunday or public holiday in Singapore when banks in Singapore are open for business.

### b180 newText
Companies Act: the Companies Act 1967 of Singapore.
```

**Advantages:**
| Aspect | JSON | Markdown |
|--------|------|----------|
| Syntax errors | Fatal (invalid JSON) | Recoverable |
| Missing comma | Breaks entire file | No commas needed |
| Quote escaping | Complex (`\"`) | Natural |
| Partial output | Unusable | Still parseable |
| Human readable | Requires formatting | Native |

**Converting to JSON:**
```bash
node superdoc-redline.mjs parse-edits -i edits.md -o edits.json
```

**Applying directly from markdown:**
```bash
node superdoc-redline.mjs apply -i contract.docx -o amended.docx -e edits.md
```

### Word-Level Diff vs Full Replacement

The superdoc-redlines library supports **word-level diff** that produces clean tracked changes in Word:

| Mode | `diff` Setting | Result in Word | Best For |
|------|----------------|----------------|----------|
| **Word-level diff** | `true` (default) | Only changed words shown as ~~deleted~~ / inserted | Surgical edits, term replacements |
| **Full replacement** | `false` | Entire block shown as ~~deleted~~ then inserted | Complete rewrites, structural changes |

#### How Word-Level Diff Works

```
Original: "...registered in England and Wales with company number..."
New:      "...registered in Singapore with unique entity number (UEN)..."

With diff: true → Word shows:
  "...registered in ~~England and Wales~~ Singapore with ~~company number~~ unique entity number (UEN)..."

With diff: false → Word shows:
  ~~"...registered in England and Wales with company number..."~~
  "...registered in Singapore with unique entity number (UEN)..."
```

### When to Use Each Mode

| Use `diff: true` (word-level) | Use `diff: false` (full replace) |
|-------------------------------|----------------------------------|
| Changing a few words/terms | Rewriting entire clause |
| "England" → "Singapore" | Restructuring sentence order |
| "HMRC" → "IRAS" | Adding/removing substantial content |
| "VAT" → "GST" | When diff would be confusing |
| Term definitions with minor updates | Complete definitional overhaul |

### Technical Details: How Word-Level Diff Works

The library uses `diff-match-patch` internally:

1. **Tokenization**: Original and new text are tokenized into words
2. **Diff computation**: `wordDiff.mjs` computes granular word-level differences
3. **Reverse application**: `blockOperations.mjs` applies operations end-to-start to avoid position corruption
4. **Atomic execution**: Each operation uses `editor.chain().run()` for atomic execution
5. **Track changes**: SuperDoc marks deletions with `trackDelete` and insertions with `trackInsert`

**Result in Microsoft Word:**
- Deleted text → ~~strikethrough~~
- Inserted text → underlined/highlighted
- Changes attributed to the specified author

### Best Practices

1. **Default to `diff: true`** - Produces cleaner tracked changes that are easier to review

2. **Use `diff: false` for extensive rewrites** - When >50% of the text changes

3. **Add comments to all edits** - Explain the rationale for each change

4. **Use consistent block IDs** - Always use `seqId` format (e.g., `b165`) for readability

5. **Validate before applying** - Always run validation first

### Edit File Template

```json
{
  "version": "0.2.0",
  "author": {
    "name": "AI Legal Counsel",
    "email": "ai@firm.com"
  },
  "edits": [
    {
      "blockId": "b165",
      "operation": "replace",
      "newText": "Business Day: a day other than a Saturday, Sunday or public holiday in Singapore when banks in Singapore are open for business.",
      "comment": "Jurisdiction: Changed UK business day definition to Singapore",
      "diff": true
    },
    {
      "blockId": "b180",
      "operation": "replace",
      "newText": "Companies Act: the Companies Act 1967 of Singapore.",
      "comment": "Statutory Reference: Replaced UK Companies Act 2006 with Singapore equivalent (cited with year)",
      "diff": true
    },
    {
      "blockId": "b758",
      "operation": "replace",
      "newText": "The Buyer shall notify the Competition Commission of Singapore (CCCS) if required under the Competition Act 2004. The parties may voluntarily seek clearance from CCCS prior to Completion.",
      "comment": "Complete rewrite of merger control provisions for Singapore voluntary regime",
      "diff": false
    },
    {
      "blockId": "b512",
      "operation": "delete",
      "comment": "TUPE: Deleted clause as Transfer of Undertakings regulations do not apply in Singapore"
    },
    {
      "blockId": "b600",
      "operation": "comment",
      "comment": "REVIEW: Please verify whether Singapore-specific employment protections need to be added"
    }
  ]
}
```

---

## Pre-Generation Verification Checklist

**⚠️ MANDATORY: Before generating the edits file, output this checklist to verify completeness.**

This checklist prevents content omission during edit generation. Create it from your Context Document.

```markdown
## Pre-Generation Verification Checklist

### 1. Deletions Required (UK definitions with no SG equivalent)
| Block | Term | Checked |
|-------|------|---------|
| b257 | TULRCA definition | [ ] |
| b258 | TUPE definition | [ ] |

### 2. Compound Terms to Change
| Block | Current | New | Checked |
|-------|---------|-----|---------|
| b236 | VAT Records | GST Records | [ ] |
| b260 | VAT Records def | GST Records def | [ ] |

### 3. Base Terms to Change (Definition blocks)
| Block | Current | New | Checked |
|-------|---------|-----|---------|
| b259 | VAT | GST | [ ] |
| b210 | HMRC | IRAS | [ ] |
| b180 | Companies Act 2006 | Companies Act 1967 | [ ] |
| b194 | DPA 1998 | PDPA 2012 | [ ] |

### 4. Jurisdiction Changes
| Block | Change | Checked |
|-------|--------|---------|
| b149 | England and Wales → Singapore | [ ] |
| b150 | England and Wales → Singapore | [ ] |
| b165 | Business Day: England/London → Singapore | [ ] |
| b680 | Governing law → Singapore | [ ] |
| b681 | Jurisdiction → Singapore courts | [ ] |

### 5. Employment Provisions (TUPE replacement)
| Block | Action | Checked |
|-------|--------|---------|
| b450 | Rewrite as offer-and-accept | [ ] |
| b454 | Delete TUPE reg 11 ref | [ ] |
| b456 | Delete TUPE/TULRCA ref | [ ] |

**VERIFY: All boxes checked before generating edits file.**
```

### Why This Checklist Matters

During generation of long structured output (50+ edits), the LLM may:
- Focus on complex replacements while dropping simple deletions
- Forget items identified during analysis
- Skip low-priority-seeming edits

The checklist creates an explicit verification step that catches omissions *before* the final output.

### Checklist Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Complete Pass 2 analysis (all chunks reviewed)              │
├─────────────────────────────────────────────────────────────────┤
│  2. Build checklist from Context Document                       │
│     - All deletions (UK definitions with no SG equivalent)      │
│     - All compound terms                                        │
│     - All base term changes                                     │
│     - All jurisdiction changes                                  │
│     - All employment provision rewrites                         │
├─────────────────────────────────────────────────────────────────┤
│  3. Verify checklist is complete                                │
│     - Every item from Context Document is listed                │
│     - No categories are missing                                 │
├─────────────────────────────────────────────────────────────────┤
│  4. Generate edits file (markdown format recommended)           │
│     - Check off each item as you add it to the edits            │
│     - If an item is missing from edits, add it before finishing │
├─────────────────────────────────────────────────────────────────┤
│  5. Final verification                                          │
│     - All checklist boxes should be checked                     │
│     - Count of edits should match checklist items               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Execution Workflow

### Step 1: Pre-Apply Verification (MANDATORY)

**⚠️ Before running validation, verify coverage against the Context Document:**

```markdown
## Pre-Apply Verification Checklist

### 1. Definitions Audit Verification
| UK Definition to DELETE | Block ID | Edit Exists? | Edit Type |
|------------------------|----------|--------------|-----------|
| TULRCA | b257 | [ ] | delete |
| TUPE | b258 | [ ] | delete |

### 2. Compound Terms Verification
| Compound Term | Block ID | Edit Exists? | New Text Correct? |
|---------------|----------|--------------|-------------------|
| VAT Records | b263 | [ ] | GST Records |
| VAT Returns | b264 | [ ] | GST Returns |

### 3. Residual UK Terms Search
Search the edits file for any remaining UK terms that should have been changed:
- [ ] No "TULRCA" in any newText (should be deleted, not referenced)
- [ ] No "TUPE" in any newText (should be deleted, not referenced)
- [ ] No "VAT Records" in any newText (should be "GST Records")
- [ ] No "VAT Returns" in any newText (should be "GST Returns")
- [ ] No "HMRC" in any newText (should be "IRAS")
- [ ] No "England and Wales" in any newText (should be "Singapore")
```

**If any check fails:** Go back to the amendment pass and add the missing edits.

### Step 2: Validate Edits

```bash
node superdoc-redline.mjs validate \
  --input contract.docx \
  --edits edits.json
```

### Step 3: Apply Edits with Track Changes

```bash
node superdoc-redline.mjs apply \
  --input contract.docx \
  --output contract-amended.docx \
  --edits edits.json \
  --author-name "AI Legal Counsel"
```

### Step 4: Post-Apply Verification

Search the output document for any residual UK terms:

```bash
# Read output and search for UK-specific terms that should have been changed
node superdoc-redline.mjs read --input contract-amended.docx --stats-only

# Then grep through each chunk for residual terms:
# - TULRCA (should not exist)
# - TUPE (should not exist)
# - "VAT Records" (should be "GST Records")
# - HMRC (should be IRAS)
# - "England and Wales" (should be Singapore)
```

If residual terms found: Create additional edits and re-apply.

---

## Quality Checklist

Before finalizing amendments, verify:

### Two-Pass Completion
- [ ] **Pass 1 completed** - All chunks read in discovery mode
- [ ] **Context Document created** - All defined terms and usages logged
- [ ] **Pass 2 completed** - All chunks reviewed with amendments drafted

### Document Coverage
- [ ] All chunks have been reviewed in BOTH passes
- [ ] Definitions section checked completely
- [ ] All schedules and annexures reviewed
- [ ] Boilerplate clauses examined
- [ ] Signature blocks updated if needed

### Cross-Chunk Consistency
- [ ] **All term usages updated** - Context Document shows all amended
- [ ] **No orphaned references** - Deleted terms don't appear elsewhere
- [ ] **Cross-references valid** - Clause numbers still correct

### Amendment Quality
- [ ] **Every amendment has EXACT replacement text** (no vague directions)
- [ ] Each `newText` contains the COMPLETE block content
- [ ] Replacement text is grammatically correct and makes legal sense
- [ ] Old text and new text have been compared side-by-side
- [ ] **Singapore statutes cited with year** (not chapter number)

### Legal Accuracy
- [ ] All statutory references are correct
- [ ] Regulatory body names are accurate
- [ ] Jurisdiction-specific concepts properly adapted
- [ ] Inapplicable provisions properly deleted or noted
- [ ] Cross-references still valid after changes

### Technical Correctness
- [ ] All block IDs verified against extracted IR
- [ ] Edits validated successfully
- [ ] `diff: true` used for surgical changes (few words)
- [ ] `diff: false` used only for complete rewrites (>50% change)
- [ ] Comments added to all substantive changes
- [ ] Author attribution set correctly

---

## Handling Large Documents

For documents exceeding 100K tokens:

### Option 1: Section-Based Multi-Agent Workflow

```bash
# Split by section
# Agent 1: Definitions (b001-b200)
# Agent 2: Warranties (b201-b400)
# Agent 3: Schedules (b401-b600)

# Each agent produces edits
# edits-definitions.json, edits-warranties.json, etc.

# Merge all edits
node superdoc-redline.mjs merge \
  edits-definitions.json \
  edits-warranties.json \
  edits-schedules.json \
  -o merged-edits.json \
  -c combine \
  -v contract.docx

# Apply merged edits
node superdoc-redline.mjs apply \
  -i contract.docx \
  -o contract-amended.docx \
  -e merged-edits.json
```

### Option 2: Progressive Chunked Review

Process document in sequential chunks, accumulating edits:

```bash
# Process each chunk with 10K token limit, building cumulative edit list
chunk=0
while true; do
  result=$(node superdoc-redline.mjs read --input contract.docx --chunk $chunk --max-tokens 10000)
  # Analyze output, draft EXACT amendments, add edits to master list
  
  # Check if more chunks exist
  hasMore=$(echo "$result" | jq -r '.hasMore')
  if [ "$hasMore" = "false" ]; then
    break
  fi
  chunk=$((chunk + 1))
done

# Validate complete edit list
node superdoc-redline.mjs validate --input contract.docx --edits all-edits.json

# Apply all at once
node superdoc-redline.mjs apply -i contract.docx -o amended.docx -e all-edits.json
```

---

## Common Pitfalls to Avoid

### 1. Vague Amendment Directions (MOST COMMON ERROR)
**Problem**: Writing "change to Singapore equivalent" instead of the exact replacement text. This leads to:
- Inconsistent drafting when creating edits.json
- Need to re-read clauses to draft actual text
- Risk of errors or omissions in final amendments

**Solution**: **Always write the EXACT replacement text during chunk analysis.** If you find yourself writing "update to...", "change to...", or "replace with equivalent..." STOP and draft the actual text immediately.

### 2. Skipping the Discovery Pass
**Problem**: Jumping straight to amendments without building Context Document. Results in:
- Changing "VAT" to "GST" in definitions but missing VAT references in later clauses
- Not knowing where terms are used across the document
- Inconsistent amendments

**Solution**: **Always complete Pass 1 (Discovery) before Pass 2 (Amendment).** Build the Context Document with ALL term usages before drafting any amendments.

### 3. Single-Pass Processing
**Problem**: Processing entire document in one LLM call leads to missed clauses.
**Solution**: Always chunk documents and process systematically with 10K token limit.

### 4. Misusing Diff Modes
**Problem**: Using `diff: false` for everything produces verbose tracked changes that are hard to review.
**Solution**: 
- Use `diff: true` (default) for surgical edits where only a few words change
- Use `diff: false` only for complete clause rewrites (>50% text change)

### 5. Missing Defined Terms Usages
**Problem**: Defined terms in one section affect meaning throughout document. Without Context Document, you don't know where terms appear.
**Solution**: Build Context Document in Pass 1 showing ALL blocks where each term appears.

### 6. Incomplete Statutory Updates
**Problem**: Updating main clause but missing references in schedules.
**Solution**: Context Document should track all statutory references and their locations.

### 7. Cross-Reference Breakage
**Problem**: Deleting clauses breaks numbered cross-references.
**Solution**: Use comments instead of deletes where possible, or update all cross-references.

### 8. Partial Block Text
**Problem**: Only providing the changed portion of text, not the full block content.
**Solution**: The `newText` field must contain the ENTIRE block's new content, not just the changed words.

### 9. Delete Without Insert
**Problem**: Deleting UK-specific provisions without assessing whether Singapore equivalent is needed.
**Solution**: Use the Delete-and-Insert principle. When deleting VAT provisions, ask: "Does Singapore need GST provisions here?"

### 10. Definition Blocks Not Deleted (CRITICAL)
**Problem**: Updating operational clauses that REFERENCE UK terms (TUPE, TULRCA) but NOT deleting the definition blocks themselves. The definitions remain in the document even though they're not used.

**Example of error:**
- b450 (operational clause): Changed "TUPE" reference to "Employment Act 1968" ✓
- b257 (TULRCA definition): NOT DELETED ✗
- b258 (TUPE definition): NOT DELETED ✗

**Solution**:
1. Complete the Definitions Audit in Pass 1
2. For EVERY UK-specific definition with no Singapore equivalent, create a DELETE edit
3. Use Pre-Apply Verification to confirm delete edits exist

### 11. Compound Defined Terms Missed (CRITICAL)
**Problem**: Changing a base term (VAT→GST) but missing compound terms that contain it (VAT Records, VAT Returns).

**Example of error:**
- b259 (VAT definition): Changed to GST ✓
- b263 (VAT Records definition): NOT CHANGED ✗ → "VAT Records" still in document

**Solution**:
1. For each term being changed, search Definitions for compound terms containing it
2. Add ALL compound terms to the Context Document with their block IDs
3. Create edits for compound terms (change "VAT Records" to "GST Records")
4. Use Pre-Apply Verification to confirm compound term edits exist

---

## Summary: Key Principles

**For reliable contract review:**

1. **Two-pass workflow** - Discovery first, then Amendment
2. **Build Context Document** - Know where ALL terms appear before amending
3. **Chunk at 10,000 tokens maximum** (use `--max-tokens 10000`)
4. **Process EVERY chunk** in BOTH passes
5. **Draft EXACT replacement text** during Pass 2 (not vague directions)
6. **Delete-and-Insert** - When deleting UK provisions, insert Singapore equivalents
7. **Cite with years** - "Companies Act 1967" not "Companies Act (Cap. 50)"
8. **Use `diff: true`** for surgical edits, **`diff: false`** only for complete rewrites

### The Four Non-Negotiable Rules

```
┌─────────────────────────────────────────────────────────────────┐
│  RULE 1: TWO-PASS WORKFLOW                                      │
│  Pass 1: Discovery - read all chunks, build Context Document    │
│  Pass 2: Amendment - draft exact amendments with full context   │
├─────────────────────────────────────────────────────────────────┤
│  RULE 2: CHUNK AT 10K TOKENS                                    │
│  Always use: --max-tokens 10000                                 │
│  Never process more than 10K tokens at a time.                  │
├─────────────────────────────────────────────────────────────────┤
│  RULE 3: BUILD CONTEXT DOCUMENT                                 │
│  Track ALL defined terms and where they appear.                 │
│  Know cross-chunk dependencies BEFORE amending.                 │
├─────────────────────────────────────────────────────────────────┤
│  RULE 4: DRAFT EXACT TEXT                                       │
│  Every amendment must include the complete, word-for-word       │
│  replacement text. "Change X to Y" is NEVER acceptable.         │
└─────────────────────────────────────────────────────────────────┘
```

This approach ensures comprehensive coverage and prevents both the "missed clause" problem and the "vague amendment" problem that lead to errors in contract review.

---

## Learnings & Best Practices

This section captures learnings from real-world usage of this skill. It should be updated after each significant review session.

### Edit File Format (Critical)

**⚠️ COMMON ERROR: Using incorrect edit format fields**

The superdoc-redlines library v0.2.0 uses a specific format. Validation will fail if you use the wrong fields.

| WRONG (will fail validation) | CORRECT (use this) |
|------------------------------|-------------------|
| `"type": "replace"` | `"operation": "replace"` |
| `"search": "old text", "replace": "new text"` | `"newText": "complete new text"` |
| `"text": "new text"` (for replace) | `"newText": "new text"` |

**Correct edit structure:**
```json
{
  "blockId": "b149",
  "operation": "replace",
  "newText": "[FULL REPLACEMENT TEXT]",
  "diff": true,
  "comment": "Explanation of change"
}
```

**NOT this (common mistake):**
```json
{
  "blockId": "b149",
  "type": "replace",
  "search": "old text here",
  "replace": "new text here"
}
```

### Singapore-Specific Learnings

#### TUPE Has No Singapore Equivalent

**Critical insight**: Singapore does not have automatic transfer of employment legislation equivalent to UK TUPE (Transfer of Undertakings (Protection of Employment) Regulations 2006).

**Approach for TUPE provisions:**
1. DELETE the TUPE definition block entirely
2. DELETE any TUPE-related operative clauses
3. RESTRUCTURE employee transfer provisions to use offer-and-acceptance model:
   - Seller terminates employees at Completion
   - Buyer offers employment to Transferring Employees on substantially similar terms
   - No automatic transfer - employees must accept new offers
4. Retain any employee list schedules but update headings

#### Singapore Statute Citation Format

**ALWAYS cite Singapore legislation by YEAR OF ENACTMENT, not chapter number.**

| Wrong | Correct |
|-------|---------|
| Companies Act (Cap. 50) | Companies Act 1967 |
| Employment Act (Cap. 91) | Employment Act 1968 |
| PDPA (Cap. 26) | Personal Data Protection Act 2012 |

**Full mapping of common UK → Singapore statutes:**

| UK Statute | Singapore Statute | Year |
|------------|-------------------|------|
| Companies Act 2006 | Companies Act | 1967 |
| Employment Rights Act 1996 | Employment Act | 1968 |
| Data Protection Act 2018 / UK GDPR | Personal Data Protection Act (PDPA) | 2012 |
| Insolvency Act 1986 | Insolvency, Restructuring and Dissolution Act (IRDA) | 2018 |
| Bribery Act 2010 | Prevention of Corruption Act (PCA) | 1960 |
| Competition Act 1998 | Competition Act | 2004 |
| Consumer Rights Act 2015 | Consumer Protection (Fair Trading) Act | 2003 |
| Contracts (Rights of Third Parties) Act 1999 | Contracts (Rights of Third Parties) Act | 2001 |
| Copyright, Designs and Patents Act 1988 | Copyright Act | 2021 |
| Value Added Tax Act 1994 | Goods and Services Tax Act | 1993 |

**Professional Bodies Mapping:**

| UK Body | Singapore Equivalent |
|---------|---------------------|
| ICAEW (Institute of Chartered Accountants in England and Wales) | ISCA (Institute of Singapore Chartered Accountants) |
| Institute and Faculty of Actuaries | Singapore Actuarial Society |
| Law Society of England and Wales | Law Society of Singapore |

### Validation Workflow

**ALWAYS validate edits before applying.**

```bash
# Step 1: Validate (catches format errors before they corrupt the document)
node superdoc-redline.mjs validate --input contract.docx --edits edits.json

# Step 2: Only if validation passes, apply
node superdoc-redline.mjs apply --input contract.docx --output amended.docx --edits edits.json
```

Validation catches:
- Invalid block IDs (block doesn't exist in document)
- Malformed edit operations
- Wrong field names (e.g., `type` instead of `operation`)
- Missing required fields

---

## Continuous Learning Process

After each contract review session, the agent (or human) should:

### 1. Document New Learnings

Create or update a learnings entry:

```markdown
### Session: [Date] - [Contract Type] - [Jurisdiction Conversion]

**What worked well:**
- [List successful approaches]

**What failed/required correction:**
- [List errors and their fixes]

**New mappings discovered:**
- [UK term/statute] → [Singapore equivalent]

**Edit format issues encountered:**
- [Any format validation failures and fixes]
```

### 2. Update This Skill Document

Add any new learnings to the appropriate sections:
- New jurisdiction mappings → "Singapore-Specific Learnings" section
- Format issues → "Edit File Format" section
- Workflow improvements → Appropriate workflow section

### 3. Create Jurisdiction-Specific Reference Files

For frequently used conversions, create reference files:

```
/reference/uk-to-singapore.md
/reference/uk-to-hong-kong.md
/reference/uk-to-australia.md
```

Each containing:
- Statute mapping table
- Regulatory body mapping
- Tax terminology mapping
- Employment law differences
- Professional body mapping

### 4. Update This Document Based on Errors

If the same error occurs repeatedly:
1. Identify the root cause
2. Add explicit guidance to the relevant section
3. Add a "Common Pitfalls" entry if not already covered

---

*Last updated: 4 February 2026*
