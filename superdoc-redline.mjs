#!/usr/bin/env node

/**
 * superdoc-redline.mjs v0.2.0
 *
 * Structured document operations for AI agents.
 * Uses ID-based block editing for deterministic, position-independent edits.
 *
 * Commands:
 *   extract  - Extract structured intermediate representation from DOCX
 *   read     - Read document for LLM consumption (with automatic chunking)
 *   validate - Validate edit instructions against a document
 *   apply    - Apply ID-based edits to a document
 *   merge    - Merge edit files from multiple sub-agents
 *
 * Usage:
 *   node superdoc-redline.mjs extract --input doc.docx --output ir.json
 *   node superdoc-redline.mjs read --input doc.docx [--chunk N]
 *   node superdoc-redline.mjs validate --input doc.docx --edits edits.json
 *   node superdoc-redline.mjs apply --input doc.docx --output out.docx --edits edits.json
 *   node superdoc-redline.mjs merge edits1.json edits2.json --output merged.json
 */

import { program } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

import { extractDocumentIR } from './src/irExtractor.mjs';
import { readDocument, getDocumentStats } from './src/documentReader.mjs';
import { applyEdits, validateEdits } from './src/editApplicator.mjs';
import { mergeEditFiles, validateMergedEdits } from './src/editMerge.mjs';

/**
 * Parse integer argument for Commander.js options.
 * Commander passes (value, previousValue) to parsers, but parseInt expects (string, radix).
 * Using parseInt directly causes bugs when a default value exists (previousValue becomes radix).
 * @param {string} value - The CLI argument value
 * @returns {number}
 */
const parseIntArg = (value) => {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
};

program
  .name('superdoc-redline')
  .description('Structured document operations for AI agents')
  .version('0.2.0');

// ============================================================================
// Command: extract
// ============================================================================

program
  .command('extract')
  .description('Extract structured intermediate representation from a DOCX file')
  .requiredOption('-i, --input <path>', 'Input DOCX file')
  .option('-o, --output <path>', 'Output JSON file (default: <input>-ir.json)')
  .option('-f, --format <type>', 'Output format: full|outline|blocks', 'full')
  .option('--no-defined-terms', 'Exclude defined terms extraction')
  .option('--max-text <length>', 'Truncate block text to length', parseIntArg)
  .action(async (options) => {
    try {
      const inputPath = resolve(options.input);
      const outputPath = options.output
        ? resolve(options.output)
        : inputPath.replace('.docx', '-ir.json');

      console.log(`Extracting IR from: ${inputPath}`);

      const ir = await extractDocumentIR(inputPath, {
        format: options.format,
        includeDefinedTerms: options.definedTerms !== false,
        maxTextLength: options.maxText || null
      });

      await writeFile(outputPath, JSON.stringify(ir, null, 2));

      console.log(`\nExtraction complete:`);
      console.log(`  Blocks: ${ir.blocks.length}`);
      console.log(`  Format: ${ir.metadata.format}`);
      if (ir.outline) {
        console.log(`  Outline items: ${countOutlineItems(ir.outline)}`);
      }
      if (ir.definedTerms) {
        console.log(`  Defined terms: ${Object.keys(ir.definedTerms).length}`);
      }
      console.log(`  Output: ${outputPath}`);

    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// ============================================================================
// Command: read
// ============================================================================

program
  .command('read')
  .description('Read document for LLM consumption (with automatic chunking)')
  .requiredOption('-i, --input <path>', 'Input DOCX file')
  .option('-c, --chunk <index>', 'Specific chunk index (0-indexed)', parseIntArg)
  .option('--max-tokens <count>', 'Max tokens per chunk', parseIntArg, 100000)
  .option('-f, --format <type>', 'Output format: full|outline|summary', 'full')
  .option('--stats-only', 'Only show document statistics')
  .option('--no-metadata', 'Exclude block IDs and positions from output')
  .action(async (options) => {
    try {
      const inputPath = resolve(options.input);

      if (options.statsOnly) {
        const stats = await getDocumentStats(inputPath);
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      const result = await readDocument(inputPath, {
        chunkIndex: options.chunk ?? null,
        maxTokens: options.maxTokens,
        format: options.format,
        includeMetadata: options.metadata !== false
      });

      if (!result.success) {
        console.error('Error:', result.error);
        process.exit(1);
      }

      // Output as JSON for LLM consumption
      console.log(JSON.stringify(result, null, 2));

    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// ============================================================================
// Command: validate
// ============================================================================

program
  .command('validate')
  .description('Validate edit instructions against a document')
  .requiredOption('-i, --input <path>', 'Input DOCX file')
  .requiredOption('-e, --edits <path>', 'Edits JSON file')
  .action(async (options) => {
    try {
      const inputPath = resolve(options.input);
      const editsPath = resolve(options.edits);

      const editsJson = await readFile(editsPath, 'utf-8');
      const edits = JSON.parse(editsJson);

      const result = await validateEdits(inputPath, edits);

      console.log(JSON.stringify(result, null, 2));

      if (!result.valid) {
        process.exit(1);
      }

    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// ============================================================================
// Command: apply
// ============================================================================

program
  .command('apply')
  .description('Apply ID-based edits to a document')
  .requiredOption('-i, --input <path>', 'Input DOCX file')
  .requiredOption('-o, --output <path>', 'Output DOCX file')
  .requiredOption('-e, --edits <path>', 'Edits JSON file')
  .option('--author-name <name>', 'Author name for track changes', 'AI Assistant')
  .option('--author-email <email>', 'Author email', 'ai@example.com')
  .option('--no-track-changes', 'Disable track changes mode')
  .option('--no-validate', 'Skip validation before applying')
  .option('--no-sort', 'Skip automatic edit sorting')
  .action(async (options) => {
    try {
      const inputPath = resolve(options.input);
      const outputPath = resolve(options.output);
      const editsPath = resolve(options.edits);

      const editsJson = await readFile(editsPath, 'utf-8');
      const editConfig = JSON.parse(editsJson);

      console.log(`Loading document: ${inputPath}`);
      console.log(`Applying ${editConfig.edits.length} edit(s)...`);

      const result = await applyEdits(inputPath, outputPath, editConfig, {
        trackChanges: options.trackChanges !== false,
        validateFirst: options.validate !== false,
        sortEdits: options.sort !== false,
        author: {
          name: options.authorName,
          email: options.authorEmail
        }
      });

      console.log(`\nResults:`);
      console.log(`  Applied: ${result.applied}`);
      console.log(`  Skipped: ${result.skipped.length}`);

      if (result.skipped.length > 0) {
        console.log(`\nSkipped edits:`);
        for (const skip of result.skipped) {
          console.log(`  [${skip.index}] ${skip.blockId} - ${skip.reason}`);
        }
      }

      if (result.comments && result.comments.length > 0) {
        console.log(`\nComments added: ${result.comments.length}`);
      }

      console.log(`\nOutput: ${outputPath}`);

      // Exit with error if any edits were skipped
      if (result.skipped.length > 0) {
        process.exit(1);
      }

    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// ============================================================================
// Command: merge
// ============================================================================

program
  .command('merge')
  .description('Merge edit files from multiple sub-agents')
  .requiredOption('-o, --output <path>', 'Output merged edits file')
  .option('-c, --conflict <strategy>', 'Conflict strategy: error|first|last|combine', 'error')
  .option('-v, --validate <docx>', 'Validate merged edits against document')
  .argument('<files...>', 'Edit files to merge')
  .action(async (files, options) => {
    try {
      const editPaths = files.map(f => resolve(f));

      console.log(`Merging ${editPaths.length} edit file(s)...`);

      const result = await mergeEditFiles(editPaths, {
        conflictStrategy: options.conflict,
        outputPath: resolve(options.output)
      });

      if (!result.success) {
        console.error('Merge failed:', result.error);
        if (result.conflicts && result.conflicts.length > 0) {
          console.log('\nConflicts:');
          for (const conflict of result.conflicts) {
            console.log(`  Block ${conflict.blockId}: ${conflict.edits.length} conflicting edits`);
          }
        }
        process.exit(1);
      }

      console.log(`\nMerge complete:`);
      console.log(`  Total edits: ${result.stats.totalEdits}`);
      console.log(`  Source files: ${result.stats.sourceFiles}`);
      if (result.stats.conflictsDetected > 0) {
        console.log(`  Conflicts resolved: ${result.stats.conflictsDetected}`);
      }
      console.log(`  Output: ${options.output}`);

      // Optional validation against document
      if (options.validate) {
        console.log(`\nValidating against: ${options.validate}`);

        const ir = await extractDocumentIR(resolve(options.validate));
        const validation = validateMergedEdits(result.merged, ir);

        if (!validation.valid) {
          console.log('\nValidation issues:');
          for (const issue of validation.issues) {
            console.log(`  [${issue.editIndex}] ${issue.type}: ${issue.message}`);
          }
          process.exit(1);
        }

        console.log('Validation: PASSED');
      }

    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Count total outline items including nested children.
 * @param {OutlineItem[]} outline - Outline array
 * @returns {number}
 */
function countOutlineItems(outline) {
  if (!outline) return 0;
  let count = 0;
  for (const item of outline) {
    count++;
    if (item.children) {
      count += countOutlineItems(item.children);
    }
  }
  return count;
}

// Parse and run
program.parse();
