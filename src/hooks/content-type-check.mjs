/**
 * Reusable preHandler hook for validating multipart/form-data Content-Type.
 *
 * Returns 400 with structured error if Content-Type is not multipart/form-data.
 * IMPORTANT: Must return reply after reply.send() to prevent Fastify from
 * continuing to the route handler (see Pitfall 6 in research).
 *
 * Usage: Attach to upload route handlers via preHandler option.
 * Will be used in Phase 3+ upload endpoints.
 *
 * @param {import("fastify").FastifyRequest} request
 * @param {import("fastify").FastifyReply} reply
 */
export async function requireMultipart(request, reply) {
  const contentType = request.headers["content-type"];

  if (!contentType || !contentType.startsWith("multipart/form-data")) {
    reply.status(400).send({
      error: {
        code: "INVALID_CONTENT_TYPE",
        message: "Content-Type must be multipart/form-data",
        details: [],
      },
    });
    return reply;
  }
}
