import { Router, type CookieOptions, type RequestHandler, type Response } from "express";
import type pg from "pg";
import { hashPassword, verifyPassword } from "./password.ts";
import { endSession, rotateSession, startSession } from "./sessions.ts";
import { REFRESH_TOKEN_DAYS, signAccessToken, verifyAccessToken } from "./tokens.ts";

export type AuthOptions = {
  pool: pg.Pool;
  jwtSecret: string;
  /** Send the refresh cookie over HTTPS only. On everywhere except local development. */
  secureCookies: boolean;
};

export const REFRESH_COOKIE = "tradesim_refresh";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 8;
// scrypt is slow by design; a cap stops someone posting a megabyte password to burn CPU.
const PASSWORD_MAX = 128;

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

type Credentials = { email: string; password: string } | { error: string };

function parseCredentials(body: unknown): Credentials {
  const { email, password } = (body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || email.length > 254 || !EMAIL.test(email.trim())) return { error: "invalid_email" };
  if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return { error: "invalid_password" };
  }
  return { email: email.trim().toLowerCase(), password };
}

export function createAuth({ pool, jwtSecret, secureCookies }: AuthOptions) {
  const cookie: CookieOptions = {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "strict",
    // The cookie is only sent to the auth endpoints, never with ordinary API calls.
    path: "/api/auth",
  };

  // Hashed once, so a login for an unknown email costs the same as one with a wrong password
  // and response times don't reveal which emails have accounts.
  const dummyHash = hashPassword("not-a-real-password");

  async function signIn(res: Response, status: number, user: { id: bigint; email: string }) {
    const refresh = await startSession(pool, user.id);
    res.cookie(REFRESH_COOKIE, refresh, { ...cookie, maxAge: REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000 });
    res.status(status).json({
      accessToken: await signAccessToken(user.id, jwtSecret),
      user: { id: String(user.id), email: user.email },
    });
  }

  const router = Router();

  router.post("/signup", async (req, res) => {
    const input = parseCredentials(req.body);
    if ("error" in input) {
      res.status(400).json({ error: input.error });
      return;
    }
    const { rows } = await pool.query<{ id: bigint; email: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING RETURNING id, email`,
      [input.email, await hashPassword(input.password)],
    );
    if (!rows[0]) {
      res.status(409).json({ error: "email_taken" });
      return;
    }
    await signIn(res, 201, rows[0]);
  });

  router.post("/login", async (req, res) => {
    const input = parseCredentials(req.body);
    // Same answer for a malformed and a wrong password, so the rules aren't a hint about the account.
    if ("error" in input) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    const { rows } = await pool.query<{ id: bigint; email: string; password_hash: string }>(
      "SELECT id, email, password_hash FROM users WHERE email = $1",
      [input.email],
    );
    const user = rows[0];
    const ok = await verifyPassword(input.password, user?.password_hash ?? (await dummyHash));
    if (!user || !ok) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    await signIn(res, 200, user);
  });

  router.post("/refresh", async (req, res) => {
    const token = readCookie(req.get("cookie"), REFRESH_COOKIE);
    const rotation = token ? await rotateSession(pool, token) : ({ error: "invalid" } as const);
    if ("error" in rotation) {
      res.clearCookie(REFRESH_COOKIE, cookie);
      res.status(401).json({ error: "invalid_refresh_token" });
      return;
    }
    res.cookie(REFRESH_COOKIE, rotation.token, { ...cookie, maxAge: REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000 });
    res.json({ accessToken: await signAccessToken(rotation.userId, jwtSecret) });
  });

  router.post("/logout", async (req, res) => {
    const token = readCookie(req.get("cookie"), REFRESH_COOKIE);
    if (token) await endSession(pool, token);
    res.clearCookie(REFRESH_COOKIE, cookie);
    res.status(204).end();
  });

  /** Lets a request through only with a valid access token, and puts the user id in `res.locals.userId`. */
  const requireAuth: RequestHandler = async (req, res, next) => {
    const match = /^Bearer (\S+)$/.exec(req.get("authorization") ?? "");
    const userId = match ? await verifyAccessToken(match[1]!, jwtSecret) : null;
    if (userId === null) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.locals.userId = userId;
    next();
  };

  return { router, requireAuth };
}
