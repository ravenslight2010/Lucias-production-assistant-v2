import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import { clerkMiddleware } from "@clerk/express";

const previousDatabaseUrl = process.env.DATABASE_URL;
const previousClerkSecret = process.env.CLERK_SECRET_KEY;
const previousPoolMax = process.env.DB_POOL_MAX;

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.DB_POOL_MAX ??= "1";
delete process.env.CLERK_SECRET_KEY;

const { createHealthRouter } = await import("../dist/routes/health.mjs");

if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = previousDatabaseUrl;
if (previousClerkSecret === undefined) delete process.env.CLERK_SECRET_KEY;
else process.env.CLERK_SECRET_KEY = previousClerkSecret;
if (previousPoolMax === undefined) delete process.env.DB_POOL_MAX;
else process.env.DB_POOL_MAX = previousPoolMax;

async function requestHealth(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fetch(`http://127.0.0.1:${port}/api/healthz`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("healthz before Clerk stays reachable without a secret key", async () => {
  const app = express();
  app.use("/api", createHealthRouter({
    getWorkerAvailability: () => "available",
    async checkDatabase() {},
  }));
  app.use(clerkMiddleware());

  const response = await requestHealth(app);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    api: "ok",
    database: "ok",
    worker: "available",
  });
});

test("healthz after Clerk fails closed without a secret key", async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.log = { error() {}, info() {} };
    next();
  });
  app.use(clerkMiddleware());
  app.use("/api", createHealthRouter({
    getWorkerAvailability: () => "available",
    async checkDatabase() {},
  }));
  app.use((error, _req, res, _next) => {
    res.status(500).json({ error: "Request could not be completed." });
  });

  const response = await requestHealth(app);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Request could not be completed.",
  });
});
