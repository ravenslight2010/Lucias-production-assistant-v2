import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";

const previousDatabaseUrl = process.env.DATABASE_URL;
const previousPoolMax = process.env.DB_POOL_MAX;
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.DB_POOL_MAX ??= "1";
const { createHealthRouter } = await import("../dist/routes/health.mjs");
if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = previousDatabaseUrl;
if (previousPoolMax === undefined) delete process.env.DB_POOL_MAX;
else process.env.DB_POOL_MAX = previousPoolMax;

async function requestHealth(worker) {
  const app = express();
  app.use((req, _res, next) => {
    req.log = { error() {}, info() {} };
    next();
  });
  app.use(createHealthRouter({
    getWorkerAvailability: () => worker,
    async checkDatabase() {
      throw new Error("database connection failed; pid=1234; password=secret");
    },
  }));

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fetch(`http://127.0.0.1:${port}/healthz`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("database failures report degraded health without hiding worker availability", async (t) => {
  for (const worker of ["available", "restarting"]) {
    await t.test(`preserves worker status ${worker}`, async () => {
      const response = await requestHealth(worker);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        status: "degraded",
        api: "ok",
        database: "degraded",
        worker,
      });
    });
  }
});
