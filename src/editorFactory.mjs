/**
 * Editor Factory for creating headless SuperDoc editor instances.
 *
 * These editors can be used in Node.js environments for programmatic
 * document manipulation without a browser DOM.
 */
import { Editor, getStarterExtensions } from '@harbour-enterprises/superdoc/super-editor';
import { JSDOM } from 'jsdom';
import { readFile } from 'fs/promises';

/**
 * Create a headless SuperDoc editor instance from a buffer.
 *
 * @param {Buffer} buffer - DOCX file buffer
 * @param {EditorOptions} options - Configuration options
 * @returns {Promise<HeadlessEditorResult>}
 *
 * @typedef {Object} EditorOptions
 * @property {'editing'|'suggesting'} documentMode - Edit mode (default: 'editing')
 * @property {Author} user - Author info for track changes
 *
 * @typedef {Object} Author
 * @property {string} name - Author name
 * @property {string} email - Author email
 *
 * @typedef {Object} HeadlessEditorResult
 * @property {Editor} editor - SuperDoc editor instance
 * @property {CleanupFn} cleanup - Idempotent cleanup function that destroys the editor
 *   and asynchronously closes the JSDOM window via setImmediate()
 *
 * @typedef {() => void} CleanupFn
 */
export async function createHeadlessEditor(buffer, options = {}) {
  const {
    documentMode = 'editing',
    user = { name: 'AI Assistant', email: 'ai@example.com' }
  } = options;

  // Create a virtual DOM environment for SuperDoc
  const { window } = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const { document } = window;

  let editor;
  try {
    // Load DOCX content using SuperDoc's static method
    const [content, media, mediaFiles, fonts] = await Editor.loadXmlData(buffer, true);

    // Create the editor instance
    editor = new Editor({
      mode: 'docx',
      documentMode: documentMode,
      documentId: 'doc-' + Date.now(),
      element: document.createElement('div'),
      extensions: getStarterExtensions(),
      fileSource: buffer,
      content,
      media,
      mediaFiles,
      fonts,
      isHeadless: true,
      document: document,
      user: user,
    });
  } catch (error) {
    try {
      window.close();
    } catch (closeError) {
      // No-op: window may already be closed
    }
    throw error;
  }

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    try {
      editor.destroy();
    } catch (destroyError) {
      // No-op: editor may already be destroyed
    }

    // Defer window close to avoid JSDOM retention issues.
    setImmediate(() => {
      try {
        window.close();
      } catch (closeError) {
        // No-op: window may already be closed
      }
    });
  };

  return { editor, cleanup };
}

/**
 * Create editor from file path.
 *
 * @param {string} filePath - Path to DOCX file
 * @param {EditorOptions} options - Configuration options
 * @returns {Promise<HeadlessEditorResult>}
 */
export async function createEditorFromFile(filePath, options = {}) {
  const buffer = await readFile(filePath);
  return createHeadlessEditor(buffer, options);
}

/**
 * Create editor in suggesting mode (track changes enabled).
 *
 * @param {string} filePath - Path to DOCX file
 * @param {Author} user - Author info for track changes
 * @returns {Promise<HeadlessEditorResult>}
 */
export async function createSuggestingEditor(filePath, user) {
  return createEditorFromFile(filePath, {
    documentMode: 'suggesting',
    user: user || { name: 'AI Assistant', email: 'ai@example.com' }
  });
}
