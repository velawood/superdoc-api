import fp from "fastify-plugin";
import multipart from "@fastify/multipart";

const DEFAULT_FILE_SIZE_LIMIT = 50 * 1024 * 1024; // 50MB

/**
 * Multipart file upload plugin with size limits.
 *
 * Registers @fastify/multipart with:
 * - 50MB default file size limit (configurable via MAX_FILE_SIZE env var)
 * - Automatic 413 errors when limit exceeded (throwFileSizeLimit: true by default)
 * - 1 file per request
 *
 * Wrapped with fastify-plugin to make it globally available (non-encapsulated).
 * Unlike the auth plugin (which is route-scoped), multipart parsing must be
 * available to all upload routes.
 *
 * @param {import("fastify").FastifyInstance} fastify
 * @param {object} opts
 */
async function multipartPlugin(fastify, opts) {
  const fileSizeLimit = parseInt(
    process.env.MAX_FILE_SIZE || String(DEFAULT_FILE_SIZE_LIMIT),
    10
  );

  await fastify.register(multipart, {
    limits: {
      fileSize: fileSizeLimit,
      files: 1,
      fields: 10,
      headerPairs: 100,
    },
    // throwFileSizeLimit defaults to true -- automatically throws
    // RequestFileTooLargeError (413) when fileSize exceeded
  });
}

export default fp(multipartPlugin, { name: "multipart" });
