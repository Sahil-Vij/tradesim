export type Config = {
  port: number;
  jwtSecret: string;
  secureCookies: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a whole number from 0 to 65535, got "${env.PORT}"`);
  }
  const jwtSecret = env.JWT_SECRET ?? "";
  // HS256 is only as strong as its key; 32 random bytes is what `openssl rand -hex 32` gives.
  if (jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32");
  }
  return { port, jwtSecret, secureCookies: env.NODE_ENV === "production" };
}

export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env to use the local database.");
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("DATABASE_URL must start with postgres://");
  return url;
}

export function loadRedisUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set. Copy .env.example to .env to use the local Redis.");
  if (!/^rediss?:\/\//.test(url)) throw new Error("REDIS_URL must start with redis:// or rediss://");
  return url;
}
