import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

let server: Server;
let base: string;
// These routes never touch the database, so the pool is never connected.
const pool = new pg.Pool();
const JWT_SECRET = "x".repeat(32);

before(async () => {
  server = createApp({ pool, jwtSecret: JWT_SECRET, secureCookies: false }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("health check reports ok", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("unknown API routes return JSON 404", async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("malformed JSON is a 400, not a 500", async () => {
  const res = await fetch(`${base}/api/health`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "bad_request" });
});

test("the server does not announce Express", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.headers.get("x-powered-by"), null);
});

test("PORT defaults to 4000 and rejects nonsense", () => {
  assert.equal(loadConfig({ JWT_SECRET }).port, 4000);
  assert.equal(loadConfig({ JWT_SECRET, PORT: "5050" }).port, 5050);
  assert.throws(() => loadConfig({ JWT_SECRET, PORT: "abc" }), /PORT/);
  assert.throws(() => loadConfig({ JWT_SECRET, PORT: "70000" }), /PORT/);
});

test("JWT_SECRET is required and must be long enough", () => {
  assert.throws(() => loadConfig({}), /JWT_SECRET/);
  assert.throws(() => loadConfig({ JWT_SECRET: "short" }), /JWT_SECRET/);
  assert.equal(loadConfig({ JWT_SECRET }).secureCookies, false);
  assert.equal(loadConfig({ JWT_SECRET, NODE_ENV: "production" }).secureCookies, true);
});
