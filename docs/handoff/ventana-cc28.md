# Ventana cc28 — Sesión de limpieza (prioridad 1a)

## Resumen

- Dos cortes, sin migraciones, desplegados el martes 6 de octubre sin ventana (el cliente no usa la
  app ese día; brief de cc28).
- **Corte 1 (PR #115):** M1 a M4. API `ayr-steel-erp-api-00093-x8h` (`git-sha=3f126295`), `main`
  `fc1c8347`, `smoke:prod` 8/8 en los dos dominios.
- **Corte 2 (PR #116):** M5, M6 y lo que alcanzó de M7 y M8. Estado final: (se completa).
- Decisiones: D-459 (ratificaciones del dueño), D-460..D-462 provisionales.

## Corte 1 — M1 a M4

- **M1, corte tercerizado (P2-1 de cc18):** `cancel` relee el estado de sus filas bajo el
  `FOR UPDATE` y aborta con 409 si alguna dejó de estar `SENT`; `receive` y `reverse` toman
  `cutting_orders` antes que su fila (D-386). Par concurrente nuevo «corte: anular × recibir» en
  `lock-order.db-spec.ts`: con el código viejo, 12 de 12 iteraciones terminaban en deadlock; con el
  nuevo, ninguna. Contratos de orden para anular, recibir y revertir.
- **M2, lo de cc27:** la conversión del vendedor cuenta solo pedidos no anulados (D-459); la vista
  previa de cierres bloquea la orden antes de leer el «antes» (A-6) y usa el tope de su acción real
  (120 s el borrador, 60 s los cierres; con 20 s un borrador grande daba 500, SM-1); db-spec que fija
  que la vista previa no deja filas ni mueve series fiscales y que un cierre real concurrente entra
  al terminar ella; el ítem de la venta de mostrador es estricto (A-2).
- **M3, AGENTS.md:** regla dura 17 (orden único de bloqueos, con la salvedad del grupo C y «el
  documento antes que sus filas»); la regla 1 pasa a D-445 y D-460; §3.1, §3.2, §5, §9 y §10
  alineados.
- **M4, demo:** `dev:demo` y `db:demo` leen el `.env.demo` del checkout principal (o
  `AYR_ENV_DEMO`, relativo al checkout principal); `env:demo` se niega a generar uno en un worktree;
  `mainCheckoutRoot` no falla abierto sin git. `scripts/demo-env-path.mjs` y su test.
- **Revisiones del corte 1:** autorrevisión 0 P0, 0 P1, 3 P2, 9 P3; segundo modelo 0 P0, 0 P1,
  2 P2, 7 P3. Corregidos los cinco P2 (A-1, A-2, A-3/SM-1, SM-2) y los P3 triviales (A-8..A-12,
  SM-5..SM-7). Detalle en `docs/revision/cc28-corte1-*.md`.
- **Tests:** API 525 unitarios del área; db-spec cc28 3/3; scripts 53; E2E de M2 11 passed (2
  `@pse` omitidos). CI del PR en verde (run 37492731930).
- **Ventana (11:36–11:42 de Lima):** vuelta atrás anotada `00092-kzx` / `9f16f1f9`; API
  `00093-x8h` con `git-sha=3f126295` al 100 % y `/health` ok; merge del #115: `main` = `fc1c8347`,
  sin diff de runtime; Vercel en `success`; `smoke:prod` 8/8 en los dos dominios.

## Corte 2 — M5 a M8

- **M5:**
  - ventas y margen: fila «Redondeo al céntimo de los comprobantes» (D-461), en pantalla y en el
    Excel; unitarios y el E2E de cc23 con una venta de mostrador a precio con IGV;
  - las descargas del API (los siete Excel de listas y las demás de `HeaderActions`) van por
    `fetch`: el 400 del tope de D-446 sale en un aviso con su mensaje; E2E con la ruta en 400;
  - Panel (D-444): «Facturado por día (sin IGV), incluye ventas sin costo comparable» y el
    facturado del mes bajo el titular.
- **M6, buscador (P2-1 y P2-2 de cc19, D-462).**
- **M7, P2 de PROGRESO:**
  - hechos: P2-2 de cc20 (el rechazo nombra la otra bobina montada con saldo); P2-2 del accesorio
    de cc21 (test de servicio); P2-3 del segundo modelo de cc21 (documentado en D-389);
  - ya resueltos antes, verificados: cc14 #8 (la descripción cambia con el producto, decisión D de
    cc15) y cc14 #6 (`hasLiveIn` bloquea con mensaje);
  - quedan: P2-2 del segundo modelo de cc16 (el diálogo de mover comprobantes repite `plan()` por
    candidato: refactor de tamaño M; paralelizar arriesga el pool), P2-2 y P2-3 del segundo modelo
    de cc25 (E2E de merma sin producción; medir cobranzas en producción exige un admin efímero
    contra la base real, fuera de esta sesión), P2-1 a P2-3 de cc15a (fuera de alcance: costo PEPS).
- **M8, P3 de tamaño S:** A-9 y SM-4 de cc27 (aviso de cambios sin guardar), P3-7 de cc19
  (nombre). P3-4 de cc21 (`as const`) se probó y se revirtió: obliga a castear donde se usa.

(Revisiones, tests y ventana del corte 2: se completa.)

## Decisiones

- **D-459 (del dueño):** ratificadas D-443, D-444, D-446..D-451 y D-452..D-458; un pedido anulado
  no cuenta como conversión; el menú no se colapsa solo.
- **D-460 (provisional):** tres acciones siguen pidiendo el OK del dueño por nombre (migración,
  `--execute --confirm-production`, borrar rama de Neon); el agente no empuja a `main` por decisión
  del dueño, no por un permiso (endurecer `.claude/settings.json` es del dueño).
- **D-461 (provisional):** la fila de redondeo en ventas y margen.
- **D-462 (provisional):** el buscador distingue código interno y comprobante.

## Para el dueño

(Se completa.)
