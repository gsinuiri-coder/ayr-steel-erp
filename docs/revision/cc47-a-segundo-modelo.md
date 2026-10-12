# cc47 corte A — revisión del segundo modelo (Sonnet)

Alcance: commit 84c616ed contra origin/main (solo web, E2E y el doc del menú). Revisión por lectura de `git show`; no se corrió nada (ni typecheck, ni lint, ni Playwright). Contexto limpio, sin handoff.

## Veredicto

El código de producto cumple el pedido D-612..D-618 sin desvíos de fondo: no cambia ningún cálculo, los totales por línea y la paginación siguen, Excel recibe buscar y filtros, el modal tiene foco, Esc y nombres accesibles. Hay **2 defectos de E2E que dejarán rojo el CI (P1)**, 2 riesgos de flakiness (P2) y varios P3.

## P1 — corregir antes del deploy

### P1-1. `e2e/tests/huecos-cobertura-f8s2b.spec.ts` (~líneas 125-145) queda rojo; el commit no lo tocó

Test «D-188: sin cotizaciones con faltante, la tarjeta del Panel no pinta nada». Hace `page.waitForResponse(... '/api/sales/quotations/stock-shortages')` antes de pulsar «Ingresar» y luego `const resp = await shortagesResponse; expect(await resp.json()).toEqual([])`.

- Escenario: el Panel ya no pide `stock-shortages` (D-618 quitó la query de `panel-today.tsx` y `StockShortagesCard`). La respuesta nunca llega, `waitForResponse` agota el timeout del test y el test queda rojo.
- Corrección: reescribirlo (o borrarlo; el nuevo de `stock-shortage-f8s2b.spec.ts` ya cubre el caso) para comprobar solo que el Panel carga y no contiene «Cotizaciones sin stock disponible» ni el mosaico «Cotizaciones sin stock». Quitar `page.route`, `waitForResponse` y el `page.request.get` del endpoint. Renombrar los títulos (el del segundo test, «un VENDEDOR también ve la tarjeta…», ya miente aunque pasa).

### P1-2. `e2e/tests/planta-cola-f8s3-ui.spec.ts` (~líneas 199-207) busca un enlace que no existe en esa pantalla

El commit agrega `getByRole('link', { name: 'Historial de órdenes', exact: true })` con `href` `/\/planta\?historial=1$/` en el punto donde la página es `/planta?pedido=<id>` (vista del pedido, tras `chipOf(firstCode).click()`).

- `planta-view.tsx:257` pinta «Historial de órdenes» solo en la lista `/planta` (cabecera «Producción»). La cabecera de la vista del pedido (`planta-view.tsx` ~565-580) solo trae «Todos los pedidos» y «Ver pedido».
- Resultado: el locator no encuentra nada, timeout, rojo.
- Corrección: hacer la aserción después de `page.goto('/planta')` (o del clic en «Todos los pedidos»), o dejar solo el `toHaveCount(0)` del enlace del menú. Matiz de producto: desde la vista del pedido ya no queda un camino de un clic al historial (antes lo daba el menú). Si el dueño lo quiere, añadir «Historial de órdenes» al HeaderActions de esa vista; hoy se llega por «Todos los pedidos» y luego «Historial».

## P2

### P2-1. `e2e/tests/stock-shortage-f8s2b.spec.ts` (test nuevo de D-618): `getByText('Pedidos con faltante')` puede violar strict mode

El mosaico del Panel se llama «Pedidos con faltante» y `OrdersShortfallCard` (`orders-shortfall-card.tsx:35`) titula su tarjeta igual. Si la base compartida tiene algún pedido confirmado con faltante (otros specs los dejan; es justo el caso que la tarjeta muestra), el locator resuelve a 2 elementos y Playwright lanza strict-mode violation. Corrección: acotar a la sección «Para atender hoy», o usar `.first()`, o buscar el enlace del mosaico por rol.

### P2-2. `e2e/tests/estandar-tablas-cc47.spec.ts` (Ventas y margen): fechas fijas

Usa `from=2026-10-01&to=2026-10-07` y espera «Filtros, 1 activo». Hoy (2026-10-11) pasa. El 2026-10-07 exacto «Este mes» (01..hoy) coincidiría con el rango y el botón diría «Filtros» sin contador. Riesgo bajo; derivar las fechas de `businessToday()` (por ejemplo un rango de dos años atrás) lo elimina.

## P3

1. Cobranzas, vendedor: el disparador de la pestaña «Por cliente» se muestra a todos los roles; el vendedor (403 en `/invoicing/receivables`) puede abrirla (o con `?tab=cliente`) y ve el error. No es regresión (antes la sección existía igual y daba 403), pero conviene ocultar la pestaña si no es administrador.
2. `ReceivablesTab`: para el vendedor `HeaderActions` queda vacío y `TableToolbar` pinta un `div` vacío (hueco por el `gap-2`). Renderizar la toolbar solo si `isAdmin`.
3. `FiltersDialog`: «Limpiar» no limpia el buscar (la E2E lo asume: «el buscar queda»). Es coherente con «limpia filtros», pero el pedido no lo dice; confirmar con el dueño. En Ventas y margen, «Limpiar» vuelve a «Este mes» y lo guarda en la sesión, pisando el periodo recordado para los demás reportes; es coherente con «el periodo se mantiene», solo conviene saberlo.
4. `sales-queries.ts:28` sigue invalidando `['quotation-stock-shortages']`, clave que nadie consulta ya (inocuo; limpiar junto con el endpoint pendiente). Comentarios de `orders-shortfall-card.tsx` y `price-floor-summary-card.tsx` aún citan `StockShortagesCard`.
5. El código cita D-612..D-618 pero este commit no trae esas filas en `docs/ARQUITECTURA.md` §0.2 (se asume que llegan en el cierre; AGENTS.md exige registrarlas).
6. `listas-scroll-cc35.spec.ts`: queda `for (const el of [pager])`, un bucle de un elemento; simplificar.

## Revisado y sin hallazgos

- **D-612 menú.** `nav.ts` quita los dos ítems; `OFF_MENU_SCREENS` conserva ruta, roles y grupo para la barra de ruta (`breadcrumb.ts`) y «Ir a» (`go-to.ts`). Ningún rol queda sin camino: administrador y planta llegan a `/produccion` por Planta, «Historial de órdenes» (ver P1-2 para el matiz) y por el pedido; los tres roles llegan a Colores por la pestaña de `/catalogo`. `menu-por-rol.spec` (31/15/12) y `docs/manual/menu-por-rol.md` están alineados (33-2, 17-2, 13-1). En `nav.spec`, `reach()` compara con `ALL` en el mismo orden `[ADMIN, PLANTA, VENDEDOR]`, correcto. `go-to.spec` y `breadcrumb.spec` nuevos son válidos; `correcciones-03` actualizado coherente.
- **D-613.** `list-footer.tsx` borrado y sin referencias; en cada vista se retiraron también los cálculos huérfanos (`pageTotal`, `pageBalance`, `balanceColumn`, import de `Decimal`); `filterLabel`, `columnCount`, `formatAmount` y `shownCount` siguen en uso, no quedan variables sin usar. Los pies de reportes, ventas-material, flejes y detalles son totales reales, no la franja «N de M», y se conservan. E2E ajustadas (`1+5` filas, `tfoot` en 0).
- **D-614.** `COIL_BUSINESS_LINES = [drywall, metallic-roofing]`: UPVC y Reventa ocultan «Bobinas por tipo»; si llegara una bobina con saldo en otra línea se muestra igual (decisión defendible y comentada). El texto del resumen se ajusta.
- **D-615/D-616.** Componente compartido `table-toolbar.tsx` con el orden buscar, Filtros, estado, aside. Modal con borrador, Aplicar y Limpiar, validación, descarte al cerrar sin aplicar, contador dentro del `aria-label` (contiene el texto visible «Filtros»), `role="alert"` para el error; Radix aporta foco y Esc. Los `Segmented` son `type="button"` y no envían el formulario. Estructura de Ventas y margen: título, pestaña de línea, totales, línea estándar, tabla, totales por línea en `Section` (franja gris). El Excel sigue recibiendo `searchText` y el periodo; buscar y periodo viven en la URL (`useUrlSearchInput`, `useReportPeriod`) y el periodo se mantiene entre reportes por la sesión.
- **D-617.** Cobranzas con pestañas en la URL (`useUrlTab`: push al historial, defecto sin escribir); «Comprobantes con saldo» con buscar y Filtros (tipo, origen) en servidor y el Excel con los mismos parámetros; «Por cliente» sin buscar ni Filtros porque el API no filtra y la tabla es paginada (la parada que pide D-617). Los prefijos `rPage/pPage` evitan colisiones.
- **D-618.** Se quitan query, mosaico y tarjeta; la grilla usa `lg:grid-cols-5` (5 mosaicos del administrador) o `lg:grid-cols-4` (4 del vendedor), sin hueco; `cn` ya estaba importado; el endpoint del API no se toca.
- **Unitarios.** Por lectura, `nav`, `menu-por-rol`, `go-to` y `breadcrumb` no deberían quedar rojos.
- **E2E nuevas.** `estandar-tablas-cc47.spec.ts` prueba lo que dice (pestaña en URL, buscar, foco en el modal, Esc sin aplicar, contador, Excel con filtros, recarga, Limpiar, retroceso; periodo en el modal, rango inválido, ausencia del grupo «Periodo» fuera del modal; Bobinas por tipo y ausencia de `tfoot`). Los helpers `openFilters`, `applyPeriodPreset` y `expectPeriodPreset` son correctos; `reportes-plantilla-cc32` y `reportes-seis-cc32` cambian solo donde el periodo de Ventas y margen se elige ahora en el modal; los otros reportes siguen con `PeriodPicker` y sus specs no se tocaron, bien.

## Qué se hizo con cada hallazgo

- **P1-1 y P1-2:** corregidos antes del merge (el test del Panel comprueba que ya no se pide ni se pinta; el de planta busca «Historial de órdenes» después de volver a `/planta`).
- **P2 (strict mode y fecha fija):** corregidos (el texto se acota a «Para atender hoy» con `exact`; el rango de prueba es de 2025).
- **P3:** la pestaña «Por cliente» ya no se le muestra al vendedor; el comentario de `use-url-tab` se corrigió. Se anotan: «Limpiar» deja el buscar; en Ventas y margen «Limpiar» vuelve a «Este mes» y eso queda recordado; la invalidación `quotation-stock-shortages` y el endpoint quedan para la limpieza de API.
