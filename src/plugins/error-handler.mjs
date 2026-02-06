import fp from "fastify-plugin";

/**
 * Check if error message is safe to expose to clients.
 *
 * Returns false if message contains:
 * - File paths (src/, node_modules/, dist/, home/, Users/)
 * - Stack traces (at function())
 * - File extensions (.mjs:, .js:, .ts:, .cjs:)
 *
 * @param {string} msg - Error message to check
 * @returns {boolean} True if safe to expose, false otherwise
 */
function isSafeMessage(msg) {
  if (!msg || typeof msg !== "string") {
    return false;
  }

  // Check for file path patterns
  if (/\/(src|node_modules|dist|home|Users)\//i.test(msg)) {
    return false;
  }

  // Check for stack trace patterns
  if (/at\s+\w+\s+\(/i.test(msg)) {
    return false;
  }

  // Check for file extension patterns
  if (/\.(mjs|js|ts|cjs):/i.test(msg)) {
    return false;
  }

  return true;
}

/**
 * Error handler plugin - structured JSON error responses.
 *
 * Configures both setNotFoundHandler (404) and setErrorHandler (all other errors)
 * to produce consistent error JSON: { error: { code, message, details } }.
 *
 * Wrapped with fastify-plugin to skip encapsulation (handlers apply globally).
 *
 * @param {import("fastify").FastifyInstance} fastify
 * @param {object} opts
 */
async function errorHandlerPlugin(fastify, opts) {
  // Handle 404 - unknown routes
  fastify.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: `Route ${request.method} ${request.url} not found`,
        details: [],
      },
    });
  });

  // Handle all other errors
  fastify.setErrorHandler((error, request, reply) => {
    request.log.error(error);

    // Fastify validation errors have error.validation array
    if (error.validation) {
      reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: error.message,
          details: error.validation.map((v) => ({
            field: v.instancePath || v.params?.missingProperty || "unknown",
            message: v.message,
          })),
        },
      });
      return;
    }

    // Use error.statusCode if set, otherwise 500
    const statusCode = error.statusCode || 500;

    // Determine safe error message
    let message;
    if (statusCode >= 500) {
      message = "An internal server error occurred";
    } else if (isSafeMessage(error.message)) {
      message = error.message;
    } else {
      message = "Bad request";
    }

    reply.status(statusCode).send({
      error: {
        code: error.code || (statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST"),
        message,
        details: [],
      },
    });
  });
}

export default fp(errorHandlerPlugin, { name: "error-handler" });
