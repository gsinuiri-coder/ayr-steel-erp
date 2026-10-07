# cc31 corte 4 — revisión de segundo modelo

Revisor: Sonnet (contexto limpio), 2026-10-07. Diff `cc31-c3...cc31-c4` más `panel-today.tsx` entero. Solo lectura.
No es pase cruzado independiente ni cierra la revisión (AGENTS.md §2.2).

## Resumen

0 P0, 1 P1, 4 P2, 3 P3. El P1 es un texto roto visible en la lista de cotizaciones al abrirla desde la tarjeta del vendedor.

## Hallazgos

### P1-1 — «en «undefined»» en el título de Cotizaciones (tarjeta del vendedor)

- `apps/web/src/app/(app)/panel-today.tsx:174` enlaza a `/cotizaciones?status=DRAFT,EMITTED`.
- `apps/web/src/app/(app)/cotizaciones/cotizaciones-view.tsx:95-97` hace `QUOTATION_STATUS_LABELS['DRAFT,EMITTED']` (undefined) y lo mete en la plantilla: el título queda «Cotizaciones en «undefined»». Además `StatusFilter` (`components/status-filter.tsx`, `selectValue`) no reconoce la lista y muestra «Todos, sin anulados» aunque el filtro está activo, y el pie dirá lo mismo.
- Arreglo: partir `status` por comas en `filterLabel` (etiquetas unidas con « y »), y que el selector muestre un valor para listas; o enlazar a un solo estado.

### P2-1 — El conteo del vendedor no es lo que muestra la lista a la que lleva

- `dashboard.service.ts:19-26`: «por vencer» cuenta solo `DRAFT` con `validUntil <= hoy+3 días hábiles` (incluye ya vencidas). El enlace abre todas las `DRAFT,EMITTED` sin filtro de fecha: la tarjeta dice 2 y la lista trae decenas. Sin parámetro de fecha en la lista, no se puede acotar sin API nueva; al menos el detalle debe decir qué cuenta, o la tarjeta no enlazar como si fuera el mismo conjunto.
- La tarjeta del administrador (`panel-today.tsx:121-127`) cuenta `EMITTED` por vencer en 7 días y la del vendedor `DRAFT` en 3 días hábiles: el mismo rótulo «Cotizaciones por vencer» significa cosas distintas por rol. Detalle del admin «esta semana» tampoco coincide con los 7 días de `QUOTATION_EXPIRY_WINDOW_DAYS`.

### P2-2 — «Pedidos listos» y «Pedidos en producción» del vendedor usan otra definición que el filtro `stage`

- `dashboard.service.ts:44-67` (SQL propio: OP ROOFING IN_PROGRESS; «listo» = tiene OP viva y ninguna DRAFT/IN_PROGRESS, con `status != CANCELLED`, o sea incluye pedidos ya despachados/atendidos) frente a `order-readiness.ts:77-94` (`READY` solo sobre `CONFIRMED`/`IN_PRODUCTION`; `IN_PRODUCTION` excluye los listos). Los números pueden no coincidir con la lista filtrada (`panel-today.tsx:187,194`). Escenario: pedido FULFILLED con OPs terminadas cuenta en «listos» pero no aparece en `?stage=READY`.
- Arreglo: en el vendedor, tomar el conteo de `/sales/orders?stage=…&pageSize=1` (el API ya filtra por vendedor con `sellerWhere`), como hace el administrador, y dejar de usar el SQL del dashboard para esas dos.

### P2-3 — Tarjetas con ancla cuando la tarjeta destino no se pinta

- `panel-today.tsx:147,155,163`: las tres tarjetas del administrador enlazan a `#cotizaciones-sin-stock`, `#pedidos-con-faltante`, `#precios-bajo-piso`. Los ids están en las tarjetas (`stock-shortages-card.tsx`, `orders-shortfall-card.tsx`, `price-floor-summary-card.tsx`) solo en la rama con datos; con 0 filas devuelven `null`, y en estado de error las tarjetas de error no llevan id. Con conteo 0 el enlace no hace nada (tarjeta «muerta» que parece clicable); con error, tampoco.
- Arreglo: con `count === 0` pintar el tile como no enlazable (`div`, sin hover) y poner el mismo id a la tarjeta de error.

### P2-4 — Primera carga del vendedor muestra «…» indefinido si falla la consulta

- `panel-today.tsx:171,178,185,192`: `seller.data?.x ?? null` → «…» para siempre con error o 403; no hay estado de error (la campana sí lo tiene). Ver P3-2 para el equivalente del administrador.

### P3-1 — Comentario obsoleto en la fecha

- `panel-today.tsx:21`: el ejemplo dice «martes 6 de octubre»; la salida es con mayúscula inicial («Miércoles 7 de octubre» hoy, comprobado el formato `es-PE` + `replace(',', '')`). Solo comentario.

### P3-2 — Conteos del administrador sin error

- `panel-today.tsx:138,144`: `inProduction` y `stockShortages` en error dejan «…»; no hay `isError`. Mismo criterio que P2-4.

### P3-3 — Nombre del mes

- `admin-dashboard.tsx:124-133`: usa el mes de `d.current.from`; si el rango es parcial o de otro mes (según el selector de rango) el título dice «Octubre en cifras» aunque el rango abarque más. Verificar que el rango del Panel sea siempre el mes en curso.

## Verificado sin hallazgo

- **Roles y endpoints.** `/sales/dashboard`: VENDEDOR/ADMIN/PLANTA (el vendedor solo lo pide `isSeller`). `/sales/orders` (clase `@Roles(ADMIN, VENDEDOR)`, filtra por `sellerWhere`): lo piden admin y vendedor vía `enabled`. `/sales/quotations/stock-shortages` y `/sales/orders/with-shortfall`: solo ADMIN, solo `isAdmin`. `/production/roofing/queue`: ADMIN/PLANTA, `plants`. `/invoicing/alerts`: sin cambios. Ningún rol llama un endpoint que se le niega. Planta ya no llama `/sales/dashboard` (menos tráfico, sin pérdida: su tarjeta es la cola).
- **queryKey compartidas.** `['seller-dashboard']` (antes en el archivo borrado) mismo DTO; `['quotation-stock-shortages']` mismo `QuotationStockShortageDto[]` que `stock-shortages-card.tsx:28` e invalidación en `sales-queries.ts:28`; `['pending', …]` mismas claves y forma que `pending-bell.tsx`; `['pending','in-production-orders']` es nueva y solo se usa aquí. No hay `['seller-dashboard']` residual en otro componente (`seller-sales-card` usa `seller-dashboard-month`).
- **Enlaces.** `/pedidos?stage=READY|IN_PRODUCTION` los lee `pedidos-view.tsx:73` y el API acepta lista (`statusListSchema`); `/cotizaciones?status=EMITTED` lo lee `cotizaciones-view.tsx:61` (el único problema es la lista con coma, P1-1); `/reservas-temporales` existe, en menú y para ADMIN/VENDEDOR. Los `id` de ancla se aplican al `div` de `Card` (props se esparcen).
- **Textos.** Tuteo/español sin inglés ni códigos internos en lo nuevo. «Cotizaciones sin stock · evaluar compra» y demás correctos.
- **e2e.** Sin referencias a `home-greeting`, `seller-dashboard-cards`, «Hola,», «Fase 0» ni «El mes en cifras» en `e2e/` (solo `docs/uat/cc26.md:35`, doc histórico). `panel-cc26.spec.ts` ya usa `/ en cifras$/`. `alcance-vendedor-ui.spec.ts:89-92` sigue pasando con los mismos rótulos (`Pedidos listos`, etc.) en las tarjetas nuevas; sigue sin pedir `stock-shortages` para el vendedor.
