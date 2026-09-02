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
