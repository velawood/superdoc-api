import { Sema } from "async-sema";
import fp from "fastify-plugin";

/**
 * Fastify plugin that caps concurrent document processing.
 *
 * @param {import("fastify").FastifyInstance} fastify
 * @param {{ maxConcurrency?: number }} opts
 */
async function concurrencyLimiterPlugin(fastify, opts = {}) {
  const envMax = Number.parseInt(process.env.MAX_DOCUMENT_CONCURRENCY || "", 10);
  const configuredMax = Number.isInteger(opts.maxConcurrency) && opts.maxConcurrency > 0
    ? opts.maxConcurrency
    : (Number.isInteger(envMax) && envMax > 0 ? envMax : 4);

  const semaphore = new Sema(configuredMax);
  fastify.decorate("documentSemaphore", semaphore);

  fastify.log.info(
    { maxConcurrency: configuredMax },
    "Document concurrency limiter initialized"
  );
}

export default fp(concurrencyLimiterPlugin, {
  name: "concurrency-limiter",
});
