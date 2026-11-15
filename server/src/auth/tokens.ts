import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

export const ACCESS_TOKEN_SECONDS = 15 * 60;
export const REFRESH_TOKEN_DAYS = 30;
const ISSUER = "tradesim";

const key = (secret: string) => new TextEncoder().encode(secret);

/** A short-lived HS256 JWT whose subject is the user id. */
export function signAccessToken(userId: bigint, secret: string, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuer(ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ACCESS_TOKEN_SECONDS)
    .sign(key(secret));
}

/** Returns the user id, or null for a token that is malformed, forged, expired or from another issuer. */
export async function verifyAccessToken(token: string, secret: string, now = Date.now()): Promise<bigint | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      currentDate: new Date(now),
    });
    return payload.sub && /^\d+$/.test(payload.sub) ? BigInt(payload.sub) : null;
  } catch {
    return null;
  }
}

/** An opaque random token for the cookie, and the hash that is stored in its place. */
export function newRefreshToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
