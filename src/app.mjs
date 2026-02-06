import Fastify from "fastify";
import crypto from "node:crypto";
import requestIdPlugin from "./plugins/request-id.mjs";
import errorHandlerPlugin from "./plugins/error-handler.mjs";
import healthRoutes from "./routes/health.mjs";

/**
 * Build and return a configured Fastify application instance.
 *
 * Uses the app factory pattern for testability via fastify.inject().
 * Does NOT call listen() or ready() -- the caller is responsible for that.
 *
 * @param {object} [opts={}] - Configuration options
 * @param {boolean|object} [opts.logger] - Pino logger config or false to disable
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

  // Health at root level (for infrastructure probes)
  app.register(healthRoutes);

  // Health under /v1 (for API consistency)
  app.register(healthRoutes, { prefix: "/v1" });

  return app;
}
