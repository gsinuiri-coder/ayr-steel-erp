# Ventana cc45 — Cambiar la cantidad de una línea del pedido con producción en curso

2026-10-11, sesión atendida en modo continuo. Ventana suspendida (D-533). Sin migraciones, sin SQL
contra producción. D-603 a D-605 nuevas, pendientes de ratificación del dueño.

## En producción

| Corte | Qué                                | Resultado                                                       |
| ----- | ---------------------------------- | --------------------------------------------------------------- |
| (a)   | `pnpm deploy:api` desde `cf61ee48` | API `00116-hfd` (`git-sha=cf61ee48`), 100 %; `smoke:prod` verde |
| (b)   | merge de PR #176 (`f7e99b19`), web | Vercel en verde; `smoke:prod` verde                             |

- Vuelta atrás de la API: tráfico a `00115-wnv`.
- `git diff --quiet cf61ee48 origin/main -- apps packages Dockerfile …` → exit 0 (alineado).
- CI del PR en verde sobre `cf61ee48`: los dos shards de E2E, `base` (drift y `test:db`), Sonar,
  escenarios, lint/typecheck/unit. `smoke-neon` seguía corriendo al mergear (no es obligatorio).
- **UAT de solo lectura en producción** (admin efímero, borrado): PED-000049 muestra en
  «Órdenes de producción» **«6.00 m de 5.00 m»** (antes «6.00 m de 0.00 m») y «Cambiar cantidad»
  apagado con «El pedido ya tiene comprobante: para cambiar la cantidad, primero va la nota de
  crédito». No se escribió nada. Capturas en `local-data/cc45/prod-antes/` y `prod-despues/`.

## Qué entró

| Pieza                                   | Decisión | Dónde                                                                                                                                 |
| --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Cambiar cantidad con producción         | D-603    | `sales-order-edits.service.ts` (`updateItemQty`, `previewItemQty`, `readQtyFacts`, `resizeStartedInTx`), `qty-change.ts`, controlador |
| La OP y la reserva siguen a la cantidad | D-604    | `followPlan`, `SalesOrdersService.reserveExtra`, `createFromReservationInTx` con `plan`                                               |
| Avance del accesorio                    | D-605    | `production/accessory-plan.ts` y sus usos (listado, detalle, cola, lote de planta, borrador, parte, cierre)                           |
| Web                                     | D-603    | `components/sales/change-line-qty-dialog.tsx`, `lib/qty-change.ts`, `pedidos/[id]/line-production.tsx`, `pedido-detalle-view.tsx`     |
| Escenarios                              | —        | `seed:escenarios`: C1 (bajar en a medida) y C2 (subir en accesorio con la OP cerrada); la prueba los baja y sube entre corridas       |

**Ejemplo (C1, datos inventados):** línea a medida de 125,6 m con 101,6 registrados; bajar a lo
registrado libera 94,634 kg y deja la OP lista para «Registrar y cerrar»; subir con 6 × 3,00 m
reserva 70,974 kg más. Detalle en `docs/DECISIONES.md` (cc45).

## Pruebas

- db-spec `apps/api/src/sales/order-qty-change.db-spec.ts` (7 casos: bajar y cerrar, piso, subir
  con y sin material, vendedor 403, OP cerrada → OP nueva, accesorio con su tope, plancha,
  comprobante 400) y `lock-order.db-spec.ts` (par (c) con motivo y faltante; par nuevo (e)
  «cambiar con producción × revertir el reporte», 20/20 sin conflictos). 41/41 en local.
- Unitarios: `qty-change.spec.ts`, `accessory-plan.spec.ts`, `sales-order-edits-qty.spec.ts`
  (12 casos con base falsa), `reserve-extra.spec.ts`, `apps/web/src/lib/qty-change.spec.ts`.
- E2E: `cambiar-cantidad-cc45.spec.ts` (bajar y cerrar; subir con la OP cerrada y registrar lo
  nuevo; despachos). Adaptados al diálogo nuevo o a D-603: `flujo-comercial-f8s2-ui`,
  `huecos-cobertura-f8s2b`, `pedido-edicion-f8s2`, `reactivar-con-lineas-d378`.
- `seed:escenarios:test` dos corridas en verde contra un Postgres desechable.
- Suite E2E local completa con builds de producción (`CI=true`, base `ayr_local_e2e_cc45`):
  592 passed, 19 failed, 2 skipped (1,1 h). Los 19 son de entorno local, los mismos de cc44:
  emisión sin PSE («Emisión electrónica no habilitada»), PDF sin R2, y los CLI de inventario
  inicial, normalización, barrido y purga, que buscan la base `local-e2e`. Ninguno de pedidos ni
  de planta; la CI, con esos secretos, pasó la suite entera. Una primera corrida se cayó a mitad
  (la API dejó de responder mientras corrían `test:cov` y `test:db` a la vez) y se repitió sola.

## Revisión

Autorrevisión (subagente sin el handoff) y segundo modelo Sonnet
(`docs/revision/cc45-segundo-modelo.md`): sin P0. P1 y P2 corregidos antes del deploy (regex rota
en un E2E, OP de perfiles atada, bajar con la OP cerrada corta, la vista previa que gastaba
correlativos, el diálogo con datos viejos, pares de concurrencia y despachos). La CI pidió
cobertura (Sonar 37,8 % → unitarios con base falsa) y destapó el tope de espesores del fixture de
`lock-order` (ahora da la vuelta a un segundo color).

## Fuera de alcance / para la próxima sesión

- D-603..D-605 pendientes de ratificación.
- Cambiar la cantidad después del comprobante (va por nota de crédito, manual) y el cierre corto
  (descartado) quedan fuera, como dice la ESPEC.
- PED-000049 lo resuelve el dueño en la pantalla (merma de 1 m o venta aparte): tiene comprobante,
  así que «Cambiar cantidad» no aplica.
- La reserva se calcula con el consumo teórico (D-604): subir un metro puede mover la reserva más
  que ese metro si planta consumió distinto de lo teórico; «Qué va a pasar» lo dice.
- Una línea con una OP de perfiles atada (anterior a D-599) no se cambia por este camino.
- Lint: no hay regla `react-hooks/rules-of-hooks` activa; un hook después de un return temprano
  rompió el detalle del pedido en local y nadie lo avisó (corregido).
