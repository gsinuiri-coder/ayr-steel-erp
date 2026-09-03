# Handoff — Fase 3 (Corte tercerizado y flejes) — 2026-09-02

## 1. Resumen

Fase 3 según `docs/ARQUITECTURA.md` §3.7 (D-047..D-050): **cerrada**. Se entregó el módulo `cutting` completo (envío RF-40, recepción parcial RF-41, cancelación RF-22), el prorrateo del costo del servicio de corte entre los flejes recibidos, y las vistas `/corte`, `/corte/nueva`, `/corte/[id]` y `/flejes` (RF-42).
Estado: `pnpm turbo lint typecheck test build` en verde (121 unit); 35/35 E2E en local y **34/34 contra producción**; migración aplicada en Neon `production`, API redesplegado en Cloud Run, web desplegado por push a `main`, CI verde.
Revisado por `revisor`, `auditor-seguridad` (con segunda opinión de `agy`) y `qa`: 1 alto + 3 medios/bajos del diff, más 1 bloqueante real que `qa` encontró al escribir los E2E (bobinas en corte tercerizado que se podían mermar/anular/cambiar de estado como si estuvieran disponibles).

## 2. Hecho

1. **Decisiones y requisitos** — `docs/ARQUITECTURA.md` §0.2 (D-047..D-050), §3.7 reordenado (D-048 mueve coberturas a Fase 5 por la dependencia de cotización de RF-31), §5 con P-13 resuelta. Contexto largo en `docs/DECISIONES.md`.
2. **Prisma (punto 2)** — `coils.kind` (`COIL`/`STRIP`, D-049), `CoilStatus.IN_THIRD_PARTY` (D-050), tablas `cutting_orders`/`cutting_order_coils`, `purchases.related_cutting_order_id`. Migración `20260903031603_fase3_corte_flejes`.
3. **Módulo `cutting` (punto 3)** — `apps/api/src/cutting/`. `send()` no mueve kardex (D-050): la bobina pasa a `IN_THIRD_PARTY`. `receive()` reusa `planCoilSplit` y `CoilsService.create/prepareBatch` tal como el partido interno (RF-15), con `refType=CUTTING` y `kind=STRIP`; permite recepción parcial, una bobina a la vez. `cancel()` (RF-22) anula lo que sigue `SENT`, sin reversa de kardex porque nunca hubo movimiento.
4. **Costo del servicio (punto 4)** — `applyCuttingOrderCost` en `apps/api/src/purchases/purchases.service.ts`, mismo patrón que el landed cost de D-043 (`applyLandedCost`): prorrateo por kg vía `prorateByWeight`, `refType='PURCHASE'` a propósito para que `cancel()` de la compra lo revierta igual. Solo ADMINISTRADOR puede crear el vínculo (`assertCuttingOrderLinkIsValid`).
5. **Web (punto 5)** — `/corte` (lista con filtros), `/corte/nueva` (elegir proveedor de corte, armar el plan de anchos por bobina con validación en vivo), `/corte/[id]` (recepción parcial por bobina, vincular factura del servicio vía `/compras/nueva?ordenCorte=`, cancelar lo pendiente), `/flejes` (stock RF-42, agrupado por `typeKey`+`widthMm`, a diferencia de `/inventario` que agrupa solo por `typeKey`). `purchase-form.tsx` ganó el campo `relatedCuttingOrderId`.
6. **Tests (punto 6)** — `cutting-math.spec.ts`: validación del presupuesto de ancho (`validateWidthBudget`) y del estado agregado de la orden (`deriveCuttingOrderStatus`). El prorrateo por kg reusa `prorateByWeight`, ya probado en `landed-cost.spec.ts`. E2E: `e2e/tests/fase3.spec.ts`, 4 escenarios.
7. **Revisión (punto 7)** — `revisor`, `auditor-seguridad` (con `agy`) y `qa`, en paralelo sobre el diff completo. Detalle abajo y en `docs/PROGRESO.md`.
8. **Deploy (punto 9)** — `pnpm db:prod`, `pnpm deploy:api --web-origin …`, push a `main` (el web sale solo), `pnpm e2e:prod` 34/34 y `pnpm prod:purge-e2e`.

## 3. Decisiones tomadas

- **D-047** (cierra P-13) — El consumo de producción (Fase 4/5) es el kg **teórico** por dimensiones × `densityFactor`, con override de kg real del operario; la diferencia se registra como merma de proceso automática. Registrada ahora para no reabrir la pregunta al llegar a Fase 4.
- **D-048** — Fase 4 = producción drywall + `/planta` (sin dependencia de cotización); Fase 5 = cotizaciones + `production_orders` + producción de coberturas + ventas, porque RF-31 exige cotización confirmada para producir coberturas.
- **D-049** — Un fleje es una fila de `coils` con `kind=STRIP`, hija de la madre vía `parentCoilId`. Reusa código, kardex y trazabilidad del partido interno (RF-15); solo cambia `refType` (`CUTTING` en vez de `SPLIT`) y que el stock de flejes (RF-42) se agrupa también por `widthMm`.
- **D-050** — Enviar una bobina a corte tercerizado no mueve kardex: pasa a `status=IN_THIRD_PARTY` sin movimiento, porque la mercadería sigue siendo de la empresa. El kardex real se emite recién al recibir. Esto simplificó RF-22 (cancelar = devolver a `OPEN`, sin nada que revertir) pero introdujo el hueco que `qa` encontró (ver abajo): varias operaciones de bobina no contemplaban este estado nuevo.

## 4. Bloqueos / pendientes

Ninguno que requiera al dueño.

**Hallazgos que cambiaron el código:**

- **Bloqueante (encontrado por `qa`).** `registerScrap`, `cancel` y `setStatus` de bobina (`coil-operations.service.ts`) solo bloqueaban `CANCELLED`; una bobina `IN_THIRD_PARTY` (enviada a corte, D-050) no tiene movimiento de kardex que la proteja, así que se le podía registrar merma, anularla o cambiarle el estado como si estuviera disponible, dejando la orden de corte apuntando a una bobina que cambió por debajo. Misma falla en `PurchasesService.cancel()`: anular la compra original de esa bobina la cancelaba igual. Los cuatro sitios ahora bloquean también `IN_THIRD_PARTY`.
- **Alto (`revisor`).** El plan de anchos (`widthPlanSchema`) topaba por fila y por número de filas, pero no el total de tiras — a diferencia del partido interno, `receive()` podía pedir cientos de flejes en una transacción con lock. Corregido con el mismo tope total que ya tenía `createCoilSplitSchema`.
- **Medios/bajos (`revisor`):** `/flejes` sumaba el valorizado con `number` en vez de `Decimal` (D-003); la previsualización de recepción no replicaba el ancho mínimo ni el piso de aprovechamiento del 80% que `planCoilSplit` exige en el servidor; `nueva-orden-view.tsx` sin manejo de `isError`; `lockCoil` duplicado entre `CoilOperationsService` y `CuttingService` → unificado en `CoilsService.lockCoil`.

**Diferido, con su motivo:**

- **No existe una reversa de recepción de corte** (deshacer RF-41 después de recibida). RF-40..42 solo definen RF-22 (cancelar el plan _antes_ de recibir); si un operario recibe mal una bobina hoy no hay forma de deshacerlo, solo de corregirlo hacia adelante. Es el mismo hueco que tuvo Fase 2a antes de que 2b construyera `reverse`, ahora aplicado a la recepción de corte. Se agrega si el negocio lo pide.
- Por esto, `pnpm prod:purge-e2e` deja **3 bobinas madre de prueba sin poder anularse** (una con 2 000 kg de saldo, dos ya `CLOSED` sin saldo): su compra `COIL` original está bloqueada porque la bobina tiene un movimiento `CUTTING` posterior a su ingreso, la misma regla que protege cualquier bobina ya movida. Quedan bajo proveedores E2E desactivados, identificables a simple vista.
- El prorrateo del costo de corte es siempre por kg, igual que el landed cost (D-043); mismas limitaciones ya anotadas en Fase 2b si algún día hace falta otro criterio.

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm turbo lint typecheck test build      # exit 0 (121 unit)
pnpm format:check                         # exit 0 (salvo .claude/settings.json, ajeno a esta sesión)
pnpm e2e                                  # 35 E2E locales contra Neon dev
pnpm e2e:prod                             # auth+fase1+fase2a+fase2b+fase3 contra producción (D-024)
pnpm prod:purge-e2e --dry-run             # qué dejaría limpio; sin la bandera, lo anula
node scripts/prod-e2e-leftovers.mjs       # solo lectura: qué dejaron los E2E en producción
gh run list --limit 3                     # CI en main
curl -s https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app/health
```

Producción:

- Web: https://ayr-steel-erp-web.vercel.app (rutas nuevas: `/corte`, `/corte/nueva`, `/corte/[id]`, `/flejes`)
- API: https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app
- DB: Neon rama `production`, con la migración `20260903031603_fase3_corte_flejes`.

Para redesplegar tras un cambio: el web sale solo con el push a `main`; el API con `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app`. Si se añade una migración, aplicarla primero con `pnpm db:prod`.

## 6. Siguiente sesión

**Fase 4** (§3.7, D-048): producción drywall + terminal `/planta` (RF-32..35, RF-38, RF-39), con el consumo de materia prima ya decidido en D-047 (kg teórico por dimensiones × `densityFactor`, override de kg real, diferencia como merma automática).

Primera tarea concreta: **modelar la corrida de producción de drywall** consumiendo flejes (`coils kind=STRIP`, ya construidos en esta fase). Lo que Fase 3 deja listo y no hay que rehacer:

- **Los flejes ya existen y tienen stock consultable.** `/flejes` (RF-42) y `GET /cutting/strips` ya agrupan por `typeKey`+`widthMm`; producción de drywall va a necesitar exactamente ese filtro (elegir el fleje del ancho correcto) para armar la corrida.
- **El patrón OUT+IN con `InventoryService.record` y `CoilsService.lockCoil`** (bloquear antes de leer saldo, dentro de una transacción) es el mismo que va a usar el consumo de producción; no hay que reinventarlo, solo el `refType=PRODUCTION` ya está reservado en el enum desde Fase 2a.
- **D-047 ya resolvió la pregunta de diseño** (kg teórico vs. real): la corrida de producción calcula el teórico, permite el override, y la diferencia contra lo que el kardex realmente puede dar sale como `SCRAP` — mismo mecanismo que la merma de bobina (D-040), no un tercer camino.

Ojo al empezar: no hay reversa de recepción de corte (ver §4), así que si producción necesita "deshacer" un consumo de fleje, ese fleje solo se puede anular si no tiene movimientos posteriores (RF-21), igual que cualquier bobina — no hay atajo especial por ser `STRIP`.
