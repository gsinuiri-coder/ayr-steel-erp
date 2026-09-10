import { DEFAULT_HISTORICAL_LOAD_START } from '@ayr/shared';
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
  /** Tipo de cambio SUNAT (D-029). Vacío = solo fallback manual (bloqueo B-02, ver PROGRESO.md). */
  APIS_NET_PE_TOKEN: z.string().default(''),
  /**
   * Base de apis.net.pe — el mismo proveedor para el padrón de RUC/DNI (D-067) y el tipo de
   * cambio SUNAT (D-029).
   *
   * Existe **para poder probarlo**. El padrón se consulta del lado del **API** (D-158: el
   * navegador manda el documento y nada más), así que un `page.route()` de Playwright no lo
   * intercepta: la petición no sale del navegador. Sin esta variable, el badge «Nuevo — se
   * creará desde padrón» era la única rama de D-158 que ningún E2E podía ejercitar, y estaba
   * anotado como tal en `import-cotizaciones-ui.spec.ts`.
   *
   * La suite la apunta a un stub local (`e2e/padron-stub.mjs`, tercer `webServer`), así que la
   * consulta es determinística y no gasta la cuota compartida del servicio real.
   *
   * **No es una entrada de usuario**: viaja por el entorno del proceso, igual que el token, y
   * nadie la puede fijar desde una petición.
   */
  APIS_NET_PE_BASE_URL: z.string().url().default('https://api.apis.net.pe'),
  /**
   * PSE de facturación electrónica (D-071). La URL identifica a la cuenta y con ella al
   * emisor, por eso no hay variables de RUC ni de razón social. Vacías = se ata
   * `NullInvoicingProvider` y toda emisión queda en contingencia (D-073), que es un
   * estado válido y no un fallo de arranque.
   *
   * **Nunca apuntar a producción de Nubefact desde un entorno de prueba**: un comprobante
   * aceptado por SUNAT no se borra, se da de baja.
   */
  NUBEFACT_URL: z.string().default(''),
  NUBEFACT_TOKEN: z.string().default(''),
  /**
   * Tolerancia de espesor del filtro de bobina de la OP de coberturas (D-086), en mm.
   * Vacío = la constante compartida (0.02 mm). Existe como variable y **no** como pantalla
   * a propósito: un número que la operación no cambia todos los días no necesita UI, y una
   * UI lo convierte en algo que se puede aflojar hasta que el filtro no filtre nada.
   */
  ROOFING_THICKNESS_TOLERANCE_MM: z
    .string()
    .default('')
    // Vacío = la constante compartida. Si viene, tiene que ser un número positivo y chico:
    // un valor no numérico reventaba en cada consulta del filtro con un 500 opaco, y uno
    // alto (`10`) lo anulaba en silencio — **fallando abierto**, que es lo peor que puede
    // hacer un control que existe para que no se role la bobina del calibre equivocado.
    .refine(
      (v) => v === '' || (/^\d+(\.\d+)?$/.test(v) && Number(v) > 0 && Number(v) <= 0.5),
      'ROOFING_THICKNESS_TOLERANCE_MM debe ser un número entre 0 y 0.5 mm, o quedar vacío',
    ),
  /**
   * D-124: piso de la carga histórica. Ninguna operación se puede retrofechar antes de esta
   * fecha. Es variable de entorno y no pantalla por el mismo motivo que
   * `ROOFING_THICKNESS_TOLERANCE_MM`: un tope que la operación no mueve todos los días no
   * necesita UI, y una UI lo convierte en algo que se afloja hasta que deja de topar nada.
   */
  HISTORICAL_LOAD_START: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'HISTORICAL_LOAD_START debe ser una fecha YYYY-MM-DD')
    .default(DEFAULT_HISTORICAL_LOAD_START),
  /** Storage R2 (D-007) para los archivos de `imports`. Vacío en entornos que no importan planillas. */
  R2_ACCOUNT_ID: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  R2_BUCKET: z.string().default(''),
  R2_ENDPOINT: z.string().default(''),
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
