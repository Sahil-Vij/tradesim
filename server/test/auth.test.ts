import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { createApp } from "../src/app.ts";
import { REFRESH_COOKIE } from "../src/auth/routes.ts";
import { migrate } from "../src/db/migrate.ts";
import { createTestPool, skipWithoutDb } from "./db.ts";
import { offlineRedis } from "./redis.ts";

describe("sign-up and login", { skip: skipWithoutDb }, () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;
  let server: Server;
  let base: string;

  before(async () => {
    ({ pool, drop } = await createTestPool());
    await migrate(pool);
    server = createApp({ pool, redis: offlineRedis(), jwtSecret: "j".repeat(32), secureCookies: false }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await drop();
  });

  const post = (path: string, body?: unknown, cookie?: string) =>
    fetch(`${base}/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  /** The `name=value` part of the refresh cookie a response set, to send back on the next request. */
  const refreshCookie = (res: Response) =>
    res.headers.getSetCookie().find((c) => c.startsWith(`${REFRESH_COOKIE}=`))?.split(";")[0];
  const me = (accessToken: string) => fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${accessToken}` } });

  test("signing up returns an access token, a user and a locked-down refresh cookie", async () => {
    const res = await post("signup", { email: "  Asha@Example.com ", password: "long enough" });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.user.email, "asha@example.com");
    assert.match(body.user.id, /^\d+$/);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${REFRESH_COOKIE}=`))!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/api\/auth/);
    assert.deepEqual(await (await me(body.accessToken)).json(), body.user);
  });

  test("the password is stored as a scrypt hash, never as given", async () => {
    await post("signup", { email: "hash@example.com", password: "plain text pw" });
    const { rows } = await pool.query("SELECT password_hash FROM users WHERE email = 'hash@example.com'");
    assert.match(rows[0].password_hash, /^scrypt\$/);
    assert.doesNotMatch(rows[0].password_hash, /plain text pw/);
  });

  test("an email can only sign up once, whatever its case", async () => {
    assert.equal((await post("signup", { email: "dup@example.com", password: "password1" })).status, 201);
    const res = await post("signup", { email: "DUP@example.com", password: "password2" });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "email_taken" });
  });

  test("sign-up checks the email and password", async () => {
    const cases: Array<[unknown, string]> = [
      [{ email: "no-at-sign", password: "password1" }, "invalid_email"],
      [{ email: 5, password: "password1" }, "invalid_email"],
      [{ password: "password1" }, "invalid_email"],
      [{ email: "a@example.com", password: "short" }, "invalid_password"],
      [{ email: "a@example.com", password: "x".repeat(129) }, "invalid_password"],
      [{ email: "a@example.com", password: 12345678 }, "invalid_password"],
    ];
    for (const [body, error] of cases) {
      const res = await post("signup", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { error });
    }
    assert.equal((await post("signup")).status, 400);
  });

  test("login works with the right password and gives one answer for everything else", async () => {
    await post("signup", { email: "login@example.com", password: "right password" });
    const ok = await post("login", { email: "LOGIN@example.com", password: "right password" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).user.email, "login@example.com");
    assert.ok(refreshCookie(ok));

    for (const body of [
      { email: "login@example.com", password: "wrong password" },
      { email: "nobody@example.com", password: "right password" },
      { email: "login@example.com", password: "short" },
    ]) {
      const res = await post("login", body);
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "invalid_credentials" });
    }
  });

  test("an unknown email takes about as long as a wrong password", async () => {
    await post("signup", { email: "timing@example.com", password: "right password" });
    const time = async (email: string) => {
      const start = performance.now();
      await post("login", { email, password: "wrong password" });
      return performance.now() - start;
    };
    await time("timing@example.com");
    const known = await time("timing@example.com");
    const unknown = await time("nobody-here@example.com");
    // Without the dummy hash an unknown email returns in about 1 ms against tens of ms for a real check.
    assert.ok(unknown > known / 3, `unknown ${unknown.toFixed(1)} ms vs known ${known.toFixed(1)} ms`);
  });

  test("refresh swaps the cookie for a new one and issues a working access token", async () => {
    const cookie = refreshCookie(await post("signup", { email: "refresh@example.com", password: "password1" }))!;
    const res = await post("refresh", undefined, cookie);
    assert.equal(res.status, 200);
    const next = refreshCookie(res)!;
    assert.notEqual(next, cookie);
    assert.equal((await me((await res.json()).accessToken)).status, 200);
    assert.equal((await post("refresh", undefined, next)).status, 200);
  });

  test("reusing a refresh token that was already swapped ends the whole session", async () => {
    const first = refreshCookie(await post("signup", { email: "stolen@example.com", password: "password1" }))!;
    const second = refreshCookie(await post("refresh", undefined, first))!;
    // Someone replays the old token: they're refused, and the real user's newer token stops working too.
    const replay = await post("refresh", undefined, first);
    assert.equal(replay.status, 401);
    assert.match(replay.headers.getSetCookie()[0]!, new RegExp(`^${REFRESH_COOKIE}=;`));
    assert.equal((await post("refresh", undefined, second)).status, 401);
  });

  test("two refreshes racing with one token: one wins, and the session is ended", async () => {
    const cookie = refreshCookie(await post("signup", { email: "race@example.com", password: "password1" }))!;
    const results = await Promise.all(Array.from({ length: 5 }, () => post("refresh", undefined, cookie)));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401, 401, 401, 401]);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS live FROM refresh_tokens t JOIN users u ON u.id = t.user_id
       WHERE u.email = 'race@example.com' AND t.revoked_at IS NULL`,
    );
    assert.equal(rows[0].live, 0);
  });

  test("refresh without a cookie, or with a made-up one, is refused", async () => {
    assert.equal((await post("refresh")).status, 401);
    assert.equal((await post("refresh", undefined, `${REFRESH_COOKIE}=made-up`)).status, 401);
  });

  test("an expired refresh token is refused", async () => {
    const cookie = refreshCookie(await post("signup", { email: "old@example.com", password: "password1" }))!;
    await pool.query(
      `UPDATE refresh_tokens SET expires_at = now() - interval '1 second'
       WHERE user_id = (SELECT id FROM users WHERE email = 'old@example.com')`,
    );
    assert.equal((await post("refresh", undefined, cookie)).status, 401);
  });

  test("logout ends the session and clears the cookie", async () => {
    const first = refreshCookie(await post("signup", { email: "bye@example.com", password: "password1" }))!;
    const second = refreshCookie(await post("refresh", undefined, first))!;
    const res = await post("logout", undefined, second);
    assert.equal(res.status, 204);
    assert.match(res.headers.getSetCookie()[0]!, new RegExp(`^${REFRESH_COOKIE}=;`));
    assert.equal((await post("refresh", undefined, second)).status, 401);
    assert.equal((await post("logout")).status, 204);
  });

  test("/api/me needs a valid bearer token", async () => {
    assert.equal((await fetch(`${base}/api/me`)).status, 401);
    assert.equal((await me("not-a-jwt")).status, 401);
    const res = await fetch(`${base}/api/me`, { headers: { authorization: "Basic abc" } });
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  test("refresh tokens are stored hashed", async () => {
    const cookie = refreshCookie(await post("signup", { email: "stored@example.com", password: "password1" }))!;
    const token = cookie.split("=")[1]!;
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM refresh_tokens WHERE token_hash = convert_to($1, 'UTF8')",
      [token],
    );
    assert.equal(rows[0].n, 0);
  });
});
