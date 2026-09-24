# Autorrevisión — fix/post-s4b (SM-P1-1/D-267, P2-A/B/C, SM-P2-1/2, D-268)

- **Fecha:** 2026-09-24
- **Alcance:** `git diff 249186b..HEAD -- apps packages e2e` en la rama `fix/post-s4b`
  (commits `ff176ab`, `25360d4`, `ebf5bb1`).
- **Nota:** **autorrevisión, no vale como pase independiente.** La hizo el mismo modelo que
  escribió el código, en un contexto limpio y sin leer el handoff de implementación. Es una lista
  de riesgos para quien revise después, no una aprobación.
- **Corrido:** los unitarios de `invoicing-math`, `price-changes`, `coil-sale-product`,
  `rf-s4b-glue` e `imported-documents-sweep` (5 suites, 152 tests, verdes), y
  `invoicing|sales-order|quotations` (5 suites, 97 tests, verdes). No se corrió E2E.

## P0

Ninguno.

## P1

Ninguno.

## P2

### P2-1 — P2-A sin prueba en el servicio (plausible, falta de cobertura)

`apps/api/src/invoicing/invoicing.service.ts:777-798` (factura) y `:985-1001` (NC). La regla
vive en `pendingWithDrafts`/`PartLedger`, que tienen unitarios, pero ningún spec del servicio
simula el segundo `groupBy` (los borradores). Ningún `*.spec.ts` de `invoicing/` simula
`groupBy`, y el diff no trae E2E de facturación. Si mañana alguien toca el filtro
(`status: DRAFT`, `docType ≠ NOTA_CREDITO`, `archivedAt: null`) o la clave (`salesOrderItemId` o
`affectedItemId`), la suite no lo va a detectar. Lo verifiqué a mano: el filtro está bien,
`LIVE_DOCUMENT_STATUSES` no incluye `DRAFT` (así que no se cuenta dos veces) y un borrador
descartado se borra (`discardDraft`, `fiscalDocument.delete`), así que desaparece del libro.

### P2-2 — P2-C: el origen es por producto, no por línea (plausible, impacto acotado)

`apps/api/src/imports/imported-documents-sweep.service.ts:195-215`. El precio «importado» es el
`before` del primer cambio **del producto**. Con dos líneas del mismo producto importadas a
precios distintos, una edición a propósito puede quedar sin contar. Ejemplo: línea 1 en P a A y
línea 2 en P a B.

- t1: la línea 1 pasa de A a C.
- t2: la línea 1 vuelve de C a A.
- t3: la línea 2 pasa de B a A, a propósito.

El origen de P queda en A, así que el cambio de t3 (after A) no cuenta, el de t1 ya no está
vigente y el de t2 es la vuelta. P queda fuera de `editedProducts`. El barrido pisaría la línea 2
de vuelta al papel (B), **pero solo** si |A−B|·qty entra en la tolerancia de redondeo: el control
`deliberate` (`:497-502`) sigue frenando cualquier diferencia mayor. Son céntimos y hace falta un
caso muy rebuscado. Tampoco encontré un camino por el que el «antes» de otro producto (fila D-264)
haga pisar un precio: si el producto cambia, la línea deja de emparejar con la fila del papel por
producto normalizado (`pairLines`) y queda en `unpaired`. Los pedidos que heredan cambios de su
cotización comparten el mismo origen (el primer cambio cronológico entre los dos documentos). Si
se vuelve al precio del papel desde el pedido, el precio de la línea es el del papel, lo que
coincide con la intención de P2-C.

### P2-3 — P2-B: una corrección D-264 que cambia de unidad ya no deja registro (confirmado, por diseño)

`apps/api/src/sales/price-changes.ts:73-79`. Si en una misma edición se corrige un producto mal
mapeado por otro de **otra unidad** (NIU a MTR, o KGM a NIU), y además el precio, no se registra
ningún cambio: antes de P2-B sí se registraba. Revisé los llamadores:

- `quotations.service.ts:293-325` pasa `unit` de los dos lados (`previousLines` selecciona `unit`
  y `ResolvedSalesLine.unit` es obligatorio).
- `sales-order-edits.service.ts:181` y `:303` no pasan `unit` en el «después», pero emparejan
  siempre por el mismo `productId` y nunca llegan al emparejamiento por posición.

Ningún llamador rompe D-264 por asimetría. El barrido tampoco pisa esa línea, porque el producto
nuevo no empareja con la fila del papel. Queda solo el hueco en el historial de precios del
detalle, que es lo que P2-B decidió.

### P2-4 — D-268: el precio por metro sale del precio con IGV ya redondeado (plausible, céntimos visibles)

`apps/web/src/components/sales/sales-document-form.tsx:1749-1752`. `perMeterPrice =
money(pricePen × 1000 / largo)`, donde `pricePen` es el **precio con IGV a 4 decimales** sembrado
por `lineFromItem` desde `unitPricePen` (a su vez un redondeo del importe). El valor por metro
sin IGV que guarda el API pasa por dos redondeos (con IGV a 4 dp y después ÷1.18 a 4 dp), así que
puede diferir en 0.0001 del equivalente directo (`unitPricePen ÷ largo`). En el caso del E2E da
lo mismo (8.3333). En general el error es ≤ 0.0001 × largo × cantidad, y **se muestra** en la
vista previa antes de aplicar. No es un importe oculto: el total mostrado (`linePricing(next)`,
con `lineAmounts`, la misma función que el API) es el que se guarda. Lo verifica el E2E:
499.9980 en pantalla y 499.9980 guardado.

### P2-5 — SM-P2-1: la cifra del comentario es correcta, la derivación no (confirmado, documentación)

`packages/shared/src/schemas/sales.ts:176-180`. La cota de S/ 0.02 del IGV guardado contra el IGV
crudo sale de la tolerancia de la suma (0.01) más los dos redondeos a medio céntimo (valor y
total). El chequeo «IGV contra el 18 %» no acerca ni aleja el trío del papel: solo lo acota contra
el 18 %. El valor y el total quedan a ≤ 0.005 del papel. Conviene corregir la frase en una pasada
de docs; no cambia el comportamiento.

### P2-6 — `taken`: «la que la ata primero» es en realidad la última, sin orden (confirmado, cosmético, ya existía)

`apps/api/src/sales/coil-sale-product.ts:432,443-450`. `quoted` no tiene `orderBy` y el bucle
**sobrescribe**. Si una bobina está en una cotización propia y en otra ajena a la vez (dos
borradores o emitidas abiertas), a un VENDEDOR le puede salir «no disponible» en lugar de su
propio código, según el orden en que lleguen. **No es una fuga**: en ningún orden sale el código
ajeno. Ya pasaba antes del cambio. Solo el comentario promete «primero».

## Revisado sin hallazgos

- **SM-P1-1 / D-267, otras vías.** Busqué el resto de los llamadores de `coilPoolFor`:
  - `quotation-import.service.ts:406`: el preview devuelve `candidates`/`availableKg`, no
    `taken`.
  - `imported-documents-sweep.service.ts:559`: solo cuenta candidatas y la automática.
  - `sales-order-edits.service.ts:386` y `sales-lines.ts:832`: solo `candidates`, y sus
    mensajes de error son genéricos, sin código de documento.

  Los dos selectores del web (`sales-document-form.tsx:1898-1942` y
  `order-edit-dialogs.tsx:496-551`) leen el mismo `GET /sales/coil-pool`, que ahora recibe el
  actor (`sales.controller.ts:417-421`, rol ADMINISTRADOR o VENDEDOR a nivel de clase).
  «montada en una OP» y «reservada por un pedido» no nombran documentos. Una cotización sin
  `sellerId` se muestra «no disponible» a un VENDEDOR, como pide la regla. El parámetro
  `exceptQuotationId` lo manda el cliente sin verificar pertenencia: excluir una cotización ajena
  por UUID solo saca su bobina de `taken`, sin revelar su código. Un sondeo exigiría conocer UUIDs
  ajenos, así que no hay riesgo práctico.

- **Fuera de este flujo, sin verificar si un VENDEDOR los alcanza.**
  `reservation-guard.ts:108` y `raw-material.ts:542` arman mensajes con
  `COT-… (reserva temporal)`. No son parte del selector de bobina ni de este diff.
- **P2-A, tope de cantidad.** `pending` sigue siendo línea − emitido − `usedHere`, y el `qty >
pending` compara contra eso. Los borradores solo cambian el `pending` que decide `partKind`
  (`closing.pending`). `countDrafts` nunca coincide con `FULL`: con `drafts > 0`,
  `withDrafts < lineQty`.
- **P2-A, ±0.01.** `closingPartTotals` devuelve el resto solo si cada cifra está a ≤ 0.01 del
  recálculo y, si no, el recálculo. Ninguna combinación de borradores deja una parte fuera de esa
  cota. Un borrador con precio editado desvía el resto y cae al recálculo.
- **P2-A, dos líneas del mismo documento sobre la misma línea.** La primera acumula en
  `usedHere` y en el `done` del libro. La segunda cierra contra
  `pending − borradores` y suma los dos (verificado a mano: con borrador 1000 y líneas
  1000 + 2194 de 4194, la segunda es `CLOSING` con libro = línea A + borrador).
- **P2-A, NC.** Filtro `affectedItemId` + `DRAFT` + `archivedAt: null`; mismo esquema que la
  factura.
- **P2-A, borradores archivados o descartados.** Los archivados quedan fuera por
  `archivedAt: null` y los descartados se borran. Si se descarta un borrador después de que otro
  cerró contra él, la parte que cerró sigue a ≤ 0.01 del recálculo.
- **P2-B.** Ya cubierto en P2-3: ningún llamador pasa `unit` de un lado solo en el camino por
  posición.
- **D-268, aritmética y D-263.** Todo con `Decimal` (`toDecimal`, `money`, `toFixedString`).
  - Al pasar a por metro se cambian **a la vez** `pricePerPiece: false` y el precio ÷ largo, y
    `lineValues` multiplica por el largo una sola vez.
  - Al deshacer vuelven `pricePerPiece: true` y `original.pricePen` (misma cadena), sin
    multiplicar. No reaparece el ×largo.
  - El deshacer deja `isUntouched` en verdadero (misma cadena de precio y
    `!pricedPerMeter`), así que viaja el trío guardado del papel (D-255). El E2E comprueba
    `subtotalPen` idéntico en la línea deshecha.
  - El gesto no se muestra en `AMOUNT`, en largo roto ni en líneas nuevas. Cambiar de producto
    oculta el deshacer (`original.productId !== l.productId`).
- **SM-P2-2 (test).** Correcto: la parte del medio a otro precio se anota en el libro, y el resto
  de la última se separa más de 0.01 del recálculo, así que se recalcula. La aserción `not.toBe`
  del total es débil pero válida junto con la anterior.
- **E2E `coil-pool-alcance-vendedor-sm-p1-1.spec.ts`.** Cubre A (su código), B («no disponible»,
  sin el código en el JSON) y admin (código), y limpia con `purgeSalesTrail`. No cubre el camino
  del diálogo de pedido, que usa el mismo endpoint.
