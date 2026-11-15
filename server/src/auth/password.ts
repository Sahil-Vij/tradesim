import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// One of OWASP's recommended settings: 32 MiB and about 150 ms per hash on a laptop.
// The parameters are stored with each hash, so they can be raised later without breaking existing passwords.
const COST = { N: 2 ** 15, r: 8, p: 3 };
const KEY_LENGTH = 32;

function derive(password: string, salt: Buffer, { N, r, p }: typeof COST): Promise<Buffer> {
  // scrypt needs 128 * N * r bytes; Node's default limit is exactly that, so leave headroom.
  const options: ScryptOptions = { N, r, p, maxmem: 256 * N * r };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Returns `scrypt$N$r$p$salt$hash`, with salt and hash in base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await derive(password, Buffer.from(salt, "base64url"), { N: Number(N), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}
