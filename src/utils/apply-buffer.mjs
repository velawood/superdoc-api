import {
  sortEditsForApplication,
  validateEditsAgainstIR,
  isTocBlock,
  detectTocStructure,
} from '../editApplicator.mjs';
import {
  replaceBlockById,
  deleteBlockById,
  insertAfterBlock,
  addCommentToBlock,
} from '../blockOperations.mjs';

const DEFAULT_AUTHOR = { name: 'API User', email: 'api@superdoc.com' };

/**
 * Apply already-validated edits to a loaded SuperDoc editor and export DOCX.
 *
 * This is the buffer-based equivalent of the file-path workflow in
 * `editApplicator.mjs`, intended for HTTP upload buffers.
 *
 * @param {Editor} editor - Loaded SuperDoc editor instance
 * @param {Array<Object>} edits - Edit operations (expected to be pre-validated)
 * @param {{ blocks: Array<{ id: string, seqId?: string }> }} ir - Document IR for block resolution/sorting
 * @param {{ author?: { name: string, email: string } }} [options] - Apply options
 * @returns {Promise<Buffer>} Exported uncompressed DOCX buffer
 */
export async function applyEditsToBuffer(editor, edits, ir, options = {}) {
  const author = options.author || DEFAULT_AUTHOR;
  const comments = [];

  // Defensive check: caller should validate before calling this utility.
  const validation = validateEditsAgainstIR(edits, ir);
  if (!validation.valid || validation.warnings.length > 0) {
    console.warn(
      `[applyEditsToBuffer] Received edits with ${validation.issues.length} issues and ${validation.warnings.length} warnings; applying best effort.`
    );
  }

  const sortedEdits = sortEditsForApplication(edits, ir);

  /**
   * Resolve seqId or UUID to UUID from IR.
   *
   * @param {string} blockId
   * @param {{ blocks: Array<{ id: string, seqId?: string }> }} irData
   * @returns {string|null}
   */
  function resolveBlockId(blockId, irData) {
    const bySeqId = irData.blocks.find((block) => block.seqId === blockId);
    if (bySeqId) {
      return bySeqId.id;
    }

    const byId = irData.blocks.find((block) => block.id === blockId);
    if (byId) {
      return byId.id;
    }

    return null;
  }

  for (const edit of sortedEdits) {
    try {
      switch (edit.operation) {
        case 'replace': {
          const resolvedId = resolveBlockId(edit.blockId, ir);
          if (!resolvedId) {
            console.warn(`[applyEditsToBuffer] Skipping replace; block not found: ${edit.blockId}`);
            continue;
          }

          const block = ir.blocks.find((item) => item.id === resolvedId || item.seqId === edit.blockId);
          const tocCheck = block ? detectTocStructure(block) : { isToc: false };
          if (block && (tocCheck.isToc || isTocBlock(block))) {
            const reason = tocCheck.reason || 'TOC block detected';
            console.warn(`[applyEditsToBuffer] Skipping TOC replace for ${edit.blockId}: ${reason}`);
            continue;
          }

          const replaceResult = await replaceBlockById(editor, resolvedId, edit.newText, {
            diff: edit.diff !== false,
            trackChanges: true,
            author,
            verbose: false,
          });

          if (!replaceResult.success) {
            console.warn(
              `[applyEditsToBuffer] Replace failed for ${edit.blockId}: ${replaceResult.error || 'unknown error'}`
            );
            continue;
          }

          if (edit.comment) {
            const commentResult = await addCommentToBlock(editor, resolvedId, edit.comment, author);
            if (commentResult.success) {
              comments.push({
                id: commentResult.commentId,
                blockId: resolvedId,
                text: edit.comment,
                author,
              });
            }
          }
          break;
        }

        case 'delete': {
          const resolvedId = resolveBlockId(edit.blockId, ir);
          if (!resolvedId) {
            console.warn(`[applyEditsToBuffer] Skipping delete; block not found: ${edit.blockId}`);
            continue;
          }

          const deleteResult = await deleteBlockById(editor, resolvedId, {
            trackChanges: true,
            author,
          });

          if (!deleteResult.success) {
            console.warn(
              `[applyEditsToBuffer] Delete failed for ${edit.blockId}: ${deleteResult.error || 'unknown error'}`
            );
          }
          break;
        }

        case 'insert': {
          const resolvedId = resolveBlockId(edit.afterBlockId, ir);
          if (!resolvedId) {
            console.warn(
              `[applyEditsToBuffer] Skipping insert; afterBlockId not found: ${edit.afterBlockId}`
            );
            continue;
          }

          const insertResult = await insertAfterBlock(editor, resolvedId, edit.text, {
            type: edit.type || 'paragraph',
            level: edit.level,
            trackChanges: true,
            author,
          });

          if (!insertResult.success) {
            console.warn(
              `[applyEditsToBuffer] Insert failed after ${edit.afterBlockId}: ${insertResult.error || 'unknown error'}`
            );
            continue;
          }

          if (edit.comment && insertResult.newBlockId) {
            const commentResult = await addCommentToBlock(editor, insertResult.newBlockId, edit.comment, author);
            if (commentResult.success) {
              comments.push({
                id: commentResult.commentId,
                blockId: insertResult.newBlockId,
                text: edit.comment,
                author,
              });
            }
          }
          break;
        }

        case 'comment': {
          const resolvedId = resolveBlockId(edit.blockId, ir);
          if (!resolvedId) {
            console.warn(`[applyEditsToBuffer] Skipping comment; block not found: ${edit.blockId}`);
            continue;
          }

          const commentResult = await addCommentToBlock(editor, resolvedId, edit.comment, author);
          if (commentResult.success) {
            comments.push({
              id: commentResult.commentId,
              blockId: resolvedId,
              text: edit.comment,
              author,
            });
          } else {
            console.warn(
              `[applyEditsToBuffer] Comment failed for ${edit.blockId}: ${commentResult.error || 'unknown error'}`
            );
          }
          break;
        }

        default: {
          console.warn(`[applyEditsToBuffer] Unknown operation, skipping: ${edit.operation}`);
        }
      }
    } catch (error) {
      const target = edit.blockId || edit.afterBlockId || 'unknown';
      console.warn(
        `[applyEditsToBuffer] Edit failed (${edit.operation}) for ${target}: ${error.message || String(error)}`
      );
    }
  }

  const exportOptions = {
    isFinalDoc: false,
    commentsType: 'external',
  };

  if (comments.length > 0) {
    exportOptions.comments = comments;
  }

  try {
    editor.commands.setTextSelection(1);
  } catch {
    // Ignore selection reset issues.
  }

  const originalWarn = console.warn;
  console.warn = (...args) => {
    const message = args[0]?.toString() || '';
    if (message.includes('TextSelection endpoint not pointing into a node with inline content')) {
      return;
    }
    originalWarn.apply(console, args);
  };

  try {
    const exportedBuffer = await editor.exportDocx(exportOptions);
    return Buffer.from(exportedBuffer);
  } finally {
    console.warn = originalWarn;
  }
}
