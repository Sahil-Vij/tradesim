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
