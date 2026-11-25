export interface Config {
  databaseUrl?: string;
  sessionSecret: string;
  masterKey: Buffer;
  anthropicApiKey?: string;
  port: number;
  produccion: boolean;
}

export function leerConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const produccion = env.NODE_ENV === "production";
  const sessionSecret = env.SESSION_SECRET || (produccion ? "" : "desarrollo-no-usar-en-produccion");
  if (!sessionSecret) throw new Error("Falta SESSION_SECRET");
  const mk = env.MASTER_KEY ? Buffer.from(env.MASTER_KEY, "base64") : produccion ? Buffer.alloc(0) : Buffer.alloc(32, 7);
  if (mk.length !== 32) throw new Error("MASTER_KEY tiene que ser 32 bytes en base64");
  return {
    databaseUrl: env.DATABASE_URL,
    sessionSecret,
    masterKey: mk,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    port: Number(env.PORT) || 3000,
    produccion,
  };
}
