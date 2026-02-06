import fp from "fastify-plugin";

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
    reply.status(statusCode).send({
      error: {
        code: error.code || "INTERNAL_ERROR",
        message: statusCode >= 500
          ? "An internal server error occurred"
          : error.message,
        details: [],
      },
    });
  });
}

export default fp(errorHandlerPlugin, { name: "error-handler" });
