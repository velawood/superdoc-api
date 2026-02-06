import buildApp from "./app.mjs";

const app = buildApp();

try {
  await app.listen({
    port: parseInt(process.env.PORT || "3000", 10),
    host: "0.0.0.0",
  });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
