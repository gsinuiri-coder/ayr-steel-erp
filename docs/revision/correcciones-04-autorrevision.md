> **AUTORREVISIÓN — pendiente de revisión independiente.** Hecha por un subagente nuevo del mismo modelo que escribió el cambio; no vale como pase cruzado (AGENTS.md §2.2).

# Autorrevisión de correcciones 04 (rama `fix/correcciones-04`)

## Alcance revisado

`git diff 86d8db0..HEAD`, seis commits:

- `85f2611` fix(sales): M0.1 (`kardexCustomPatch`), M0.2 (`addItems` con `coilTies`), M0.3 (`duplicate` + `unassignedCoilProducts` + `warnings[]`).
- `a67926f` feat(web): M1, orden por columna (`sortQueryFields`, `listOrderBy`, `useSort`, `sortRows`, `SortHead`, ~20 vistas).
- `5d7fa8c` fix(planta): M2, popover «+N» del historial.
- `3fd596c` refactor(produccion): M3, se quita la sección de bobinas montadas del detalle.
- `90aa429` feat(web): M4, mapa del menú, `isItemActive`, `?tab=colores`.
- `c0b0d80` feat(web): M5, `RowActions`.

Método: lectura del diff y del código circundante; corrí solo `jest` de `list-sort.spec.ts` y `quotation-duplicate-coil-d322.spec.ts` (7 pruebas verdes) y `vitest` de `sort-rows.spec.ts` (4 verdes). No corrí Playwright, builds ni lint. No leí el handoff de implementación. Todo lo marcado «por lectura» no fue ejecutado.

Resumen: **1 P0, 2 P1, 9 P2.**

---

## P0

### P0-1 — Catálogo y Colores comparten `?sort=`; una clave que la otra tabla no declara tumba la pantalla `/catalogo`

- `apps/web/src/lib/sort-rows.ts:19-28` (`accessors[sort.key]` sin guarda, luego `'text' in accessor`).
- `apps/web/src/app/(app)/catalogo/catalogo-view.tsx:102` y `:204`; `apps/web/src/app/(app)/catalogo/colores-panel.tsx:90` y `:148`.

`CatalogoView` llama `useSort<'sku'|'name'|'unit'|'status'|'price'>()` y `ColoresPanel` llama `useSort<'code'|'name'|'status'>()`, los dos sin prefijo: leen el mismo `?sort=`/`?dir=`. Además `CatalogoView` ejecuta `sortRows(...)` para **todas** las líneas dentro del `.map` de render (`:196-210`), aunque su `TabsContent` no esté activo.

Escenarios (entradas → resultado):

1. Pestaña «Colores», clic en el encabezado «Código» → URL `?tab=colores&sort=code`. En el render siguiente `CatalogoView` hace `sortRows(productosDeLaLínea, {key:'code'}, {sku,name,unit,status,price})`; `accessors['code']` es `undefined`; con 2 o más productos el comparador ejecuta `'text' in undefined` → `TypeError` → cae la pantalla entera (error boundary). Ocurre con la primera línea que tenga 2 productos.
2. Pestaña de una línea, clic en «SKU» (`?sort=sku`) y luego pestaña «Colores»: `setUrl({tab:'colores'})` no toca `sort`; `ColoresPanel` recibe `key:'sku'`, `accessors['sku']` es `undefined` y con 2 o más colores hay `TypeError`. Lo mismo con `unit` y `price`.
3. Cualquier vista con `sortRows` y una URL `?sort=cualquiercosa` (enlace viejo, pegado a mano, o D-289 anterior) hace el mismo `TypeError`; `useSort` castea la cadena de la URL a `K` sin validar.

La E2E `orden-columnas-d323.spec.ts` solo hace clic en «SKU» y comprueba la URL; no cambia de pestaña ni ordena colores.

Recomendación: (a) `sortRows` debe devolver las filas tal cual si `accessors[sort.key]` no existe; (b) mejor aún, que `useSort` reciba la lista de claves válidas y trate una clave ajena como `null`; (c) en el catálogo, usar prefijo distinto para Colores (`useSort('c')`) o borrar `sort`/`dir` al cambiar de pestaña; (d) añadir prueba unitaria de `sortRows` con clave desconocida y E2E «ordenar SKU → pestaña Colores».

---

## P1

### P1-1 — Una E2E no modificada afirma lo contrario del nuevo menú y va a fallar

`e2e/tests/planta-cola-f8s3-ui.spec.ts:197-200` (por lectura).

El test, en `/planta`, espera `getByRole('link', { name: 'Órdenes de producción', exact: true })` con `toHaveCount(0)` («ya no está en el menú», D-190). M4 (D-326) devuelve «Órdenes de producción» a `NAV` bajo «Planta». En `/planta` el ítem «Producción» está activo, así que el grupo Planta se abre solo (`app-sidebar.tsx:54`) y el enlace es visible: el conteo es 1. El archivo no está en el diff. El comentario y la aserción son obsoletos.

Recomendación: cambiar la aserción a `toHaveCount(1)` (o quitarla) y actualizar el comentario; buscar otras aserciones de ausencia de ítems de menú (no encontré más con `grep` de nombres de enlace).

### P1-2 — Cobranzas ordena solo la página aunque sus dos tablas están paginadas por el servidor, y no lo dice

`apps/web/src/app/(app)/cobranzas/cobranzas-view.tsx:87-115` (comentario y `sortRows`), paginación en `:253-256` y `:382-385`.

El comentario dice «las dos tablas muestran su lista entera; el orden por columna es sobre todas las filas». No es cierto: `/invoicing/receivables` y `/invoicing/documents?pendingOnly=true` llevan `page`/`pageSize` y el orden es sobre `items` de la página actual. Escenario: 120 comprobantes pendientes, tamaño 50; ordenar «Saldo» descendente reordena solo la página 1 y la página 2 sigue con su propio orden — exactamente lo que D-323 dice haber eliminado. No hay `title` que lo advierta (Pedidos y Bobinas sí ponen «Ordena las filas de esta página»). Para la tabla de pendientes el API ya acepta `sort` con `pendingOnly` (`invoicing.service.ts:3075-3120`) para `number`, `customer`, `issueDate`, `dueDate`, `total`; el web no lo usa. Además `useSort('r')`/`useSort('p')` borran `page`, pero estas tablas paginan con `rPage`/`pPage`, así que ordenar no vuelve a la primera página.

Recomendación: para «pendientes», mandar `sort`/`dir` al API en las columnas que declara y dejar `paid`/`balance` como orden de página con `title`; para «por cobrar» (sin `sort` en el API) poner el `title` de página. Corregir el comentario.

---

## P2

### P2-1 — Compras: «Comprobante» ordena solo por serie y «Total» ordena por soles mientras muestra la moneda del documento

`apps/api/src/purchases/purchases.service.ts:1148` y `:1153`.
`number: (d) => ({ series: d })`: la columna muestra `documentLabel` (serie-número). Ordenar «Comprobante» agrupa por serie y, dentro de cada serie, cae al orden por fecha de emisión, no por correlativo. `total: totalPen` ordena por PEN, pero la fila muestra `formatMoney(p.total, p.currency)`; con USD y PEN mezclados la columna no se ve monótona. Recomendación: `[{ series: d }, { number: d }]` (la función devuelve un objeto; el tipo admite un arreglo en `orderBy` si `listOrderBy` acepta fragmentos múltiples) y, o bien ordenar por `totalPen` con un `title`, o aceptar el desfase y decirlo.

### P2-2 — «Estado» ordena por el enum guardado, no por lo que se ve

`quotations.service.ts:997` (`status: (d) => ({ status: d })`), `invoicing.service.ts:3090` (`status`), `purchases.service.ts:1154`; `pedidos-view.tsx:118` (`compareBy(sort.dir, x.stage, y.stage)`).
Cotizaciones muestran el estado efectivo (`effectiveStatus`: una `EMITTED` vencida se pinta «Vencida»), pero el servidor ordena por el estado guardado: filas «Vencida» quedan mezcladas entre «Emitida». El orden de un enum Postgres es el de declaración, no el alfabético de la etiqueta. En pedidos el orden de página compara el código de etapa en inglés, no la etiqueta. Recomendación: documentarlo en el `title` del encabezado o retirar «Estado» de las claves ordenables.

### P2-3 — El menú marca dos ítems activos en `/catalogo`

`apps/web/src/components/app-sidebar.tsx:29-36`.
`isItemActive` compara solo `pathname`; «Productos» (`/catalogo`) y «Colores» (`/catalogo?tab=colores`) quedan ambos con `isActive` en las dos pestañas. Recomendación: para el ítem con `?tab=` mirar también `useSearchParams()`, o marcar «Productos» activo solo si `tab !== 'colores'`.

### P2-4 — M3 retira también la sección «Flejes consumidos por la orden» (drywall) y con ella datos que no están en otro lugar

`apps/web/src/app/(app)/produccion/[id]/produccion-detalle-view.tsx:280-284`.
La sección tenía título condicionado por `o.kind`: para ROOFING «Bobinas montadas en la orden» y para las demás «Flejes consumidos por la orden». Se quitó para los dos tipos. Con ella desaparecen para drywall las columnas Asignado / Consumido / Pendiente / «Liberado» o «Tomado por la orden» (`o.consumptions`), que la tabla de reportes no reproduce. La E2E `correcciones-03-listas-kardex.spec.ts:403` confirma que se retiró a propósito para ambos textos, pero el encargo de M3 nombraba solo «Bobinas montadas». Recomendación: confirmar con el dueño que el alcance incluía los flejes de drywall; si no, restaurar la rama `kind !== ROOFING`.

### P2-5 — `duplicate` de una cotización confirmada con bobina entera sigue rechazándose (cobertura parcial de D-322)

`apps/api/src/sales/quotations.service.ts:541-563` y `sales-lines.ts` (`resolveSaleCoils`, «no tiene saldo disponible para vender») — por lectura, no ejecutado.
`findCoilTies` solo mira cotizaciones `DRAFT`/`EMITTED`. Si la original está `CONFIRMED`, su bobina queda reservada por el pedido: no hay «atadura», la línea viaja como `saleCoilId`, y `resolveSaleCoils` calcula `físico − reservado ≤ 0` y responde 400. Igual con bobina montada en una OP o ya cerrada sin saldo. El E2E de D-322 cubre solo la original abierta. Recomendación: extender el mismo retroceso (línea `BOB…` sin bobina + aviso) a estos motivos, o dejar el 400 documentado como decisión.

### P2-6 — El aviso de `duplicate` numera con la línea de la original y, a un VENDEDOR, le confirma que «otro documento» tiene la bobina

`quotations.service.ts:585-590`.
(a) `Línea ${i.lineNumber}` es el número en la original; la copia se renumera desde 1. Si la original tuviera huecos de numeración el aviso apuntaría a otra línea. (b) Alcance por vendedor (D-267/D-275): revisado, **no se filtra el número** de una cotización ajena (`coilTieReasons` devuelve `'no disponible'` y el texto pasa a «tomada por otro documento»; la prueba unitaria lo cubre). El texto sí admite que existe otro documento; el resto del sistema evita confirmarlo (`assertCoilsNotTied` no añade detalle en ese caso). Recomendación menor: usar el índice de la copia y el mismo texto neutro.

### P2-7 — Una `sort` inválida en la URL devuelve 400 y la lista muestra error

`packages/shared/src/schemas/pagination.ts` (`z.enum(keys)`) y las vistas de servidor (`clientes`, `cotizaciones`, `pedidos`, `compras`, `comprobantes`, `despachos`, `bobinas`).
`useSort` no valida la clave de la URL; una URL guardada con la `?sort=` de la versión cliente-solo de D-289 (p. ej. otra clave en cotizaciones/pedidos) manda `sort` al API y el listado responde 400. No hay inyección: el `orderBy` solo se arma con claves declaradas (verificado en `list-sort.ts` y en `listOrderBy` por clave). Recomendación: la misma validación de claves de P0-1(b) en la vista antes de armar el `URLSearchParams`.

### P2-8 — `RowActions`: detalles de accesibilidad y de contrato

`apps/web/src/components/row-actions.tsx:38-44`, `:107-115`.

- Con una sola acción destructiva `main` es `null` y la acción va al menú, no queda como botón (el comentario dice «una acción sola queda como botón»).
- Los ítems de menú con `href` ignoran `ariaLabel` y `disabled`; el botón principal con `href` ignora `disabled`.
- Los botones principales sin `ariaLabel` (Catálogo, Clientes, Usuarios, Acabados, Colores…) siguen siendo «Editar» repetido sin contexto de fila para un lector de pantalla; solo pedido y planta pasan `ariaLabel`.
- El comentario del componente dice que las destructivas «siguen pidiendo su diálogo de confirmación»: «Quitar» del borrador en `roofing-order-panel.tsx` (`removeDraft.mutate(d.id)`) ejecuta sin confirmar (ya era así antes, pero ahora vive en rojo dentro de un menú que promete lo contrario). «Desactivar» usuario/cliente/proveedor/acabado/color/producto tampoco confirma (igual que antes).
- El aviso de acción en vuelo del menú es un `role="status"` que se monta con el texto ya puesto; algunos lectores no lo anuncian.

### P2-9 — Comentario de `ResolveSalesLinesOptions` desplazado

`apps/api/src/sales/sales-lines.ts:183-198`.
El nuevo JSDoc de `unassignedCoilProducts` se insertó entre el JSDoc de `coilTies` y su propiedad: quedan dos bloques seguidos y el de D-310 pasa a documentar `unassignedCoilProducts`; `coilTies` queda sin doc en el hover. Mover el bloque nuevo antes o después del par completo.

---

## Verificaciones sin hallazgos

**Regresiones funcionales (además de lo anterior)**

- M0.1: `kardexCustomPatch` toma la otra fecha de la URL más reciente (`latest.current` de `useUrlState`, actualizada de forma síncrona en `setState`) y solo si el rango no era `custom` usa lo mostrado; la prueba `use-url-state.spec.ts` reproduce la navegación lenta. Un `value` vacío borra la fecha (queda sin tope), coherente con `resolveKardexDates`.
- M0.2: `coilTies: { viewer: actor }` en `addItems`. La cotización de origen de un pedido está `CONFIRMED`, por lo que no se ata a sí misma; no hace falta `exceptQuotationIds`. La E2E D-320 cubre rechazo y aceptación tras anular.
- M0.3: la línea tied usa el mismo `unitPricePen` derivado que la de bobina entera; `unassignedCoilProducts` se pasa solo con los `productId` atados; el chequeo `isCoilSaleProduct` sigue rechazando un `BOB…` suelto en cualquier otro camino (alta, edición). El aviso permanente del detalle (`unassignedCoilLines`) usa `businessLine`, SKU `BOB…` y `reserveItemType !== 'COIL'`, y se oculta en CONFIRMED/CANCELLED. Sin bobina entera en la original no se añade ninguna consulta.
- M1 servidor: cada `*_SORT_KEYS` alimenta `z.enum`; `listOrderBy` ignora una clave no declarada y no muta el orden por defecto; se aplica también a la rama `pendingOnly` de comprobantes y a `onlyWithBalance` de compras (misma variable `orderBy`, antes del tope). Los `where` por vendedor no cambian.
- Hooks de React: revisé cada vista con `useSort`/`sortRows`. Todos los `useSort` están en el nivel superior y antes de cualquier `return` temprano (tipo-cambio y usuarios lo llaman antes de su guarda de rol; catálogo, colores, estado de cuenta y bobinas también). `sortRows` es función pura, sin hooks.
- Reglas de `useSort`: borrar `page` en cada clic es correcto para las vistas con `?page=`; para `cobranzas` no aplica (P1-2).
- Historial de producción (M2): sin `useColumnFilters`, hooks sin cambios de orden; el popover está en la fila expandida, fuera del botón de expandir.

**Seguridad y alcance**

- Visibilidad por vendedor: `warnings[]` no incluye números de otro vendedor (ver P2-6). Los ordenamientos por relación (`customer.name`, `salesOrder.seq`) se aplican sobre filas ya filtradas por `quotationSellerWhere`/`fiscalDocumentListWhere`; no hay oráculo.
- `nav.ts`: comparé cada ítem existente contra `86d8db0`. Todos conservan sus `roles`. Los tres nuevos son «Órdenes de producción» (`ADMINISTRADOR`, `SUPERVISOR_PLANTA`, igual que el `RoleGate` del detalle), «Colores» (`ALL`, igual que `/catalogo`) y «Configuración» → `/configuracion/reservas` (`ADMINISTRADOR`, antes cubierto por el ítem «Márgenes…» con `activePrefix: '/configuracion'`). Ningún rol gana ni pierde acceso. `rolesOfNavItem('/compras' | '/corte' | '/pedidos' | '/comprobantes')` siguen resolviendo.
- Inyección por `sort`: solo claves de enum; sin interpolación de cadenas hacia SQL.

**Invariantes**

- Decimal: `sortRows` y `compareDecimalBy` usan `toDecimal(...).comparedTo`; los accesores `decimal:` devuelven cadenas del DTO o `String(entero)`. Los vacíos van al final sin pasar por `Decimal`. Sin `number` para dinero, kg o mm.
- Sin estado derivado almacenado, sin entidades nuevas, sin escrituras nuevas: no toca kardex ni auditoría.

**Presupuesto de consultas por petición (medido por lectura)**

- Listados con `sort`: 0 consultas adicionales (solo cambia el `ORDER BY`; con `customer.name`, `salesOrder.customer.name` o `supplier.name` añade un `JOIN`).
- `POST /sales/quotations/:id/duplicate`: +0 sin líneas de bobina entera; +1 (`quotationItem.findMany` vía `findCoilTies`, `quotations.service.ts:551`) con líneas de bobina entera; +1 más (`coil.findMany`, `:552-559`) solo si hay atadas. Ambas fuera de la transacción.
- `POST /sales/orders/:id/items`: +1 `findCoilTies` dentro de la transacción (en `assertCoilsNotTied`) solo si hay líneas `saleCoilId`.

**Accesibilidad y UI**

- `SortableTableHead` pone `aria-sort` solo en la columna activa; los encabezados sin `onClick` son `span`. `RowActions` nombra el menú «Más acciones de <fila>» y usa `DropdownMenu` con manejo de teclado de Radix. Las notas de P2-8 son lo que encontré.

**Cobertura de pruebas**

- Con prueba: `listOrderBy` (unit), `duplicate` con y sin atadura y con VENDEDOR (unit + E2E `bobina-atada-d310`), `addItems` con atada (E2E D-320), `sortRows` (4 casos), `kardexCustomPatch`, `unassignedCoilLines`, orden por cliente entre páginas y 400 por clave inventada (E2E), historial de bobinas (E2E D-324), menú por clientes (E2E D-327), mapa del menú (E2E `correcciones-03-listas-kardex`).
- Sin prueba: `sortRows` con clave desconocida (P0-1); `useSort` con prefijo y con borrado de `page`; cambio de pestaña Catálogo↔Colores con `sort` en la URL; `sort` en compras, comprobantes (incluida `pendingOnly`), despachos, bobinas, clientes y pedidos (solo hay E2E de cotizaciones); orden servidor de `dueDate`/`total` en USD (P2-1); duplicar una original `CONFIRMED` con bobina entera (P2-5); `nav.ts` no tiene unit que fije los `roles` por ítem; `isItemActive` con `?tab=` y con `activePrefix` arreglo; la E2E de `planta-cola-f8s3-ui` desalineada (P1-1).

---

## Resolución (la sesión que escribió el cambio, después de la autorrevisión)

- **P0-1 corregido:** `sortRows` ignora una clave que la tabla no declara (prueba nueva), y «Colores»
  usa parámetros propios (`csort`/`cdir`) para no compartir el orden con el catálogo.
- **P1-1 corregido:** `planta-cola-f8s3-ui.spec.ts` espera ahora el enlace «Órdenes de producción».
- **P1-2 corregido:** en Cobranzas, «Pendientes» manda al servidor las columnas propias del
  comprobante y deja de página solo cobrado y saldo; «Por cliente» ordena la página y sus
  encabezados lo dicen (`title`).
- **P2-1 corregido en parte:** «Comprobante» de compras ordena por serie y número. «Total» sigue
  ordenando por soles (el total en la moneda del documento no es comparable entre monedas).
- **P2-3 corregido:** el menú marca un solo ítem en `/catalogo` (por `?tab=`); la prueba E2E lo
  comprueba.
- **P2-4 corregido:** los flejes de una orden de drywall se quedan en el detalle; D-325 retira solo
  las bobinas de coberturas.
- **P2-8 (comentario) y P2-9 corregidos.**
- **Sin cambio:** P2-2 (el estado ordena por el valor guardado), P2-5 (duplicar una original
  confirmada con bobina entera sigue dando 400: la bobina está reservada por el pedido, no atada),
  P2-6 (numeración del aviso con la línea de la original), P2-7 (una `?sort=` inválida en una lista
  del servidor da 400) y el resto de P2-8.
