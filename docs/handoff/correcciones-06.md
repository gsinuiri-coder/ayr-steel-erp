# Handoff — Correcciones 06: bobinas que se terminan solas (D-360) y rentabilidad por comprobante (D-361)

## 1. Resumen

**Estado al cierre: desplegado y verificado.** PR #52 mergeado (`8adb9cd`), SHA desplegado `3659b24`. API
`ayr-steel-erp-api-00065-4sn` (100 % del tráfico, `git-sha=3659b24`), web en Vercel, smoke en verde contra la
web vieja y contra `v2.mareliac.pe`, diff de runtime en exit 0. CI del PR en SUCCESS completa (lint/typecheck/
unit, E2E del runner, smoke con Neon `ci`, SonarCloud). Sin migración. Detalle de la ventana en
`docs/PROGRESO.md`, «Ventana de Correcciones 06».

**Lote de la terminación única en producción: `964e7464-2684-4103-8d0a-f5ecc836c693`** (27 bobinas).
Reversa, si hiciera falta:
`pnpm terminate:zero-coils --undo 964e7464-2684-4103-8d0a-f5ecc836c693 --execute --branch production --confirm-production`
(foto: `--report <lote>` en vez de `--undo … --execute`).

M2 (recorrido de UX) **no se hizo en esta sesión**, por decisión del dueño: va en una sesión nueva con Sonnet.

## 2. Hecho

- **M0 — D-360.** `apps/api/src/coils/coil-auto-terminate.ts` (plan, terminación y reapertura por auditoría),
  llamado desde merma, partido, recepción de corte, venta entera (D-170 delega en él), salida faltante de D-285,
  y cierre/anulación/liberación de OP de drywall y coberturas. Reversas que reabren: anular merma, reabrir OP,
  `revertSplit`, reversa de recepción de corte. Anomalías (saldo negativo; reserva `COIL` viva, que nombra al
  pedido o cotización) auditadas sin terminar. CLI `pnpm terminate:zero-coils` (`src/coils/terminate-zero-coils.ts`
  - `prisma/terminate-zero-coils-cli.ts`): dry-run con foto, `--execute` con lote, `--undo <lote>`,
    `--report <lote>`.
- **M1 — D-361.** `traceLine` extraído de `sales-by-material.ts`; `GET /reports/documents/:id/profitability`
  (`document-profitability.ts` + `.service.ts`, ≤ 6 consultas); sección «Rentabilidad» en
  `apps/web/src/app/(app)/comprobantes/[id]/document-profitability.tsx`; Ventas por material con precio/costo/
  ganancia por ML y costo por unidad (pantalla y Excel); aviso nuevo `PROFIT_SOURCES_NOTICE` en los dos reportes
  y en la sección. Ventas y margen usa `LIVE_DOCUMENT_STATUSES`.
- **Demo.** Restablecida desde `production`; `pnpm dev:demo` escucha solo en `127.0.0.1` (API por `BIND_HOST`,
  web con `next dev -H`).
- **AGENTS.md §3.5:** worktrees con nombre corto (`../ayr-<corto>`), por el límite de 260 de Windows.

Commits (en orden): `8798d61` AGENTS · `40596eb` LIVE_STATUSES · `c14771e` M0 · `1286cd8` M1 · `8646462` P1 de
las revisiones · `65eba28` D-360/D-361 · `ce9e307` test de la venta entera · `f91aef1` anomalía con test ·
`d98b154` evidencia del undo · `f941b01` ENTORNOS + D-362 · `7f55c5d` foto de la CLI · `9593d81` demo en
127.0.0.1 · `7ed3a02` nota del bind · `3659b24` evidencia del ensayo.

**Pruebas:** unitarios del API 1934/1934 antes de las correcciones; después, los módulos tocados en verde
(coils 143, reports, production, cutting, invoicing 605); la suite completa y el E2E completo los corrió la CI
sobre `3659b24`, en verde. E2E local de los 12 specs que llevan una bobina a 0: 78/79 antes de ajustar
`cierre-bobina-d164` (el rojo esperado: la merma a 0 ahora termina la bobina); después, 33/33 en `fase2b`,
`fase3b`, `cierre-bobina-d164` y `correcciones-06`. Cobertura de líneas nuevas del API: 92,3 %.

**Revisiones:** `docs/revision/correcciones-06-autorrevision.md` (0 P0, 3 P1) y
`docs/revision/correcciones-06-segundo-modelo.md` (0 P0, 1 P1), resueltos en `8646462`; P2 tomados y anotados en
cada informe. Ninguna vale como pase independiente: falta la revisión del dueño.

## 3. Decisiones tomadas

- **D-360** — la bobina se termina sola en exactamente 0 (sin kardex; montada, al cerrar/liberar la OP;
  reversas que reabren por la auditoría; CLI con lote y `--undo`).
- **D-361** — rentabilidad por comprobante con el mismo motor que Ventas por material; el resto por el `SALE`
  de los despachos declarados; columnas por ML y costo por unidad.
- **D-362** — **backlog**: resetear la contraseña de todos los usuarios al restablecer demo.

## 4. Bloqueos / pendientes

- **Ramas Neon** (no se borró ninguna; todas con OK del dueño por nombre):

  | Rama                                                                                                  | id                          | Propuesta                                  |
  | ----------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------ |
  | `production`, `dev`, `ci`, `demo`                                                                     | —                           | se conservan                               |
  | `respaldo-pre-v4-20260915`                                                                            | br-sweet-resonance-aegd7jdg | se conserva siempre                        |
  | `respaldo-pre-correcciones-02-20260924`                                                               | br-quiet-shadow-aebuca1c    | checkpoint: borrar después del 2026-10-03  |
  | `respaldo-pre-corr04b-20260926`, `-corr03b-20260926`, `-drywall-20260927`, `-import-compras-20260927` | —                           | se conservan (menos de 7 días)             |
  | `respaldo-pre-c06-20260928`                                                                           | br-purple-wind-aehyx2u0     | se conserva (respaldo de esta ventana)     |
  | **`ensayo-c06-20260928`**                                                                             | br-rough-firefly-ae7b7az7   | **propuesta de borrado** (tiene el ensayo) |

- **Ramas de git remotas** `feat/correcciones-06` y `docs/cierre-correcciones-06` (después del merge de este
  PR): para el OK del dueño.
- **Backlog:** D-362; verificar en vivo el bind del API de demo en el próximo `pnpm dev:demo` desde el checkout
  principal; la codificación rota del backlog viejo de `PROGRESO.md` (ver la entrada de C06); `prisma generate`
  en un checkout recién instalado.
- **Deuda anotada, sin tocar:** un despacho mixto (ítems con y sin salida de kardex) se costea por lo que tiene
  salida; el motor de D-354 resta costo por una nota de crédito de descuento (viene de D-354).

## 5. Cómo verificar

- `pnpm terminate:zero-coils --branch production --confirm-production` → «Se terminan: 0».
- `pnpm terminate:zero-coils --report 964e7464-2684-4103-8d0a-f5ecc836c693 --branch production --confirm-production`
  → 27 bobinas `CLOSED`, 70 movimientos de kardex.
- Guion `docs/uat/correcciones-06.md` (lectura en producción: FFA1-00001352, FFA1-00001321, FFA1-00001356 y
  Ventas por material de agosto).

## 6. Siguiente sesión

**M2 de C06 — recorrido de UX de toda la app, solo análisis, sin cambiar código** (brief original del dueño):
capturas a 1366×768 y 1920×1080 en local o demo (nunca producción) a `local-data/c06/ux/`, análisis de los
formularios contra la grilla de D-293, informe `docs/analisis/ux-recorrido-<fecha>.md`, PR solo de docs, y
**parar** hasta que el dueño decida qué se arregla. Sesión nueva, con Sonnet.
