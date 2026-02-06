import bearerAuth from "@fastify/bearer-auth";

/**
 * Bearer token authentication plugin for protected routes.
 *
 * Validates Bearer token against API_KEY from environment or opts.apiKey.
 * Intentionally NOT wrapped with fastify-plugin to maintain route scope.
 * Must be registered within a specific route scope (e.g., /v1 prefix).
 *
 * @param {import("fastify").FastifyInstance} fastify
 * @param {object} opts
 * @param {string} [opts.apiKey] - API key for testing (overrides env var)
 * @throws {Error} If neither opts.apiKey nor API_KEY env var is set
 */
async function authPlugin(fastify, opts) {
  const apiKey = opts.apiKey || process.env.API_KEY;

  if (!apiKey) {
    throw new Error("API_KEY environment variable is required");
  }

  await fastify.register(bearerAuth, {
    keys: new Set([apiKey]),
    errorResponse: () => ({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid or missing API key",
        details: [],
      },
    }),
  });
}

export default authPlugin;
