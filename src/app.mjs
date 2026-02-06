import Fastify from "fastify";
import crypto from "node:crypto";
import bearerAuth from "@fastify/bearer-auth";
import requestIdPlugin from "./plugins/request-id.mjs";
import errorHandlerPlugin from "./plugins/error-handler.mjs";
import multipartPlugin from "./plugins/multipart.mjs";
import healthRoutes from "./routes/health.mjs";
import readRoutes from "./routes/read.mjs";

/**
 * Build and return a configured Fastify application instance.
 *
 * Uses the app factory pattern for testability via fastify.inject().
 * Does NOT call listen() or ready() -- the caller is responsible for that.
 *
 * @param {object} [opts={}] - Configuration options
 * @param {boolean|object} [opts.logger] - Pino logger config or false to disable
 * @param {string} [opts.apiKey] - API key for Bearer auth (for testing; overrides API_KEY env var)
 * @returns {import("fastify").FastifyInstance} Configured Fastify instance
 */
export default function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger !== undefined
      ? opts.logger
      : { level: process.env.LOG_LEVEL || "info" },
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  // Register plugins
  app.register(requestIdPlugin);
  app.register(errorHandlerPlugin);
  app.register(multipartPlugin);

  // Health at root level (for infrastructure probes)
  app.register(healthRoutes);

  // Protected /v1 routes (Bearer auth required)
  app.register(async function protectedRoutes(scope) {
    const apiKey = opts.apiKey || process.env.API_KEY;

    if (!apiKey) {
      throw new Error("API_KEY environment variable is required");
    }

    await scope.register(bearerAuth, {
      keys: new Set([apiKey]),
      errorResponse: () => ({
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid or missing API key",
          details: [],
        },
      }),
    });

    scope.register(healthRoutes);
    scope.register(readRoutes);
  }, { prefix: "/v1" });

  return app;
}
