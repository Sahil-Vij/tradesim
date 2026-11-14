export type Config = {
  port: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a whole number from 0 to 65535, got "${env.PORT}"`);
  }
  return { port };
}

export function loadDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env to use the local database.");
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("DATABASE_URL must start with postgres://");
  return url;
}
