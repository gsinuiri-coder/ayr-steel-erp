# cc36 — Autorrevisión (subagente nuevo; no es pase cruzado)

Fecha: 2026-10-09
Alcance: `git diff 0ee7198b -- apps e2e` (con los cambios sin commitear; quedan fuera
`e2e/tests/zz-cc36-*.spec.ts`).
Base de comparación: `git show 0ee7198b:apps/web/src/components/sales/sales-document-form.tsx`.

> Esto es una **autorrevisión**: la hizo un subagente que no leyó el handoff de implementación.
> Es una lista de riesgos, no una aprobación, y no reemplaza la revisión del segundo modelo ni la
> del dueño.

## Resumen

| # | Sev. | Dónde | Qué |
|---|------|-------|-----|
| 1 | P1 | `sales-document-form.tsx:2105-2121` | Una venta de bobina ya no puede pasar a «Cargar importe sin IGV» |
| 2 | P1 | `e2e/tests/flujo-comercial-f8s2-ui.spec.ts:130` y `:216` | Siguen esperando `70.8000`; con `QuietDecimalInput` el campo muestra `70.80` |
| 3 | P1 | `e2e/tests/reserva-bobina-picker-f8s2b.spec.ts:110` | Espera los kilos (`150`) en el botón de la bobina; el botón nuevo ya no los lleva |
| 4 | P2 | `product-stock-picker.tsx:257-278` | Con «Todas», el filtro por las líneas admitidas se aplica después del tope de 20: en un pedido directo la lista puede quedar corta o vacía, y «puede haber más» no aparece |
| 5 | P2 | `sales-document-form.tsx:2167-2189` (`QuietDecimalInput`) | Lo que se ve y lo que está en el estado difieren; una edición que «vuelve» al texto visible ya no restaura el valor sembrado (D-255/D-377) |
| 6 | P3 | `sales-document-form.tsx:1080`, `cotizaciones/[id]/cotizacion-detalle-view.tsx:326` | Los textos siguen nombrando la opción «Bobina completa (venta directa)», que ya no existe |
| 7 | P3 | `sales-document-form.tsx:2811` | La hoja de stock sigue diciendo «Elige una línea de negocio…» |
| 8 | P3 | `line-material.ts` + `MaterialCommitment` (`sales-document-form.tsx:2737-2741`) | El aviso de `missing` atribuye la causa al espesor, el ancho o el acabado; también sale cuando falta la spec de materia prima |
| 9 | P3 | `sales-document-form.tsx:2056-2121` | Información y acciones que antes estaban a la vista quedan detrás de «⋯» en las líneas sin panel obligatorio |
| 10 | P3 | `product-stock-picker.tsx:352-365` | El chip «Bobina completa» declara `aria-pressed={false}`: se anuncia como un interruptor, pero es una acción |
| 11 | P3 | `sales-document-form.tsx:2058-2080` y `2142-2146` | El rótulo visible y el nombre accesible no coinciden (WCAG 2.5.3) |
| 12 | P3 | `sales-document-form.tsx:1979-2010` | Dos botones de ícono (`size-8`) en una columna `w-[5rem]` con `table-fixed` y `px-2.5`: el cálculo da un desborde de unos 6 px (medirlo en el DOM) |
| 13 | P3 | E2E `huecos-cobertura-f8s2b.spec.ts:178` | La aserción `aria-pressed` pasó a comprobar el clic recién hecho; nadie prueba ya que el buscador abre con la línea de la fila |

No encontré ningún camino en que **el JSON enviado o la validación** cambien para la misma
entrada del usuario. `validate()`, `linePricing()`, `isUntouched()`, `chooseProduct()`,
`setLineKind()`, `convertToCoil()` y `patchPieces()` están idénticos a la base. El único cambio de
semántica es que se quitó la comprobación «Línea N · línea de negocio» de `lineIssue`. Es solo de
la barra: `validate()` nunca exigía `businessLine`, y la línea queda definida al elegir el
producto. Ver los hallazgos 1 y 5 para los dos caminos en que la **forma de llegar** al envío sí
cambió.

---

## P1

### 1. La venta de bobina perdió «Cargar importe sin IGV» (regresión funcional)

- **Dónde.** `apps/web/src/components/sales/sales-document-form.tsx:2105-2121`. El botón ahora
  vive dentro del panel de la línea, y el panel exige `hasPanel = l.kind === 'PRODUCT' && product
  !== undefined` (línea ~1690).
- **Antes.** En la base, el botón estaba en la celda de precio con `{!fixedLength && (...)}`. En
  una línea `BOBINA`, `product` era `undefined`, así que `fixedLength` daba `false` y el botón
  aparecía. `validate()` contempla `kind === 'BOBINA' && amountMode === 'AMOUNT'` (línea 1020), y
  `convertToCoil` deja líneas `BOBINA` en `AMOUNT`: es un caso soportado.
- **Ahora.** En una venta de bobina en modo precio no hay ninguna puerta para pasar a importe.
  Solo se ve «Cargar precio con IGV» (líneas 1935-1943) cuando la línea ya está en `AMOUNT`.
- **Cómo reproducir.** Nueva cotización → Producto → chip «Bobina completa» → elegir una bobina.
  En la celda de precio no hay «Cargar importe sin IGV».
- **Sugerencia.** Dejar «Cargar importe sin IGV» en la celda de precio para `l.kind === 'BOBINA'`,
  como estaba, o mostrarlo fuera del panel siempre que `!fixedLength && !byAmount`. Ningún E2E lo
  cubre; conviene sumar uno.

### 2. E2E sin actualizar: `70.8000` en `flujo-comercial-f8s2-ui.spec.ts`

- **Dónde.** `e2e/tests/flujo-comercial-f8s2-ui.spec.ts:130` (`await expect(price).toHaveValue('70.8000')`)
  y `:216` (lo mismo, con `timeout: 60_000`).
- **Qué pasa.** El campo «Precio unitario de la línea 1» ahora es `QuietDecimalInput quiet`, que
  muestra `displayDecimal('70.8000') = '70.80'`. El mismo archivo se actualizó en la línea 151
  (`76.70`), pero estas dos quedaron igual. Las dos aserciones fallan.
- **Sugerencia.** Cambiarlas a `'70.80'`. El propósito del test (que guardar sin tocar no mueva un
  céntimo) sigue intacto, porque el valor del estado no cambia.

### 3. E2E sin actualizar: los kilos en el botón de la bobina

- **Dónde.** `e2e/tests/reserva-bobina-picker-f8s2b.spec.ts:110`:
  `await expect(coilSelect).toContainText('150', …)`.
- **Qué pasa.** En la base, el botón decía `` `${saleCoil.code} — ${formatQty(availableQty,'kg')}` ``.
  El nuevo (`sales-document-form.tsx:1715-1735`) muestra el código y
  `` `${thicknessMm} mm · ${finishName}` ``, sin kilos. Salvo que el código o el acabado contengan
  «150», la aserción falla. Los kilos siguen en el campo Cantidad.
- **Sugerencia.** Elegir entre dos caminos: (a) apuntar la aserción a `Cantidad de la línea 1`
  (`toHaveValue` con el saldo) o (b) volver a poner los kilos en el botón. El test protege D-185:
  que la bobina elegida se vea al editar. Con (a) sigue protegiéndolo.

---

## P2

### 4. «Todas» filtra las líneas admitidas después del tope de 20

- **Dónde.** `apps/web/src/components/sales/product-stock-picker.tsx:257-278`.
- **Qué pasa.** Con «Todas», `/catalog/search` se llama sin `businessLine` y devuelve hasta
  `SEARCH_RESULT_LIMIT` (20) productos de **todas** las líneas. Después se descartan en el cliente
  los de líneas que el documento no admite. En un pedido directo, D-065 excluye las líneas que
  exigen cotización (coberturas). Si la búsqueda trae, por ejemplo, 20 coberturas, la lista queda
  vacía y dice «Ningún producto coincide con ese texto», aunque existan productos admitidos. Además,
  `mayHaveMore` se calcula sobre la lista filtrada (`matches.length === SEARCH_RESULT_LIMIT`), así
  que el aviso de que puede haber más se apaga justo cuando más falta.
- **Cómo reproducir.** Pedido directo nuevo → Producto → «Todas» → escribir un texto que coincida
  con más de 20 SKU de coberturas y con alguno de otra línea.
- **Sugerencia.** Calcular `mayHaveMore` con `productsSearch.data.length`. Además, una de dos: que
  el API acepte una lista de líneas, o que en un documento que no admite todas las líneas el
  buscador no abra en «Todas» sino en la primera línea admitida. No toca lo enviado: lo que se
  elige sigue pasando por `allowed`.

### 5. `QuietDecimalInput`: lo visible y el estado divergen

- **Dónde.** `sales-document-form.tsx:2167-2189`, aplicado al precio, al importe sin IGV y a la
  cantidad en metros.
- **Qué pasa.** Sin edición, el campo muestra `displayDecimal(value)` («35.4000» → «35.40»), y la
  primera tecla guarda en el estado lo que se ve. Hay dos comparaciones **por texto** contra el
  valor sembrado: `isUntouched` (`l.pricePen === o.pricePen`, línea 295) y la regla D-377
  (`l.pricePen.trim() === seededPrice(listValuePen)`, línea 374). En la base, si el vendedor
  tecleaba algo y lo borraba (o usaba Ctrl+Z), el campo volvía a «35.4000» y la línea recuperaba
  su condición de intacta o de precio de lista. Ahora vuelve a «35.40», que no es igual como texto,
  y la línea pasa a viajar como `unitPriceWithIgvPen`. Deja de mandar los importes guardados
  (D-255) o el valor de lista (D-377). El número es el mismo, pero `lineAmounts` puede redondear
  distinto y mover un céntimo en una línea guardada, que es justo lo que D-255 y D-377 cuidan.
- **Cómo reproducir.** Editar una cotización con un precio sembrado en `xx.xx00`. En el precio de
  la línea 1, teclear «1» al final y borrarlo. Guardar: el ítem viaja con `unitPriceWithIgvPen`
  en lugar de `netAmountPen`/`igvAmountPen`/`totalAmountPen`.
- **Severidad.** P2: hace falta una edición explícita y el número es el mismo. Igual cambia lo
  enviado en un camino que antes era neutro.
- **Sugerencia.** Hacer las dos comparaciones con `Decimal.equals` en lugar de por texto, o en
  `QuietDecimalInput` mostrar el texto crudo si lo tecleado vuelve a ser numéricamente igual al
  sembrado. Cualquiera de las dos cambia lógica fuera de «solo presentación»: lo decide el dueño.
  Otra opción es no aplicar `quiet` al precio de líneas guardadas.

---

## P3

### 6. Textos que nombran la opción que ya no existe

- `sales-document-form.tsx:1080`: «elige la bobina que se vende con «Bobina completa (venta
  directa)».» Ahora es el chip «Bobina completa» dentro del buscador de producto.
- `apps/web/src/app/(app)/cotizaciones/[id]/cotizacion-detalle-view.tsx:326`: el mismo texto.
- **Sugerencia.** «…con el chip «Bobina completa» del buscador de productos».

### 7. La hoja de stock pide elegir una línea de negocio

- `sales-document-form.tsx:2811`: «Elige una línea de negocio para ver las bobinas agrupadas por
  espesor y color.» Ya no hay dónde elegirla: la línea sale del producto.
- **Sugerencia.** «Elige un producto para ver las bobinas de su línea…».

### 8. El aviso de material sin calcular adivina la causa

- `MaterialCommitment` (líneas 2737-2741): «a su producto le falta el espesor, el ancho o el
  acabado». En el API (`sales-orders.service.ts:3888-3910`), `rawMaterialAvailableKg` también es
  `null` cuando no hay `raw.spec` (no existe spec de materia prima para ese espesor y color), y
  `needed` es `null` si falta el ancho o si el producto no está en el panel de stock.
- **Sugerencia.** Un texto neutro: «No se pudo calcular el material de la línea N». El detalle
  queda en el popover.

### 9. Lo que quedó detrás de «⋯»

En las líneas sin panel obligatorio (stock, servicios, accesorios), estos elementos antes estaban
a la vista y ahora requieren abrir «⋯»:

- la descripción para el cliente (D-283);
- «Cargar importe sin IGV» (D-255);
- el peso estimado (D-118);
- «se fabrica contra el pedido», por ejemplo en un accesorio de coberturas.

`validate()` puede rechazar por un campo que está en el panel cerrado: «las piezas son un número
entero» (accesorio) o un motivo de `descriptionToSend`. Como el error solo sale en el cartel, el
vendedor tiene que adivinar que está detrás de «⋯». La barra de faltantes (`lineIssue`) no apunta
a ningún campo del panel, así que no hay enlaces rotos. Es una decisión de diseño; anoto el riesgo.

- **Sugerencia.** Abrir el panel (`setPanelOpen(true)`) cuando el error de `validate()` sea de un
  campo del panel, o mantener abierto el panel de una línea con `piecesHint` inválido.

### 10. `aria-pressed={false}` en «Bobina completa»

`product-stock-picker.tsx:357`. El chip cierra el buscador y abre otro diálogo: es una acción, no
un filtro. Con `aria-pressed`, el lector de pantalla lo anuncia como «botón de alternancia, no
presionado». **Sugerencia:** quitar `aria-pressed`.

### 11. El rótulo visible no coincide con el nombre accesible

- La descripción tiene `<Label>` «Descripción para el cliente» y `aria-label` «Descripción de la
  línea N»; el `aria-label` gana.
- Las piezas tienen el rótulo «Piezas · dato, no entra al cálculo» y el nombre «Piezas de la línea
  N (solo información)».

Quien dicta por voz el rótulo visible no encuentra el campo (WCAG 2.5.3). Los E2E dependen del
`aria-label`; basta con que el nombre **contenga** el rótulo visible, por ejemplo «Descripción para
el cliente de la línea N».

### 12. Columna de acciones angosta

`TableHead className="w-[5rem]"` con `table-fixed`, y `TableCell` con `px-2.5`: quedan 60 px
útiles. Los dos botones `size="icon"` (`size-8`, 32 px) más `gap-0.5` suman 66 px. Es un desborde
calculado de unos 6 px hacia el borde derecho de la tabla; **no lo medí en el DOM**.
**Sugerencia:** `size="icon-sm"` o `w-[5.5rem]`.

### 13. Cobertura E2E que se diluyó

- `huecos-cobertura-f8s2b.spec.ts:178-181`. Antes, la línea se elegía en la fila y el test
  comprobaba que el buscador **abría** con ese chip marcado. Ahora el test hace clic en el chip y
  comprueba que quedó marcado: verifica el clic, no el estado inicial. Nadie prueba que al
  **reabrir** el buscador de una fila con producto, el chip marcado sea la línea de esa fila
  (`setLine(businessLine || ALL_LINES)`).
- `plancha-largo-d166.spec.ts:225`: `toContainText('3.00 m')` sobre el panel sigue detectando la
  regresión. Con 3 mm, `mmToMetersShort` da «0.003 m». Es más laxa que el `toHaveValue('3.00')`
  anterior, pero suficiente.
- Las líneas quitadas en `alcance-vendedor-ui`, `busqueda-selectores`, `integridad-f8s4-m0`,
  `pedido-edicion-f8s2` y `product-stock-picker-f8s2b` (el paso «Línea de negocio de la línea 1»)
  dejan líneas en blanco dobles. Es cosmético: Prettier lo marcaría en `format:check`.
- **Sugerencia.** Un caso más en `cotizacion-formulario-cc31.spec.ts`: después de elegir el
  producto, reabrir el buscador y comprobar que «Coberturas Aluzinc» está `aria-pressed=true`.

---

## Lo que revisé y no encontré roto

- **Envío.** `validate()`, `submit()`, `linePricing`, `lineValues`, `isUntouched`,
  `chooseProduct`, `setLineKind`, `chooseSaleCoil`, `convertToCoil` y `patchPieces` no tienen
  cambios. `lineFromItem` cambió `mmToMeters` por `mmToMetersShort`. Para milímetros múltiplos de
  10 el resultado es exacto con 2 decimales. Para el resto, `toFixed(3)` redondea igual que antes,
  así que `metersToMm` vuelve a los mismos milímetros que la base.
- **Picker con «Todas».** `/catalog/search` y `/sales/stock-panel` aceptan omitir `businessLine`
  (`catalog.controller.ts:73-88`, `stockPanelQuerySchema`). Los productos del panel no dependen de
  la línea (`sales-orders.service.ts:3657-3665`). `onSelect` devuelve `product.businessLineCode`,
  que es la misma línea que antes daba el chip.
- **Volver de bobina a producto.** Se llega por el diálogo de bobina, con «Vender un producto en su
  lugar» (`coil-sale-picker.tsx:195-209`): `setLineKind('PRODUCT')` y abre el buscador.
- **Convertir la línea importada (D-254, `CoilPoolConvert`)** y **cotizar por metro (D-268,
  `PricingUnitSwitch`)** siguen en su sitio, con las mismas condiciones.
- **Foco tras elegir.** `focusLineQty` busca `planchas-N`, el primer largo o la cantidad. Los dos
  primeros viven en el panel, que es obligatorio (`panelRequired`) en a medida y en plancha y se
  pinta en el mismo render en que llega el producto.
- **Barra de faltantes.** Los destinos (`product`, `coil`, `qtyTargetId`, `price`) nunca están en
  un panel que se pueda cerrar.
- **`pickerFor`.** El `useState(autoOpenPicker)` solo cuenta al montar. Las filas tienen `key`
  estable (`l.key`) y `nextKey` es monótono, así que no se reabre sola. `pickerFor` nunca se
  limpia; hoy es inocuo porque la tabla no se remonta.
- **Menú activo.** La variante `data-active:` de `shadcn/tailwind.css` excluye
  `data-active="false"`, así que las opciones inactivas no quedan pintadas de azul. `cn`
  (tailwind-merge) resuelve el conflicto con las clases `data-active:` base del `SidebarMenuButton`.
- **Textos.** Están en español y con tuteo; no aparece inglés ni códigos internos más allá del SKU
  y del código de bobina, que ya se mostraban.

## Respuesta de la sesión (2026-10-09)

1. **P1 importe sin IGV en la venta de bobina:** corregido (debajo del precio en la línea de bobina).
2. **P1 `flujo-comercial-f8s2-ui` con `70.8000`:** corregido a `70.80`.
3. **P1 `reserva-bobina-picker-f8s2b` espera los kilos en el botón:** el botón de la bobina vuelve a
   mostrar los kilos disponibles.
4. **P2 «Todas» en el pedido directo:** el aviso de «puede haber más» se calcula sobre lo devuelto
   por el servidor y, si el descarte ocultó resultados, se sugiere filtrar por línea. Sin endpoint
   nuevo no se puede pedir «solo las líneas admitidas» en una sola consulta (D-551).
5. **P2 teclear y borrar sacaba a la línea de «intacta»:** corregido en `QuietDecimalInput`: si lo
   escrito vuelve a ser exactamente lo que se mostraba, se devuelve el valor con que empezó la
   edición (D-554).
6. **P3 textos con «Bobina completa (venta directa)»:** corregidos en el formulario y en el detalle
   de la cotización. **P3 7** (hoja de stock): corregido. **P3 10** (`aria-pressed` del chip de
   bobina): quitado.
7. **P3 8, 9, 11, 12, 13:** quedan como deuda menor anotada; 12 se midió en la captura final (los
   dos íconos entran en la columna).
