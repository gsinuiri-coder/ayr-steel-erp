# Handoff — Correcciones 02 del cliente (2026-09-24)

Agente: Claude Code, con subagentes (M3; M4+M5; M6+M7+M8, cada uno en su worktree
`ayr-steel-erp-corr02-*` y rama `fix/corr02-*`, mergeadas en `fix/correcciones-02`). Worktree
`ayr-steel-erp-corr02`, rama `fix/correcciones-02`, apilada sobre `fix/deudas-post-s4b` (#19),
que va sobre `feat/color-comercial` (#18). PR #20 hacia `main`. El dueño autorizó la secuencia
entera, día y ventana, de corrido.

## 1. Resumen

| Milestone | Decisión | Qué                                                                                   |
| --------- | -------- | ------------------------------------------------------------------------------------- |
| M1        | D-277    | El pedido con toda su producción cerrada se ve y se filtra «Listo» (`stage` derivado) |
| M2        | D-278    | Despacho a la fecha del comprobante: plan, botón (ADMINISTRADOR), endpoints y CLI     |
| M3        | D-279    | Kardex PEPS SUNAT 13.1 descargable, solo ADMINISTRADOR                                |
| M4        | D-280    | Disponible de «Elegir producto» por lote: 165 → 13 consultas con 20 productos         |
| M5        | D-281    | Tabla de bobinas: «Metro lineal teórico» en lugar de «Ancho»                          |
| M6        | D-282    | Venta directa de bobina con modal de selección y «No se ofrecen»                      |
| M7        | D-283    | Descripción editable por línea (sin migración: la columna ya existía; Nubefact 250)   |
| M8        | D-284    | Esqueleto común de formularios (cotización, pedido, comprobante), solo presentación   |

**Sin migraciones.** El paso 0 del brief (reglas `ask` del checkout principal) quedó como commit
`cab1aad` en `fix/deudas-post-s4b`.

## 2. Diagnósticos contra production (solo lectura)

- **M1:** PED-000001..021 (salvo el 018) en `IN_PRODUCTION`, todas sus OP `CLOSED`, nada
  despachado. La API calculaba `readiness = LISTO` desde RF-S3c; la web nunca lo mostraba. No
  hay arreglo de datos: el estado persistido no está mal.
- **M2:** dry-run `pnpm dispatch:at-issue-date --branch production --confirm-production`
  (transacción `READ ONLY`), 2026-09-24: 28 comprobantes; 6 salidas (bobinas IMPO-ALZ-ROJO-3020
  de PED-000018, factura FFA1-00001321 del 01/08, S/ 84 676.41); 23 líneas en la excepción (UPVC
  con carga inicial del 22/09; 852 u de reservas liberadas: UPVC36MT 307, UPVC36MTAZUL 58,
  UPVC6MT 487); 15 a revisión (coberturas y planchas facturadas en agosto y producidas en
  septiembre). Plan en `local-data/corr02/`. Números idénticos después de los arreglos de la
  autorrevisión.

## 3. Autorrevisión

Dos pases de subagentes nuevos del mismo modelo (M1–M5 y M6–M8): 0 P0. P1 corregidos: doble
despacho concurrente (lock del pedido antes de planificar), descripción de bobina congelada y
sufijo de largos sobre el papel importado. P2 corregidos: reparto de lo fabricado entre
comprobantes, bobina de la carga inicial a revisión, archivados, botón solo ADMINISTRADOR, orden
del kardex. P2 abiertos: límites del PEPS con faltantes (documentados en D-279), vocabulario del
modal de bobina (`coil-sale-unavailable.ts` no reusa `firmHolderCode`), `staleTime` de la lista
«No se ofrecen», `aria-label` repetido en la fila y el botón del modal, POS con su propio
`pickupLocation`. **Todo queda PENDIENTE DE REVISIÓN INDEPENDIENTE.**

## 4. Verificación

Ver PROGRESO («Correcciones 02»): lint, typecheck, unitarios, `format:check`, suite E2E completa
local con builds de producción y CI de la PR.

## 5. Pendientes

- **Decisión del dueño:** RUC y razón social de la cabecera del PEPS (`COMPANY_RUC`,
  `COMPANY_LEGAL_NAME` en Cloud Run); hoy «(sin configurar)».
- ~~Las 15 líneas a revisión de M2~~: resueltas por D-285 (despachadas a la fecha del parte de producción).
- Validar con el contador los códigos de tabla 12 del PEPS.
- `dev:local` desde un worktree necesita `COMPOSE_PROJECT_NAME=ayr-steel-erp` para no chocar con
  el contenedor `ayr-local-db`.

## 6. Ventana (2026-09-24 → 25) y D-285

Detalle en PROGRESO («Ventana de correcciones 02»). #18, #19, #20 y #21 mergeadas y desplegadas;
API final `ayr-steel-erp-api-00049-zns` (`git-sha=962f17f`), `main` en `5ef7e36` más este cierre.

- D-278 se ejecutó (19 comprobantes) y la foto mostró 17 pedidos de UPVC con costo completo 0.
  El dueño corrigió la premisa: las ventas de agosto **sí** consumen el inventario inicial.
- **D-285**: carga inicial fechada el 2026-08-01 (única excepción al append-only, con migración
  de trigger, guarda de un solo uso y auditoría por movimiento), 23 salidas agregadas a los
  despachos de UPVC y 15 despachos nuevos de coberturas y planchas a la fecha del parte de
  producción. 0 a revisión; S/ 188 892.3388; PEPS de UPVC cuadra con el kardex; 0 pedidos con
  costo no rastreable.
- La excepción «entregado antes del inventario inicial» de D-278 queda en el código como regla
  general, pero hoy no tiene ningún caso vivo.

**Todo lo de esta sesión queda PENDIENTE DE REVISIÓN INDEPENDIENTE.**
