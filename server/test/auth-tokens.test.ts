import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT } from "jose";
import { hashPassword, verifyPassword } from "../src/auth/password.ts";
import {
  ACCESS_TOKEN_SECONDS,
  hashRefreshToken,
  newRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from "../src/auth/tokens.ts";

const SECRET = "s".repeat(32);

test("a password verifies against its own hash and nothing else", async () => {
  const hash = await hashPassword("correct horse");
  assert.match(hash, /^scrypt\$32768\$8\$3\$[\w-]{22}\$[\w-]{43}$/);
  assert.equal(await verifyPassword("correct horse", hash), true);
  assert.equal(await verifyPassword("correct horsf", hash), false);
  assert.equal(await verifyPassword("correct horse", "not-a-hash"), false);
});

test("the same password hashes differently each time", async () => {
  assert.notEqual(await hashPassword("same"), await hashPassword("same"));
});

test("unicode passwords are normalised before hashing", async () => {
  // "é" as one code point, and as "e" plus a combining accent, look identical when typed.
  const hash = await hashPassword("café-latte");
  assert.equal(await verifyPassword("café-latte", hash), true);
});

test("an access token round-trips to its user id until it expires", async () => {
  const now = Date.UTC(2026, 10, 15);
  const token = await signAccessToken(42n, SECRET, now);
  assert.equal(await verifyAccessToken(token, SECRET, now), 42n);
  assert.equal(await verifyAccessToken(token, SECRET, now + (ACCESS_TOKEN_SECONDS - 1) * 1000), 42n);
  assert.equal(await verifyAccessToken(token, SECRET, now + (ACCESS_TOKEN_SECONDS + 1) * 1000), null);
});

test("forged, tampered and foreign tokens are rejected", async () => {
  const token = await signAccessToken(1n, SECRET);
  assert.equal(await verifyAccessToken(token, "t".repeat(32)), null);
  const [header, payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
  const raised = Buffer.from(JSON.stringify({ ...claims, sub: "2" }));
  assert.equal(await verifyAccessToken(`${header}.${raised.toString("base64url")}.${signature}`, SECRET), null);
  // alg "none" must never be accepted.
  const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${payload}.`;
  assert.equal(await verifyAccessToken(none, SECRET), null);
  const otherIssuer = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("1")
    .setIssuer("someone-else")
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));
  assert.equal(await verifyAccessToken(otherIssuer, SECRET), null);
  assert.equal(await verifyAccessToken("garbage", SECRET), null);
});

test("refresh tokens are random and only their hash is kept", () => {
  const a = newRefreshToken();
  const b = newRefreshToken();
  assert.notEqual(a.token, b.token);
  assert.equal(a.token.length, 43);
  assert.deepEqual(a.hash, hashRefreshToken(a.token));
});
