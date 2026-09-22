import { BusinessLineCode as PrismaLineCode } from '@prisma/client';
import { BusinessLine as SharedLineCode } from '@ayr/shared';

/**
 * Prisma expone el enum `BusinessLineCode` con sus nombres declarados en el schema
 * (`DRYWALL`, `METALLIC_ROOFING`...), no con el valor de `@map` (`drywall`,
 * `metallic-roofing`...) que sí es el identificador de `BusinessLine` en @ayr/shared
 * (§2.2). Este módulo es el único lugar que traduce entre ambos.
 */
const TO_SHARED: Record<PrismaLineCode, SharedLineCode> = {
  DRYWALL: SharedLineCode.DRYWALL,
  METALLIC_ROOFING: SharedLineCode.METALLIC_ROOFING,
  ROOFING: SharedLineCode.ROOFING,
  TRADING: SharedLineCode.TRADING,
  SERVICES: SharedLineCode.SERVICES,
};

const TO_PRISMA: Record<SharedLineCode, PrismaLineCode> = {
  drywall: PrismaLineCode.DRYWALL,
  'metallic-roofing': PrismaLineCode.METALLIC_ROOFING,
  roofing: PrismaLineCode.ROOFING,
  trading: PrismaLineCode.TRADING,
  services: PrismaLineCode.SERVICES,
};

export function toSharedLineCode(code: PrismaLineCode): SharedLineCode {
  return TO_SHARED[code];
}

export function toPrismaLineCode(code: SharedLineCode): PrismaLineCode {
  return TO_PRISMA[code];
}

/**
 * El código de línea tal como lo devuelve una **consulta cruda** (`bl."code"::text`).
 *
 * Es una tercera forma del mismo dato y hace falta nombrarla porque se confunde con las
 * otras dos a simple vista. Postgres guarda la etiqueta del enum, que es el valor de `@map`
 * (`'drywall'`), o sea **el identificador de @ayr/shared, no el nombre de Prisma**
 * (`'DRYWALL'`). Pasarle ese texto a `toSharedLineCode` devuelve `undefined` en silencio,
 * porque ese mapa está indexado por el nombre de Prisma; compararlo contra
 * `toPrismaLineCode(...)` no matchea nunca, por lo mismo.
 *
 * Valida en vez de castear: una línea nueva en el enum de la base que nadie agregó acá tiene
 * que reventar donde se lee, no aparecer como `undefined` en una pantalla de reportes.
 */
export function fromDbLineCode(code: string): SharedLineCode {
  const shared = DB_TO_SHARED.get(code);
  if (shared === undefined) {
    throw new Error(`Línea de negocio desconocida en la base: ${code}`);
  }
  return shared;
}

const DB_TO_SHARED = new Map<string, SharedLineCode>(
  Object.values(SharedLineCode).map((code) => [code, code]),
);
