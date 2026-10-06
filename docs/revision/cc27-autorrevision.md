# cc27 — autorrevisión

> **Esto es una autorrevisión** (AGENTS.md §2, regla 2.1): la hizo un subagente nuevo que no leyó el
> handoff de implementación de cc27. Es una **lista de riesgos, no una aprobación**, y no vale como
> pase cruzado. La revisión del segundo modelo y la del dueño siguen pendientes.

- Rama: `cc27-ux`, diff `origin/main...HEAD` (commits `49bd430e`..`39a34a2b`, sobre `aa36d935`).
- Alcance revisado: M1 (D-452, mostrador con IGV), M2 (D-453, vista previa de los cierres de
  planta), M3 (nombres accesibles, `StickyActionBar`, `useUnsavedChanges`, cookie del menú,
  desborde de tablas), M4 (D-457, Panel del vendedor).
- Corrido: `jest src/pos/pos-math.spec.ts src/reports/seller-dashboard.spec.ts
src/reports/reports.controller.spec.ts` (3 suites, 33 tests, verdes) y `vitest run
src/lib/pos-pricing.spec.ts src/lib/menu-por-rol.spec.ts` (2 archivos, 11 tests, verdes). No se
  corrió E2E ni build.

## Lo que se comprobó y no dio hallazgo

- **La vista previa no confirma nada por las rutas leídas.** `previewPlantClose` corre `run` dentro
  de `prisma.$transaction` y lanza `PreviewRollback` siempre; si no lanzara, cae al `throw new
Error(...)` del final (no devuelve un resumen de algo confirmado). Dentro de `closeInTx` (drywall y
  coberturas), `reportInTx` y `commitInTx`, todas las escrituras van por `tx`: `inventory.record`,
  `inventory.adjustCost`, `inventory.lockInOrder`, `coils.lockCoil`, `audit.write(tx, …)`,
  `autoTerminateEmptyCoils(tx, …)`, `consumeReservationQty`, `releaseRemainingReservation`. Los
  `this.prisma` que quedan en `InventoryService`/`CoilsService` son lecturas de otros métodos. No hay
  `audit.log` (que escribe por `this.prisma`), pg-boss, R2 ni PSE en esas rutas. La clave de
  idempotencia no se reclama en la vista previa (`claimIdempotencyKey` vive fuera de `*InTx`).
- **El refactor `commitInTx`/`closeInTx` es mecánico:** el cuerpo de `commit` (roofing-drafts) y de
  `close` (drywall) se movió tal cual; el reclamo de la clave, los `timeout`/`maxWait` y el
  `findOne` final se quedaron en el método público. `git diff -w` no muestra cambios de lógica.
- **Roles de los endpoints `…/preview`:** heredan el `@Roles(ADMINISTRADOR, SUPERVISOR_PLANTA)` de
  la clase, igual que la acción real.
- **Mostrador, total = comprobante:** el web arma la línea con `lineAmounts` de `@ayr/shared` con la
  misma base que el API (`unitValuePen` si el precio no se tocó, `unitPriceWithIgvPen` si se tipeó;
  `amountBasisOf` en `sales-lines.ts`), y el comprobante del POS factura la línea entera a su precio,
  así que copia el importe del pedido (`partKind`, D-169). El pie usa `roundDocumentTotals` como
  `sumLineTotals`. El `refine` impide mandar los dos precios.
- **Alcance del Panel del vendedor:** `@Roles(VENDEDOR)` en el método; comprobantes con
  `fiscalDocumentListWhere` (el mismo `AND` por vendedor de su lista, `archivedAt: null`), y
  cotizaciones con `quotationSellerWhere`. Sin costos ni márgenes. `Decimal` en la suma.
- Rótulos «con/sin IGV» verificados contra el dato: `price-floor-summary-card` y
  `price-list-history-dialog` sí reciben valores con IGV (`catalog.service.ts:751`, `priceLabel`).

## Hallazgos

### A-1 · P1 · La entrada centinela de «atrás» queda en el historial cuando el formulario vuelve a estar limpio

`apps/web/src/lib/use-unsaved-changes.ts:66-79` (y los usos en
`apps/web/src/components/catalog/product-dialog.tsx:194`,
`apps/web/src/components/sales/sales-document-form.tsx:851`,
`apps/web/src/app/(app)/compras/purchase-form.tsx:319`,
`apps/web/src/app/(app)/despachos/nuevo/nuevo-despacho-view.tsx:342`).

Al ensuciarse, el hook apila una entrada con la misma URL y **nunca la quita**. Cuando `dirty` pasa a
`false` el efecto solo quita los listeners; la centinela sigue arriba en el historial.

Escenarios que el usuario va a encontrar:

1. **Catálogo:** edita un SKU en `ProductDialog` (dirty → centinela), guarda o cierra el diálogo
   (`open` → `false`). En `/catalogo`, el primer «Atrás» del navegador no hace nada visible (va de la
   centinela a la misma URL); hay que apretarlo dos veces. Pasa en **cada** edición de producto.
2. **Cotización/pedido/compra guardados:** historial `[A, F, F′, Detalle]`. Desde el detalle,
   «Atrás» lleva al formulario vacío (recién montado) y el siguiente «Atrás» va a `F`, la misma
   pantalla: parece que el botón no funciona.
3. **«Cancelar» del formulario** (`router.back()` en `sales-document-form.tsx:1320`,
   `purchase-form.tsx:987`, `nuevo-despacho-view.tsx:794`): si el usuario escribió y borró (la
   huella vuelve a la de apertura, o `isDirty` de RHF vuelve a `false`), el primer clic en
   «Cancelar» no sale de la página.

Arreglo sugerido: marcar la centinela en su `state` (además del estado de Next, p. ej.
`{ ...history.state, __ayrUnsaved: true }`) y, en la limpieza del efecto cuando `dirty` pasa a
`false` sin que se esté saliendo, si `history.state?.__ayrUnsaved` es la entrada actual, consumirla
con `history.back()` ignorando ese `popstate`; y no usar la centinela en un diálogo
(`ProductDialog`): ahí basta `beforeunload`. Agregar al E2E de `ux-1366-cc27` el caso «guardar y
volver atrás» y «escribir, borrar y Cancelar».

### A-2 · P2 · Versión cruzada web nuevo / API viejo: el precio tipeado en caja se ignora en silencio

`packages/shared/src/schemas/pos.ts:195-211`, `apps/web/src/app/(app)/pos/pos-view.tsx:141-145`.

El web nuevo manda `unitPriceWithIgvPen` **sin** `unitPricePen` cuando el cajero tipeó el precio.
El API anterior valida con `z.object` sin `.strict()`, que **descarta** la clave desconocida: la
línea queda sin precio explícito y se vende al **valor de lista**. El carrito mostraba otro total,
pero el cobro sale del comprobante (`pos.service.ts`, paso 6), así que se cobra un monto distinto
del que el cajero anunció. La ventana existe en la vuelta atrás automática de D-411 (API a la
revisión anterior mientras Vercel todavía sirve el web nuevo hasta que el revert del merge se
publique) o si el web saliera antes que el API.

Arreglo sugerido: dejarlo explícito en el runbook de la ventana (si se revierte la API, el web se
revierte **antes** de reabrir caja, o se bloquea el POS mientras tanto). Para adelante: `.strict()`
en `posSaleItemInputSchema` para que una clave desconocida sea 400 en vez de un precio distinto.

### A-3 · P2 · El layout de `(app)` lee `cookies()`: todas las pantallas pasan a render dinámico

`apps/web/src/app/(app)/layout.tsx:9-15`.

`cookies()` en el layout raíz del grupo vuelve dinámico todo el segmento: cada ruta de `(app)` deja
de prerenderizarse y cada navegación pide un render al servidor de Vercel (función, posible arranque
en frío) en vez de servir la carga estática. Es un cambio de costo y de latencia para toda la app,
por recordar el estado del menú.

Arreglo sugerido: medir antes y después (`next build` muestra `○`/`ƒ` por ruta). Si cambia, leer la
cookie en el cliente (estado inicial de `SidebarProvider` desde `document.cookie`, con el ancho
reservado para evitar el salto) o aceptar el costo como decisión registrada.

### A-4 · P2 · La garantía «la vista previa nunca escribe» no tiene test unitario, y el cierre de drywall no tiene ninguno

`apps/api/src/production/close-preview.ts` (sin `*.spec.ts`), `drywall-order-panel.tsx:159-172`.

La única prueba de que nada queda escrito es el E2E `planta-confirmar-cierre-cc27` y solo para
«Ejecutar y cerrar» de coberturas. «Cerrar … sin reportar más» pasa por el diálogo en
`planta-espacio-produccion-ui` (sin comprobar que «Volver» no escribe); «Reportar y cerrar» en
`tolerancia-accesorio-d389` (ídem); el **cierre de drywall** (`/production/:id/close/preview`) no lo
toca ningún spec. Si alguien agrega mañana una escritura por `this.prisma` o un efecto externo
(pg-boss, PSE) dentro de un `*InTx`, ningún test lo ve.

Arreglo sugerido: un spec unitario de `previewPlantClose` con `$transaction` simulado que compruebe
que (a) lanza y devuelve el resumen, (b) un `run` que no lanza termina en error, (c) los errores de
`run` salen tal cual; y un E2E de drywall «Volver deja kardex y orden intactos». Considerar un
centinela que falle si `close-preview.ts` o un `*InTx` usado por él referencia `this.prisma`.

### A-5 · P3 · Lo que se confirma puede no ser lo que se previsualizó

`apps/web/src/app/(app)/planta/roofing-order-panel.tsx:1140-1160`,
`accessory-report-card.tsx:430-450`, `drywall-order-panel.tsx:466-475`.

Al confirmar, el cuerpo se vuelve a armar con el estado de ese momento (`commitBody`,
`closeOnlyBody`, `reportBody`) y el API ejecuta el **borrador vigente**. El diálogo es modal, así
que el usuario no puede editar, pero otro usuario u otra pestaña sí puede agregar o quitar filas del
borrador de la misma orden entre la vista previa y la confirmación; se ejecuta algo distinto de lo
que se mostró, sin aviso.

Arreglo sugerido: que la vista previa devuelva una huella del borrador (ids + `updatedAt`) y que el
commit la reciba y rechace con 409 si cambió.

### A-6 · P3 · El «saldo actual» del resumen se lee antes de tomar los bloqueos

`apps/api/src/production/close-preview.ts:85-100`.

`coilStates(before)` se lee antes de que `run` tome `lockOrder`/`lockInOrder`. En READ COMMITTED,
un movimiento concurrente sobre la misma bobina que confirme entre esa lectura y el bloqueo entra en
`consumedKg = antes − después`, y el diálogo atribuye al cierre kilos que no son suyos. Solo afecta
al resumen, no al kardex.

Arreglo sugerido: tomar el bloqueo de la orden (`lockOrder`) antes de leer el estado previo, o
calcular `consumedKg` desde los movimientos que `run` emitió (`refId` de la orden y de los reportes
nuevos).

### A-7 · P3 · La vista previa toma los mismos `FOR UPDATE` que el cierre, con un presupuesto mayor

`apps/api/src/production/close-preview.ts:150` (`timeout: 120_000`), frente a `close` de drywall y de
coberturas (`timeout: 60_000`).

Cada vista previa bloquea orden, pedido, bobinas y saldos mientras corre, y se puede pedir
repetidamente (Volver / volver a abrir). Con varias personas en planta, una vista previa lenta
retiene al cierre o reporte real de otra orden que comparta bobina o producto.

Arreglo sugerido: el mismo `timeout` que la acción que imita (60 s para los cierres; 120 s solo
para el commit del borrador) y deshabilitar el botón mientras la vista previa corre (ya está) —
documentarlo en D-453.

### A-8 · P3 · El campo de precio del mostrador se siembra con cuatro decimales

`apps/web/src/lib/pos-pricing.ts:25-27`, `pos-view.tsx:183-187`.

La ficha muestra «S/ 11.81 con IGV» y el campo del carrito «11.8118» (el E2E lo fija así). El
cajero que reescribe lo que lee («11.81») cambia la base de la línea a precio tipeado y el total en
un céntimo (35.43 en vez de 35.44 para 3 unidades). Es coherente con lo que se cobra —el total se
recalcula a la vista—, pero el número del campo no es el que el cajero comunica.

Arreglo sugerido: decisión de presentación para el dueño (mostrar el campo con dos decimales y
conservar la base «de lista» mientras el valor redondeado coincida, o dejarlo como está y rotular).

### A-9 · P3 · «Agregar línea» vacía cuenta como cambio sin guardar

`apps/web/src/components/sales/sales-document-form.tsx:531-543, 851-854, 1286-1288`.

La huella incluye las líneas vacías; abrir «Nueva cotización» y apretar «Agregar línea» sin escribir
nada hace que salir pregunte. Falso positivo menor.

Arreglo sugerido: excluir de la huella las líneas sin producto, cantidad ni precio.

### A-10 · P3 · Re-ensuciar después de consumir la centinela deja «atrás» sin protección real

`apps/web/src/lib/use-unsaved-changes.ts:28-30, 74-79`.

`sentinel.current` queda en `true` una vez apilada. Si el formulario se limpió, el usuario consumió
la centinela con «Atrás» (sin aviso, porque estaba limpio) y después vuelve a escribir, no se apila
otra: el próximo «Atrás» sale a la página anterior, el `confirm` aparece cuando Next ya navegó, y
«Cancelar» en ese `confirm` apila una entrada de la página **anterior**, no restaura el formulario.

Arreglo sugerido: el mismo de A-1 (centinela marcada en `history.state`) permite saber si sigue
arriba y volver a apilarla al ensuciarse.

### A-11 · P3 · Región de desborde de tablas: nombre repetido y franjas en modo oscuro

`apps/web/src/components/ui/table.tsx:44-52`, `apps/web/src/app/globals.css:197-219`.

- Todas las tablas que desbordan son `role="region"` con el **mismo** `aria-label`; una página con
  dos tablas anchas tiene dos landmarks idénticos (axe `landmark-unique`), y la lista de regiones de
  un lector de pantalla no distingue cuál es cuál.
- Las capas `local` pintan `var(--background)`; en modo oscuro `--card` (`oklch(0.205 0 0)`) es
  distinto de `--background` (`oklch(0.145 0 0)`), así que una tabla dentro de una `Card` muestra
  franjas oscuras fijas en los bordes. Además, las filas con fondo propio (hover, seleccionada)
  tapan la sombra.

Arreglo sugerido: `aria-labelledby` hacia el título de la tabla cuando exista (o el nombre de la
tabla + «, desplazable»), y un token de fondo heredable (`--table-bg`, por defecto
`var(--background)` y `var(--card)` dentro de `Card`).

### A-12 · P3 · El E2E del Panel del vendedor no prueba el caso positivo

`e2e/tests/panel-vendedor-cc27.spec.ts:96-104`.

Fija `salesPen: '0.0000'` y `documentCount: 0`: prueba que los comprobantes de otros no suman, pero
nunca que los del vendedor **sí** suman ni que una nota de crédito resta (`seller-dashboard.ts`
solo tiene unitario de `assembleSellerDashboard`). Además deja un `SUPERVISOR_PLANTA` creado sin
limpiar. Definición para el dueño: «convertida» = `salesOrders: { some: {} }` cuenta también una
cotización cuyo pedido se anuló después.

Arreglo sugerido: emitir un comprobante del pedido del vendedor (en local/CI, D-126) y comprobar
`salesPen` y `documentCount`; registrar en D-457 qué pasa con el pedido anulado.

### A-13 · P3 · Decisiones citadas en el código que todavía no están en §0.2

Código y E2E citan D-452..D-457, pero `docs/ARQUITECTURA.md` §0.2 llega a D-451 y D-450 sigue
«provisional, pendiente del dueño» aunque M4 lo implementa como D-457. Tiene que quedar registrado
al cierre (modo autónomo de D-445: provisional y para el dueño).

### A-14 · P3 · El E2E de planta compara kilos con `Number`

`e2e/tests/planta-confirmar-cierre-cc27.spec.ts:209-246`.

`Number(consumed)`, `Number(after).toFixed(3)` y la resta `Number(coilBefore) - Number(coilAfter)`
operan kilos en coma flotante. Con estas magnitudes da bien, pero contradice D-003 y puede dar un
falso rojo con otros valores (p. ej. una resta que termine en ...0049999).

Arreglo sugerido: `toDecimal` de `@ayr/shared` para la resta y la comparación.

## Conteo

| Severidad | Cantidad |
| --------- | -------- |
| P0        | 0        |
| P1        | 1        |
| P2        | 3        |
| P3        | 10       |

## Resolución (sesión cc27)

- **A-1 (P1), corregido:** la centinela del historial lleva una marca en `history.state`; al quedar
  limpio el formulario (o al desmontarse) pasa a inerte y el «atrás» que cae debajo de ella sigue
  de largo una vez. Caso nuevo en `ux-1366-cc27`: escribir y borrar, y «atrás» sale con una sola
  pulsación.
- **A-3 (P2), corregido:** el menú lee su cookie en el cliente (`useLayoutEffect` en
  `SidebarProvider`); el layout vuelve a ser estático (45 rutas `○` en el build, como en `main`).
- **A-4 (P2), corregido:** `close-preview.spec.ts` fija que la vista previa resume el estado
  intermedio y nunca confirma, y que el rechazo de la acción sale tal cual.
- **A-8 (P3, trivial), corregido:** el precio del carrito se siembra al céntimo (11.81) y ese número
  sigue viajando por el valor de lista.
- **A-11 (P3), en parte:** el contenedor con desborde es un grupo, no una región (sin
  `landmark-unique`). Las bandas del modo oscuro sobre tarjetas quedan en PROGRESO.
- **A-13:** D-452..D-457 escritas en `docs/ARQUITECTURA.md` §0.2.
- **A-2 (P2):** se mitiga con el orden de la ventana (API antes que la web) y queda anotado en el
  handoff; `.strict()` en el esquema queda en PROGRESO.
- **A-5, A-6, A-7, A-9, A-10, A-12, A-14 (P3):** en PROGRESO. A-10 queda cubierto por la corrección
  de A-1 (la centinela se reusa si se vuelve a ensuciar).
