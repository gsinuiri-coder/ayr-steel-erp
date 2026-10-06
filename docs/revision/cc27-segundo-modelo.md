# Revisión de segundo modelo: cc27 (rama `cc27-ux`)

**Revisor:** segundo modelo (Sonnet), contexto limpio, sin haber escrito el código.
**Alcance:** `git diff origin/main...HEAD`, 5 commits (`49bd430e`..`39a34a2b`): POS con IGV (D-452), vista previa de cierres de planta (D-453), formularios a 1366 px / cambios sin guardar / nombres accesibles (D-454..D-456), Panel del vendedor (D-457). 61 archivos.
**Método:** lectura del diff completo y de los llamados aguas abajo (`InventoryService`, `reportInTx`, `closeInTx`, `fiscalDocumentListWhere`, `quotationSellerWhere`). No se corrieron builds, servidores ni Playwright.

## Veredicto resumido

No encontré defectos P0 ni P1. Lo que más riesgo tenía se verificó y se sostiene:

- **Vista previa de cierres (`close-preview.ts`).** `closeInTx`/`commitInTx` son el cuerpo anterior movido sin cambios de lógica (el diff de `production.service.ts` y `roofing-drafts.service.ts` es traslado más la reclamación de la clave de idempotencia, que queda en la acción real). La vista previa corre todo con el `tx` recibido, no con `this.prisma`; el único efecto fuera de la transacción son los contadores `autoincrement`, ya documentados y que nada lee por contigüidad (los `seq` de reporte solo se usan con `gt` para ordenar). `PreviewRollback` se lanza siempre dentro del callback, así que Prisma revierte y relanza el mismo error; el `throw` final es defensivo. El trigger append-only de kardex no interfiere con un `INSERT` revertido.
- **Autorización de los `/preview`.** Heredan el `@Roles(ADMINISTRADOR, SUPERVISOR_PLANTA)` de la clase, igual que las acciones reales. Orden de bloqueos: es el mismo código, el de D-386.
- **POS.** El API solo reenvía `unitPriceWithIgvPen` a `createDirectInTx` (mismo camino que la cotización); el esquema rechaza ambos precios a la vez; el cobro sale del total del comprobante, no del carrito. El cálculo del web usa `lineAmounts`/`roundDocumentTotals` de `@ayr/shared` (D-377: se redondea la suma).
- **Panel del vendedor.** El endpoint es `@Roles(VENDEDOR)` (ADMIN recibe 403, el web ni lo consulta) y el alcance lo pone el servidor con las mismas funciones que las listas. No expone costos.
- **Servidor/cliente.** `SIDEBAR_COOKIE_NAME` está en un módulo sin `'use client'`, bien; `await cookies()` es válido en Next 15.

## Hallazgos

### SM-1 — P2 — E2E existente roto por el cambio de texto del aviso «por metro»

`apps/web/src/components/sales/sales-document-form.tsx` (`PricingUnitSwitch`, cambio de «por metro (equivalente a» a «por metro con IGV (equivalente a»), contra `e2e/tests/plancha-importada-d263.spec.ts:273` (`await expect(preview).toContainText('por metro (equivalente a')`).
**Escenario:** el spec D-263 no está en el diff y busca la subcadena vieja; el texto nuevo es `… por metro con IGV (equivalente a …`, que ya no la contiene. La suite completa falla en ese test (es un rojo de producto-selector, no de infraestructura).
**Arreglo:** actualizar la aserción a `'por metro con IGV (equivalente a'` (o a una subcadena que sobreviva, p. ej. `'(equivalente a'`). Conviene además grepear `e2e/` por los otros textos cambiados («Mínimo:», «Subtotal», «Total», «Antes/Después», «Valor unitario (sin IGV)»): no encontré más coincidencias fuera de los specs ya tocados, pero lo debe confirmar la corrida completa.

### SM-2 — P2 — La entrada centinela de «atrás» queda apilada cuando el formulario deja de estar sucio

`apps/web/src/lib/use-unsaved-changes.ts:~76-80` (`if (!sentinel.current) { pushState…; sentinel.current = true }`) y el `return` temprano `if (!dirty) return` (línea ~35).
**Escenario:** el usuario teclea algo (se apila una entrada con la misma URL), luego lo borra (la huella vuelve a `pristine`, `dirty=false`, se quitan los listeners, la centinela sigue en el historial y `sentinel.current` sigue en `true`). Al pulsar «Atrás» ahora no hay manejador: la pantalla no cambia y el usuario tiene que pulsarlo dos veces. Lo mismo tras guardar y navegar: el «Atrás» desde el detalle cae primero en la centinela (formulario vacío de la misma URL) y recién el siguiente sale. En `ProductDialog` (`useUnsavedChanges(open && isDirty)`) ocurre una vez por montaje de la página del catálogo, aunque el diálogo ya se haya cerrado.
**Arreglo:** al pasar a `dirty=false` sin haber salido, consumir la centinela (`history.back()` con una bandera para ignorar ese `popstate`), o no apilar nada y avisar solo con `beforeunload` + clic en enlaces, dejando «atrás» fuera de alcance; y documentar la limitación.

### SM-3 — P2 — Regiones con el mismo nombre accesible en páginas con varias tablas desbordadas

`apps/web/src/components/ui/table.tsx` (`Table`: `role: 'region'`, `aria-label: 'Desplazamiento horizontal: hay más columnas'`, constante).
**Escenario:** una página con dos o más tablas anchas a 1366 px (el detalle de pedido, la ficha de bobina, la planta) expone varios `region` con el mismo nombre: axe `landmark-unique` lo marca, y un lector de pantalla no distingue una de otra. El comentario del código lo hizo a propósito para que `getByRole('region', { name })` de una sección no encuentre dos, pero la solución traslada el problema a la unicidad. Además cada tabla desbordada suma una parada de tabulación.
**Arreglo:** nombrar la región con el `aria-label` de la tabla cuando exista (`Desplazamiento de «Consumo por bobina»`) y, si no, con `aria-labelledby` hacia su `caption`; o usar `role="group"`, que no entra en la regla de repetidos.

### SM-4 — P3 — «Cambios sin guardar» del despacho no ve los selectores

`apps/web/src/app/(app)/despachos/nuevo/nuevo-despacho-view.tsx` (`<div className="contents" onInput=…>`).
**Escenario:** cambiar solo el pedido, la modalidad o el tipo de documento (Radix `Select`, que no dispara `input`) no marca `typed`; si luego se sale, no hay aviso, aunque esos cambios reponen las cantidades sembradas. El propio comentario de `sales-document-form.tsx` reconoce este límite y por eso allí se compara una huella.
**Arreglo:** poner `setTyped(true)` en los `onValueChange` de los tres `Select`, o comparar una huella como en el formulario de ventas.

### SM-5 — P3 — Comentario de `reportAndClose` quedó pegado al método equivocado

`apps/api/src/production/roofing-production.controller.ts` (alrededor de las líneas 252-266): el JSDoc largo de «Reportar los últimos largos y cerrar en la misma transacción» ahora precede al comentario y al método `previewReportAndClose`, y `reportAndClose` queda con un comentario de una línea o ninguno.
**Arreglo:** mover `previewReportAndClose` encima del bloque del JSDoc largo.

### SM-6 — P3 — La conversión cuenta pedidos anulados y cotizaciones rechazadas o vencidas como «emitidas»

`apps/api/src/reports/seller-dashboard.service.ts`: `status: { not: DRAFT }` en emitidas y `salesOrders: { some: {} }` en convertidas.
**Escenario:** una cotización cuyo pedido se anuló sigue contando como convertida, y las rechazadas entran al denominador. Es coherente con la descripción del DTO («todas menos los borradores», «las que tienen pedido»), por eso no es defecto de cálculo; es una decisión de definición que el dueño debería ver (D-457 está como provisional).
**Arreglo:** si se quiere «convertida viva», filtrar `salesOrders: { some: { status: { not: CANCELLED } } }`; si no, dejar nota en la tarjeta.

### SM-7 — P3 — `leaving` queda en `true` tras un clic aceptado que no navega

`apps/web/src/lib/use-unsaved-changes.ts` (`onClick`): al aceptar el `confirm` se fija `leaving.current = true`, pero solo se reinicia al cambiar `dirty`.
**Escenario:** un enlace interno con un manejador posterior que hace `preventDefault()` (abre un diálogo en vez de navegar) deja el formulario sin protección hasta que `dirty` cambie. No encontré un enlace así en los formularios que usan el hook.
**Arreglo:** reiniciar `leaving` con un `setTimeout(0)` o en el siguiente `pathname` observado.

### SM-8 — P3 — La vista previa toma los candados de la acción real sin límite de ráfaga

`apps/api/src/production/close-preview.ts` (`$transaction` con `timeout: 120_000`).
**Escenario:** cada clic en «Ejecutar y cerrar» abre una transacción interactiva que hace `FOR UPDATE` sobre la orden, la bobina y los saldos; los clics repetidos o dos supervisores serializan sobre esas filas y ocupan conexiones del pool hasta terminar. El web deshabilita el botón mientras calcula, así que el riesgo es bajo, pero el API no tiene límite propio.
**Arreglo:** bajar el `timeout` de la vista previa (p. ej. 20 s: es una lectura) para que una espera larga falle rápido en vez de retener conexión.

## Conteo

| Severidad | Cantidad                         |
| --------- | -------------------------------- |
| P0        | 0                                |
| P1        | 0                                |
| P2        | 3 (SM-1, SM-2, SM-3)             |
| P3        | 5 (SM-4, SM-5, SM-6, SM-7, SM-8) |

Esta es una **revisión de un modelo, no de una persona**: no sustituye la revisión del dueño al cierre ni da por independiente ningún pase anterior (AGENTS.md §2.2).

## Resolución (sesión cc27)

- **SM-1 (P2), corregido:** `plancha-importada-d263.spec.ts` espera «por metro con IGV (equivalente a».
- **SM-2 (P2), corregido:** es el A-1 de la autorrevisión; la centinela inerte se salta sola.
- **SM-3 (P2), corregido:** el contenedor con desborde es `role="group"`, no una región.
- **SM-5 (P3, trivial), corregido:** el JSDoc de `reportAndClose` volvió a su método.
- **SM-7 (P3):** en PROGRESO (el `leaving` ahora vive por montaje del efecto, pero un clic aceptado que no navega lo deja en `true` hasta que el formulario cambie).
- **SM-4, SM-6, SM-8 (P3):** en PROGRESO; SM-6 es una definición para el dueño (D-457).
