import archiver from 'archiver';
import { Readable } from 'stream';
import { Open } from 'unzipper';

/**
 * Recompress a DOCX buffer fully in memory.
 *
 * SuperDoc exports DOCX files with little/no compression. This utility reads
 * all ZIP entries from the input buffer and re-packs them using ZIP level 9
 * compression, which typically reduces output size significantly.
 *
 * @param {Buffer} docxBuffer - Uncompressed DOCX buffer
 * @returns {Promise<Buffer>} Recompressed DOCX buffer
 * @throws {Error} If extraction or recompression fails
 */
export async function recompressDocxBuffer(docxBuffer) {
  if (!Buffer.isBuffer(docxBuffer)) {
    throw new TypeError('recompressDocxBuffer expects a Buffer input');
  }

  let directory;
  try {
    directory = await Open.buffer(docxBuffer);
  } catch (error) {
    throw new Error(`Failed to extract DOCX buffer: ${error.message}`);
  }

  const files = new Map();
  try {
    for (const entry of directory.files) {
      if (entry.type === 'Directory') {
        continue;
      }

      files.set(entry.path, await entry.buffer());
    }
  } catch (error) {
    throw new Error(`Failed to read DOCX ZIP entries: ${error.message}`);
  }

  try {
    return await new Promise((resolve, reject) => {
      /** @type {Buffer[]} */
      const chunks = [];
      const archive = archiver('zip', { zlib: { level: 9 } });

      archive.on('error', reject);
      archive.on('data', (chunk) => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));

      for (const [path, content] of files) {
        archive.append(Readable.from(content), { name: path });
      }

      archive.finalize();
    });
  } catch (error) {
    throw new Error(`Failed to recompress DOCX buffer: ${error.message}`);
  }
}
