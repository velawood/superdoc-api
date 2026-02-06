import fp from "fastify-plugin";

/**
 * Request ID plugin - echoes X-Request-Id in every response.
 *
 * Fastify reads the incoming X-Request-Id header (via requestIdHeader option)
 * or generates a UUID (via genReqId option). This plugin copies request.id
 * to the X-Request-Id response header on every response.
 *
 * Wrapped with fastify-plugin to skip encapsulation (hook applies globally).
 *
 * @param {import("fastify").FastifyInstance} fastify
 * @param {object} opts
 */
async function requestIdPlugin(fastify, opts) {
  fastify.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Request-Id", request.id);
    return payload;
  });
}

export default fp(requestIdPlugin, { name: "request-id" });
