import fp from "fastify-plugin";

/**
 * Fastify plugin that performs post-response editor cleanup.
 *
 * @param {import("fastify").FastifyInstance} fastify
 */
async function resourceCleanupPlugin(fastify) {
  fastify.addHook("onResponse", async (request) => {
    if (!request.editorCleanup) {
      return;
    }

    try {
      request.editorCleanup();
      request.log.debug("Editor cleanup completed");
    } catch (cleanupError) {
      request.log.warn({ err: cleanupError }, "Editor cleanup failed");
    }

    try {
      fastify.documentSemaphore.release();
      request.log.debug("Document semaphore released");
    } catch (releaseError) {
      request.log.warn({ err: releaseError }, "Failed to release document semaphore");
    }

    request.editorCleanup = null;
  });
}

export default fp(resourceCleanupPlugin, {
  name: "resource-cleanup",
  dependencies: ["concurrency-limiter"],
});
