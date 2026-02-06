import { Open } from "unzipper";

const ZIP_MAGIC = Buffer.from([0x50, 0x4B, 0x03, 0x04]); // PK\x03\x04
const DEFAULT_MAX_RATIO = 100; // 100:1 decompressed:compressed
const DEFAULT_MAX_DECOMPRESSED = 500 * 1024 * 1024; // 500MB

/**
 * Validate that a buffer starts with ZIP magic bytes (PK\x03\x04).
 * DOCX files are ZIP archives, so they MUST start with this signature.
 *
 * @param {Buffer} buffer - The uploaded file buffer
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateMagicBytes(buffer) {
  if (buffer.length < 4) {
    return { valid: false, error: "File too small to be a valid DOCX" };
  }
  if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    return {
      valid: false,
      error: "Invalid file format: not a ZIP/DOCX file (bad magic bytes)",
    };
  }
  return { valid: true };
}

/**
 * Check for zip bomb by reading central directory metadata.
 * Does NOT decompress any data -- reads only entry headers.
 *
 * @param {Buffer} buffer - The uploaded file buffer (already validated as ZIP)
 * @param {object} [opts] - Options
 * @param {number} [opts.maxRatio=100] - Max allowed decompressed:compressed ratio
 * @param {number} [opts.maxDecompressedSize] - Absolute max decompressed size in bytes
 * @returns {Promise<{ safe: boolean, error?: string, ratio?: number, totalUncompressed?: number }>}
 */
export async function checkZipBomb(buffer, opts = {}) {
  const maxRatio = opts.maxRatio || DEFAULT_MAX_RATIO;
  const maxDecompressed = opts.maxDecompressedSize || DEFAULT_MAX_DECOMPRESSED;

  let directory;
  try {
    directory = await Open.buffer(buffer);
  } catch (err) {
    return {
      safe: false,
      error: "Corrupted or invalid ZIP/DOCX file",
    };
  }

  let totalUncompressed = 0;
  for (const file of directory.files) {
    totalUncompressed += file.uncompressedSize || 0;
  }

  const ratio = buffer.length > 0 ? totalUncompressed / buffer.length : 0;

  if (totalUncompressed > maxDecompressed) {
    return {
      safe: false,
      error: "Decompressed size exceeds maximum allowed",
      ratio,
      totalUncompressed,
    };
  }

  if (ratio > maxRatio) {
    return {
      safe: false,
      error: "Suspicious compression ratio detected",
      ratio,
      totalUncompressed,
    };
  }

  return { safe: true, ratio, totalUncompressed };
}
