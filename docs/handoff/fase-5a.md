# Handoff — Fase 5a (cotización → confirmación → pedido + reserva) — 2026-09-04

## 1. Resumen

Fase 5a según `docs/ARQUITECTURA.md` §3.7 (D-064..D-069): **cerrada**. Se entregó el ciclo comercial **hasta la reserva** — cotización, emisión con PDF, confirmación que crea pedido y reserva en una sola transacción, el ledger de reservas con su invariante transversal, y las tres reversas — más las pantallas `/cotizaciones`, `/pedidos` y `/clientes/nuevo`, las columnas reservado/disponible en `/inventario` y el precio de lista en `/catalogo`.
Estado: `pnpm turbo lint typecheck test build` en verde (155 unit); **84/84 E2E en local** y **83/83 contra producción**; tres migraciones aplicadas en `dev` y `production`, API redesplegado en Cloud Run, web por push a `main`. `pnpm prod:purge-e2e` deja producción con **0 bobinas con saldo, 0 reservas activas y 0 piezas de prueba en stock**.
Revisado por `revisor` (dos pasadas: API y web por separado), `auditor-seguridad` y `qa`: **1 bloqueante, 7 altos, 2 medios de seguridad, 7 bajos y 1 defecto de `qa`**, todos corregidos.

## 2. Hecho

1. **TAREA 0 — D-063** (commit propio antes de tocar código): `.claude/settings.json` suma los comandos de diagnóstico de solo lectura (`grep`, `rg`, `head`, `tail`, `ls`, `find`, `wc`, `git log/diff/show`) con el `deny` de `Read(**/.env*)` **intacto** (D-062), y `CLAUDE.md` gana la regla dura 8: nunca `cd … &&`, y ningún diagnóstico apunta a `.env*`.
2. **Decisiones (punto 1)** — `docs/ARQUITECTURA.md` §0.2 gana D-064..D-069; §3.2 suma la segunda regla transversal; §3.7 parte la Fase 5 en **5a** y **5b**; RF-51/61/62/63/65/66/69 quedan trazados. Contexto largo en `docs/DECISIONES.md`.
3. **Prisma (punto 2)** — `quotations`/`quotation_items`, `sales_orders`/`sales_order_items`, `reservations`, más `products.list_price_pen` (D-068) y `business_lines.quotation_required` (D-065); `production_orders.reservation_id` gana su FK al ledger. Migraciones `20260904160000_fase5a_cotizacion_pedido_reserva`, `20260904161000_fase5a_linea_exige_cotizacion` y `20260904162000_fase5a_pedido_reconfirmable`.
4. **Módulo `sales` (punto 3)** — `apps/api/src/sales/`: `quotations.service.ts`, `sales-orders.service.ts`, `sales-lines.ts` (resolución de líneas compartida por cotización y pedido), `reservation-guard.ts` (el guardrail transversal), `quotation-pdf.ts`, `quotation-expiry.job.ts` y `sales.controller.ts`.
5. **La invariante en sus dos formas (punto 4, D-066)** — **cantidad** dentro de `InventoryService.record`/`reverse`, bajo el mismo lock de saldo que el kardex ya toma; **custodia** (`assertNotReserved`) en las rutas que se llevan el ítem entero sin mover kardex: `cutting.send` (D-050), `production.consume` (D-060) y el cierre de bobina (RF-19). Vive como función suelta para no meter a esos módulos en un ciclo con `sales`.
6. **Las tres reversas (punto 5)** — anular la cotización (cualquier estado no confirmado), anular el pedido (libera sus reservas y devuelve la cotización a `EMITIDA` si sigue vigente) y liberar una reserva a mano (solo ADMINISTRADOR, con motivo).
7. **Web (punto 6)** — `apps/web/src/app/(app)/cotizaciones/` y `pedidos/`, `components/sales/sales-document-form.tsx` (el mismo formulario para cotización y pedido directo), `components/sales/status-badges.tsx`, `lib/sales-queries.ts`, `lib/use-debounced.ts`, columnas reservado/disponible en `inventario/`, botón "Buscar" de RUC/DNI en `clientes/customer-dialog.tsx` y precio de lista en `catalogo/product-dialog.tsx`.
8. **Tests (punto 7)** — 16 unit nuevos: aritmética comercial (`sales-math.spec.ts`) y la invariante dentro del kardex (`inventory.service.spec.ts`). 155 en total.
9. **Revisión (punto 8)** — `revisor` ×2, `auditor-seguridad` y `qa`. Detalle en `docs/PROGRESO.md`.
10. **E2E (punto 9)** — `e2e/tests/fase5a.spec.ts` (9 de flujo) y `e2e/tests/fase5a-bordes.spec.ts` (10 de bordes, escritos por `qa`), con los helpers en `e2e/helpers/sales.ts`.
11. **Deploy y purga (puntos 10-11)** — `pnpm db:prod`, `pnpm deploy:api --web-origin …`, push a `main`, `pnpm e2e:prod` 83/83, `pnpm prod:purge-e2e` sin residuo.

## 3. Decisiones tomadas

- **D-063** — Permisos de diagnóstico de solo lectura en `.claude/settings.json` y regla dura 8: comandos siempre desde la raíz con rutas relativas, y ningún diagnóstico apunta a `.env*`. El `deny` de D-062 no se toca.
- **D-064** — **El dominio comercial va solo en soles.** Decisión del dueño. Sin selector de moneda ni TC en ventas; el USD sigue existiendo solo en compras (D-042).
- **D-065** — **Un solo flujo** cotización → pedido → reserva, con `business_lines.quotation_required` decidiendo si la cotización es obligatoria (coberturas, RF-31) u opcional (perfiles, trading). El pedido es una copia congelada; ambos comparten `sales-lines.ts`.
- **D-066** — **El ledger de reservas y la invariante en dos formas.** La reserva apunta al mismo par `(itemType, itemId)` que `inventory_balances`, lo que permite comprobarla bajo el lock que el kardex ya toma. Cantidad + custodia; ninguna alcanza sola.
- **D-067** — **Lookup de RUC/DNI** contra apis.net.pe (el mismo proveedor del TC, D-029), **opcional de punta a punta**: nunca lanza, y sin datos la captura manual sigue funcionando.
- **D-068** — Precio de lista único por producto (se guardan lista **y** cotizado), IGV 18 % sobre el subtotal ya redondeado, numeración `COT-nnnnnn`/`PED-nnnnnn` por `serial`, PDF a R2 al emitir.
- **D-069** — Vigencia de 7 días editable; job diario de pg-boss + endpoint de puesta al día. **El job no es la regla**: `confirm()` y el PDF revalidan la vigencia por su cuenta, porque el API escala a cero y el cron puede no correr.

## 4. Bloqueos / pendientes

Ninguno que requiera al dueño para seguir con Fase 5b.

**Hallazgos que cambiaron el código** (detalle completo en `docs/PROGRESO.md`):

- **Bloqueante.** La invariante estaba aplicada **en un solo sentido**: se comprobaba que ninguna operación rompiera una reserva viva, pero no que la reserva **naciera** sobre material cuya custodia ya estaba comprometida. Entre cotizar y confirmar, la bobina podía irse a un tercero (D-050) o quedar montada en una OP (D-060) — y como ninguna mueve kardex, el disponible se veía intacto.
- **Altos.** Anular el pedido solo se bloqueaba con reservas `CONSUMIDAS`, así que una OP con el fleje ya montado seguía fabricando para un pedido anulado; deshacer la producción no devolvía la reserva, dejando el material sin protección; deadlock real entre anular pedido y reportar; `reservationId` sin validar contra el producto de la OP; y, en el web, **la reserva no tenía consumidor**: `/planta` creaba la OP sin `reservationId`, así que el material prometido quedaba inmovilizable.
- **Seguridad (medios).** RF-66 dice "cotización **propia**" y no había comprobación de propiedad; y el PDF de un borrador nunca emitido era indistinguible de uno válido.
- **Defecto de `qa`.** El PDF de una cotización **vencida** salía sin rótulo mientras el job no la hubiera marcado — el mismo razonamiento de D-069, en la puerta por la que el papel sale al cliente.

**Diferido, con motivo:**

- **El tracker del throttle es la IP**, y detrás del proxy de Vercel (D-015) todos los usuarios comparten la de salida: el límite del lookup es global y no por usuario. Cambiarlo a `user.id` toca el guard que también protege el login → Fase 7.
- **El vendedor busca un RUC pero no puede dar de alta el cliente** (RF-85 reserva las mutaciones de `/customers` a ADMINISTRADOR). Es coherente con §3.4; si el dueño quiere lo contrario, es un cambio de RF-85, no un bug.
- `SalesOrderStatus.FULFILLED` existe y nada lo alcanza: el despacho que cierra un pedido es 5b.

**Ojo operativo — una suite de Playwright a la vez.** El primer `pnpm e2e:prod` se abortó a los 64 tests con un `ENOENT` sobre un archivo de trace: había otra corrida en paralelo y **todas comparten `test-results/`**, que Playwright limpia al arrancar. El síntoma no se parece a la causa (sale junto a un "Test timeout"). Repetida sola, verde.

**Ojo operativo — el nombre de la migración.** Las tres nacieron otra vez con fecha anterior a las ya aplicadas (D-053, el reloj de esta máquina). Se detectaron al mirar la carpeta y se renombraron con `scripts/migrations-rename.mjs` antes de commitear. Sigue siendo parte del flujo.

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm turbo lint typecheck test build   # exit 0 (155 unit)
pnpm format:check                      # exit 0
pnpm e2e                               # 84 E2E locales contra Neon dev
pnpm e2e:prod                          # auth+1+2a+2b+3+3b+4+4-bordes+m2+5a+5a-bordes (83)
pnpm prod:purge-e2e --dry-run          # qué dejaría limpio; sin la bandera, lo deshace
node scripts/prod-e2e-leftovers.mjs    # solo lectura: qué dejaron los E2E en producción
node scripts/migrations-status.mjs --branch production
gh run list --limit 3
curl -s https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app/health
```

**No correr dos suites de Playwright a la vez** (ver §4). Y si `pnpm e2e:prod` falla en el primer test de UI justo después de un deploy, reintentar antes de investigar: es arranque en frío de Vercel.

Producción:

- Web: https://ayr-steel-erp-web.vercel.app — nuevas rutas `/cotizaciones`, `/cotizaciones/nueva`, `/cotizaciones/[id]`, `/pedidos`, `/pedidos/nuevo`, `/pedidos/[id]`, `/clientes/nuevo`; `/inventario` gana Reservado y Disponible; `/catalogo`, el precio de lista; `/planta`, el selector de pedido a atender.
- API: https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app
- DB: Neon rama `production`, con las tres migraciones de Fase 5a.

Para redesplegar: el web sale solo con el push a `main`; el API con `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app`. Si se añade una migración, `pnpm db:prod` **antes** de desplegar el API.

## 6. Siguiente sesión

**Fase 5b** (§3.7): producción de coberturas, venta con descuento de stock, despacho y cobranza (RF-30, RF-31, RF-33, RF-36, RF-37, RF-38, RF-60, RF-63, RF-64, RF-67, RF-68, RF-73).

Primera tarea concreta: **la orden de producción de coberturas**, porque es la única pieza del ciclo que la reserva ya espera y todavía no existe. Lo que 5a deja listo y no hay que rehacer:

- **El hook OP↔reserva está construido y probado de punta a punta.** `production_orders.reservation_id` está conectado al ledger; crear la OP contra una reserva valida estado, pedido, línea **y que el pedido pida ese producto**; el primer reporte marca la reserva `CONSUMIDA` y pasa el pedido a `EN_PRODUCCION`; revertir el último reporte o anular la orden la devuelve a `ACTIVA`. 5b solo tiene que levantar la restricción de `ProductionService.create` que hoy limita las OP a drywall (D-048) y darle a coberturas su forma de receta — el largo lo fija el pedido, no el maestro (D-059).
- **La invariante ya cubre todas las rutas que tocan stock**, incluidas las que 5b va a usar. Una venta que descuente stock (RF-64) pasa por `InventoryService.record`, así que hereda la comprobación de cantidad sin tocar nada; lo único que hay que revisar a mano es cualquier mecanismo nuevo que comprometa material **sin** mover kardex, que es la lección acumulada de D-050, D-060 y D-066.
- **RF-37 (la cola) y RF-38 (el indicador del menú) salen casi solos**: `GET /sales/reservations?status=ACTIVE` ya devuelve los pedidos que esperan producción con su cliente, su ítem y los productos que encarga el pedido — es exactamente lo que la cola y el contador necesitan, y ya lo consume `/planta`.
- **El maestro de clientes está completo para SUNAT** (RF-80: documento, razón social, dirección, correo, teléfono) con el lookup de D-067 llenándolo. Fase 6 no debería necesitar campos nuevos.
- **Antes de empezar, decidir con el dueño** si el vendedor puede dar de alta clientes (hoy RF-85 lo reserva a ADMINISTRADOR y deja el botón "Buscar" sin salida para quien cotiza) y si `SalesOrderStatus.FULFILLED` lo cierra el despacho o la facturación.
