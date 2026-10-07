# Revisión de segundo modelo — cc31 corte 3

Revisor: Sonnet (contexto limpio). Fecha: 2026-10-07. Diff revisado: `cc31-c2...cc31-c3` (un commit, 35 archivos). Solo lectura; no se ejecutó la suite.

Resumen: 0 P0, 1 P1, 5 P2, 5 P3.

## P1

### P1-1. El E2E de densidad sigue exigiendo filas de 29 px y las listas ahora miden 38 px

- `e2e/tests/correcciones-03-densidad.spec.ts` (~línea 133): `expect(m.rowHeight).toBeLessThanOrEqual(29)` para `/cotizaciones`, `/pedidos` y `/bobinas?tab=todas`.
- Escenario: `apps/web/src/app/globals.css` fija `td { height: 38px }` en `[data-density='list']`, y `/cotizaciones` y `/pedidos` pasan `<Table list>`. La fila mide >= 38 px y el test falla. No se tocó en este commit.
- Arreglo: subir el umbral a 38 (más holgura de redondeo) para las listas con `list` y dejar en 29 solo las que no cambian (`/bobinas`). Si el piso de 29 sigue siendo la intención para bobinas, separar los dos umbrales.

## P2

### P2-1. Textos al usuario que aún dicen «⋯»

El menú ahora se llama «Más opciones» y ya no es un icono.

- `apps/web/src/app/(app)/comprobantes/[id]/comprobante-detalle-view.tsx:874`: «usa «⋯ → Traer comprobante anulado»».
- `apps/web/src/app/(app)/pedidos/[id]/pedido-detalle-view.tsx:568`: «usa «Completar reserva» en el menú ⋯».
- Arreglo: «Más opciones → Traer comprobante anulado» y «en «Más opciones»». Ningún E2E depende del texto (grep sin coincidencias).

### P2-2. Despacho: se perdió la columna «Material» (Bobina / Producto)

- `despacho-detalle-view.tsx`, tabla «Qué salió»: se eliminó la columna y su celda `item.itemType === 'COIL' ? 'Bobina' : 'Producto'`. No aparece en el resumen ni en otra parte.
- Escenario: un despacho de reventa de bobina entera ya no se distingue de uno de producto. Es información que se mostraba y ya no.
- Arreglo: devolverla, o marcar la bobina en la descripción de la línea («Bobina»), o confirmar con el dueño que se quita.

### P2-3. Comprobantes: la suma del pie mezcla tipos y estados

- `comprobantes-view.tsx` (`pageTotal`): suma `totalPen` de todas las filas de la página. Con «Todos» o «Anulados» entran notas de crédito (suman en positivo si el DTO las trae positivas; no se verificó el signo), guías de remisión (cero) y anulados.
- La cabecera dice «Total (S/)» y el pie «N de M comprobantes …», así que la cifra se lee como un total facturado.
- Arreglo: sumar solo cuando el filtro de tipo deja un solo tipo, o excluir NC y anulados de la suma. Si se deja, rotularla («Suma de la página»). Aplica en menor grado a pedidos y cotizaciones con el chip «Anulados».

### P2-4. Corte y flejes: valores inválidos en la URL llegan al API

- `corte-view.tsx` y `flejes-view.tsx`: `url.line` y `url.status` se castean a enum sin validar. Con `?line=xx` se manda `businessLine=xx`, el API responde 400 y el select queda con un valor sin opción.
- Inventario sí lo resuelve (`STOCK_LINES.find`).
- Arreglo: validar contra `BUSINESS_LINES` y `CUTTING_ORDER_STATUSES` y caer en `ALL`.

### P2-5. Catálogo: `?tab=` con un código desconocido cae en la primera línea sin avisar

- `catalogo-view.tsx`: `lines.data?.find(l => l.code === url.tab)?.id ?? highlightedLineId ?? firstLine?.id`. No es un fallo, pero un `?tab=` inválido deja la URL sucia. Comprobado que `?bajoPiso=<id>` sigue abriendo la línea del producto, y que elegir la primera línea con un resaltado activo escribe `tab`. Sin cambio obligatorio.

## P3

- P3-1. `section.tsx`: el contador lleva `aria-label="3 filas"` en un `<span>` sin rol. Axe lo marca (`aria-prohibited-attr`) y el nombre accesible ya no coincide con el texto visible. Arreglo: quitar el `aria-label` y dejar `<span><span aria-hidden>3</span><span className="sr-only">3 filas</span></span>`.
- P3-2. `bobina-detalle-view.tsx:547`: el contador del kardex usa todos los movimientos (`movements.data.items.length`), pero la tabla muestra solo los últimos 10 (`slice(-10)`). Dice «40» y se ven 10. Arreglo: contar `movementRows.length` o rotularlo.
- P3-3. `globals.css`: `[data-slot='section'] [data-slot='table'] ... td { height: 34px }` también alcanza a las tablas de `produccion/[id]` y `production-orders-card` (usan `Section`), no solo a los cinco detalles. El comentario promete que las tablas de planta no cambian.
- P3-4. `pedido-detalle-view.tsx`: la fecha prometida se muestra como texto y de nuevo como `<Input type="date">` (admin) en el mismo bloque. Es redundante; el `Input` es no controlado (`defaultValue`), como antes.
- P3-5. `header-actions.tsx`: el comentario del encabezado sigue diciendo «menú «⋯»». `pedidos-view.tsx` (`filterLabel`): con una URL `?stage=` de varios estados activos muestra «en curso», que no es exacto.

## Verificado sin hallazgo

- Acciones de cabecera: las listas y los detalles conservan `show`/roles. Clientes y proveedores: «Nuevo …» sale solo con `isAdmin`; un no admin ve únicamente «Más opciones» (Excel). Proveedores sin admin devuelve `null` (`visible.length === 0`). Los diálogos de alta siguen abriendo por `openDialog()` y por `autoOpenNew`.
- Descargas PDF/XML/CDR: `show` = `hasPdf/hasXml/hasCdr`, sin restricción de rol (el `HeaderActions` no está dentro de un guard de admin). Pasan por `downloadFile` (fetch). El API manda `Content-Disposition: attachment; filename=...` y `Content-Type`, y `filenameFromDisposition` lo respeta. El nombre de reserva (`pdf`/`xml`/`cdr`) solo aplicaría sin cabecera. Un 401 refresca la sesión y un rechazo sale como aviso, mejor que antes. Los clics con modificador siguen en el navegador.
- Sumas del pie: Decimal (`new Decimal(0).plus`), con `formatAmount` al final. Índices de columna comprobados contra las cabeceras: comprobantes 6 o 7 con la columna «Pedido» (`columnCount` 9/10 más 1), cotizaciones 5 de 8, pedidos 5 de 8. `colSpan` restante = `colCount - amountColumn - 1`. Clientes 5/6, proveedores 7, compras 10, despachos 8 (solo cuentan). Los `hidden md:table-cell` cuentan en el `colSpan`, correcto en escritorio.
- `<Table list>`: solo lo usan las ocho listas de página. Ninguna tabla de diálogo ni página con dos tablas lo recibe. El `tfoot` sticky no tapa la última fila (`bottom: 0` dentro del contenedor con scroll; la regla va fuera de `@layer`, así que gana a `bg-muted/50`). La cabecera sticky ahora funciona.
- `onClearFilters`: comprobantes limpia búsqueda, estado, tipo, origen y saldo; compras limpia los cinco filtros; pedidos, cotizaciones y despachos, los suyos; clientes y proveedores, la búsqueda. Pedidos: `stage: ''` vuelve al default «en curso».
- Detalles: cliente y documento pasaron al resumen (pedido, cotización, comprobante, despacho). Claves de `DetailSummary` únicas en los cinco usos. `Stages` marca `aria-current` y lleva texto `sr-only` en las etapas hechas y la actual. El total está a la derecha. Etapas de pedido y cotización cubren todos los estados de los enums.
- Textos: tuteo correcto («Crea la primera», «Emite el primero», «Da de alta»), sin inglés ni códigos internos visibles.
- E2E: `headerAction` y los specs con «Más acciones» de cabecera se actualizaron. «Más acciones de <fila>» (RowActions) no cambió. Los conteos `getByRole('row')` de d387 suman el pie. Sin aserciones de texto de vacío/error, ni de «S/ » en listas, que se rompan. Solo queda P1-1.
