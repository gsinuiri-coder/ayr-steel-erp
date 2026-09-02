import { z } from 'zod';

/**
 * Configuración por Zod (§3.1). La app no arranca si falta algo.
 * Se lee de process.env; en local `apps/api/.env` (generado por `pnpm env:local`).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  /** Orígenes permitidos para CORS, separados por coma. */
  WEB_ORIGIN: z.string().default('http://localhost:3001'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  /** Cookies `Secure`. Por defecto true en producción. */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /** Apaga el rate limit (solo E2E/CI). */
  THROTTLE_DISABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Habilita pg-boss. En tests se apaga. */
  JOBS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema> & {
  webOrigins: string[];
  cookieSecure: boolean;
  isProduction: boolean;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuración inválida: ${detail}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';
  return {
    ...env,
    isProduction,
    cookieSecure: env.COOKIE_SECURE ?? isProduction,
    webOrigins: env.WEB_ORIGIN.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export const ENV = Symbol('ENV');
