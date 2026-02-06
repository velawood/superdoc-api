/**
 * Health check route plugin.
 *
 * Registers GET /health returning { status: "ok" }.
 * No dependency on SuperDoc, JSDOM, or any domain modules.
 *
 * @param {import("fastify").FastifyInstance} fastify
 * @param {object} opts
 */
async function healthRoutes(fastify, opts) {
  fastify.get("/health", async (request, reply) => {
    return { status: "ok" };
  });
}

export default healthRoutes;
