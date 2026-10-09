# cc37 — Revisión del segundo modelo (Sonnet)

Fecha: 2026-10-09
Alcance: `git diff 517c3892 -- apps e2e` (incluye lo no commiteado) más el guion `docs/uat/cc37.md` y las filas D-570/D-571 de `docs/ARQUITECTURA.md`.
Método: lectura del diff completo contra `517c3892`, lectura del formulario (`LineRow`, `QuietDecimalInput`, `MaterialCommitment`), de `InputWithUnit`, de `format.ts` y de los E2E que tocan el formulario o los textos cambiados; `tsc --noEmit -p apps/web` (sin errores) y `prettier --check` sobre los 6 archivos tocados (limpio). No se corrieron E2E ni unitarios (hay una corrida de Playwright en curso).

**Veredicto: aprobada para seguir, sin P0 ni P1.** Hay 1 P2 menor y 6 P3 de estilo/consistencia; ninguno bloquea el deploy.

## Resumen

| Sev. | N.º | Hallazgo                                                                                       |
| ---- | --- | ---------------------------------------------------------------------------------------------- |
| P0   | 0   | Ninguno                                                                                        |
| P1   | 0   | Ninguno                                                                                        |
| P2   | 1   | `overflow-x-auto` recorta el anillo de foco del botón «Agregar línea» (sin relleno en la caja) |
| P3   | 6   | Ver abajo                                                                                      |

## Lo confirmado sin hallazgo

- **El JSON enviado al API no cambia.** Ningún hunk toca `buildPayload`, `validate`, `linePricing`, `lineValues`, `patchLine`, `chooseProduct`, `setLineKind`, `chooseSaleCoil`, `convertToCoil` ni el cálculo de pisos. Los cambios en lógica son solo de lo que se pinta: `salesUnitSymbol` en el texto del error de precio mínimo (el mensaje cambia «por u» a «por und»; la validación es la misma), `formatSalesQty` en chips y paneles, y la disposición. Los `onPatch` conservan exactamente los mismos campos y valores que antes (se compararon uno a uno los de producto, bobina, cantidad, precio, importe sin IGV, «Cargar importe sin IGV» y «Cargar precio con IGV»).
- **`QuietDecimalInput` con `minDecimals`.** El borrador (`l.qty`, `l.pricePen`, `l.netAmountPen`) solo se escribe en `onChange`; enfocar y salir sin teclear no lo toca. La regla «si lo escrito es exactamente lo que se veía, se devuelve el valor de antes» ahora usa el mismo `minDecimals` en la visualización y en la comparación, así que no se rompe la simetría (verificado: `"150.000"` se ve `150`; escribir `150` devuelve `"150.000"`, numéricamente igual y sin sacar a la línea de «intacta», D-255). Con `minDecimals` por defecto 2 los campos que ya eran silenciosos (precio, metros) se ven y se comportan igual que antes.
- **Campo de planchas.** Pasó de `Input` plano a `QuietDecimalInput` (`quiet`, `minDecimals={0}`, `unit=""`). Conserva `id="planchas-N"`, `aria-label="Planchas de la línea N"`, `inputMode="numeric"` y `placeholder`. `InputWithUnit` con unidad vacía no agrega nada al nombre accesible (`readableUnit('')` es falso), así que `getByLabel('Planchas de la línea 1').fill('10')` (plancha-largo-d166, plancha-importada-d263) sigue funcionando. El valor que se guarda es el que escribe el usuario.
- **Cantidad en unidades.** Ahora es silenciosa también para `und` (antes solo `m`), con `minDecimals` 0. Es solo presentación; el valor sembrado de una cotización guardada («150.000») se envía igual.
- **Nombre accesible de los campos.** `InputWithUnit` agrega la unidad al `aria-label`: «Cantidad de la línea 1 (und)» en vez de «(u)». Los E2E buscan «Cantidad de la línea N» sin `exact`, por lo que siguen resolviendo. El único `toHaveValue` sobre ese campo (`venta-bobina-modal-d282`, kg de bobina) no cambia porque kg no es silencioso.
- **`formatSalesQty` / `salesUnitSymbol`.** Usan `Decimal` y `formatNumber`/`formatKg`/`formatMeters`; sin `number` para dinero, kg o mm. `NIU` a «und», `KGM` y `MTR` reutilizan las reglas de cc31, un texto no numérico se devuelve tal cual (probado en `format.spec.ts`). `line-material.spec.ts` se actualizó a «420 und» / «80 und» de forma coherente.
- **`MaterialCommitment`.** `code = row.unit === 'kg' ? 'KGM' : row.unit` mantiene los kilos con `formatKg(value, null)` equivalente (símbolo vacío, 2 decimales) y las unidades pasan a «und» sin decimales; los metros pasan de `12.000` a `12.00` (cambio solo de pantalla, consistente con cc31). Un servicio (`ZZ`) no llega a este bloque.
- **Casos borde leídos en el código.** Venta de bobina entera (celda de producto con `Elegir bobina`, «saldo completo»/«del comprobante», enlace «Cargar importe sin IGV» debajo del precio, sin panel), plancha importada por plancha (panel obligatorio, `PricingUnitSwitch` y «por plancha, como se cotizó» intactos, precio `/m`), accesorio con piezas (el panel arranca abierto con `piecesHint`; «de bobina · N piezas (dato)» igual), servicio sin inventario (unidad vacía: sin sufijo en el precio ni en la cantidad, chip «Servicio · sin inventario»), unidades con fracción (`2.5 und`).
- **Estructura ARIA.** `table` (con nombre «Líneas») > `row` > `columnheader` / `cell`; el panel de la línea es una `cell` hija directa de la `row` de su tarjeta, y los `div` de la grilla son genéricos (transparentes para el árbol de accesibilidad). La fila «Agregar línea» es `row` > `cell`. Los diálogos (`ProductStockPickerDialog`, `CoilSalePickerDialog`) y el popover del chip van en portales, así que no rompen la tabla. Sigue habiendo un único elemento con `role="table"` y nombre que contiene «Líneas» en el formulario.
- **E2E tocado.** `alcance-vendedor-ui.spec.ts` cambia `locator('table').last()` por `getByRole('table', { name: 'Líneas' })` y comprueba lo mismo (que el SKU quedó en la tabla de líneas). Los selectores `getByRole('cell').filter({ has: productField })` (cotizacion-formulario-cc31) siguen valiendo porque la celda del producto conserva su rol. Ninguno de los E2E que usan `tbody`, `tr` o `getByRole('table')` corre sobre este formulario (son listados, bobinas, reportes y auditoría).
- **Textos.** Español con tuteo, sin códigos internos visibles (los `D-nnn`/`cc37` están solo en comentarios).

## Hallazgos

### P2 — El anillo de foco de «Agregar línea» queda recortado

- Archivo: `apps/web/src/components/sales/sales-document-form.tsx:1442` (envoltorio `overflow-x-auto`) y `:1465-1477` (fila «Agregar línea»).
- Descripción: antes el botón vivía dentro de una caja con borde y relleno de celda. Ahora la fila no tiene relleno y está pegada al borde izquierdo y al inferior del contenedor con `overflow-x-auto`, que fuerza `overflow-y: auto` y recorta todo lo que se dibuje fuera de la caja, incluido el `focus-visible:ring` de 3 px del botón (y la sombra `shadow-xs` de la última tarjeta, que es menos visible).
- Reproducción: en una cotización nueva, llegar con Tab al botón «Agregar línea»; el anillo se ve cortado a la izquierda y abajo.
- Sugerencia: dar al envoltorio un relleno de 4 px (`p-1 -m-1`) o poner el `overflow-x-auto` solo cuando haga falta, o dar a la fila «Agregar línea» un `px-1 pb-1`.

### P3 — Estilo y consistencia

1. **Encabezado desalineado 1 px** (`sales-document-form.tsx:1445-1447`). El encabezado usa `px-3` (12 px) y las tarjetas `border` + `p-3` (13 px hasta el contenido), así que los títulos «Cantidad», «Precio con IGV» e «Importe con IGV» (alineados a la derecha) quedan 1 px fuera de los campos. Sugerencia: `px-[calc(0.75rem+1px)]`.
2. **Margen del panel duplicado a mano** (`:1900-1901` aprox., `ml-[calc(2.25rem+0.875rem)]`). Repite el ancho de la primera columna y el hueco de `LINE_GRID`; si alguien cambia la grilla, el panel dejará de alinearse con el producto. Sugerencia: derivar ambos de una constante o variable CSS.
3. **Comentarios obsoletos** (`:1717-1723` aprox.). Siguen los comentarios «`align-top` en toda la fila…» y «`whitespace-normal`: la celda hereda `whitespace-nowrap` del componente `Table`», que ya no aplican (no hay `Table`).
4. **Selector de producto con la unidad vieja.** `product-stock-picker.tsx:92` sigue diciendo «12.000 u disponibles» mientras la línea y la hoja de stock dicen «12 und»; el E2E `huecos-cobertura-f8s2b.spec.ts:191` depende de esa forma antigua. D-571 lo declara a propósito («solo en este formulario»), pero el vendedor ve las dos formas en la misma pantalla. Registrar la unificación como pendiente.
5. **Texto del error de precio mínimo** (`:1126`): «por und (con IGV)» se lee más natural como «por unidad». Es solo copy.
6. **Sin prueba para lo nuevo de la vista.** No hay unitario de `MaterialCommitment` ni de `QuietDecimalInput` con `minDecimals`, ni E2E que afirme los roles de tabla, «und» o la alineación de la tarjeta (queda al guion UAT). El riesgo es bajo porque es presentación, pero una aserción en `format.spec.ts` para `formatSalesQty('150.5', 'NIU')` y otra E2E mínima de «`Cantidad de la línea 1` se ve `150`» fijarían D-571.

Nota menor sin severidad: la columna de acciones mide `4rem` (64 px) y los dos botones de ícono (`size-8`) más el hueco suman 66 px; con `justify-end` el exceso de 2 px se pierde en el hueco de la grilla y no se ve.

## Respuesta de la sesión (2026-10-09)

- **P2 (anillo de foco de «Agregar línea» recortado):** corregido con `-mx-1 px-1 pb-1` en el
  contenedor que desplaza.
- **P3 encabezado corrido 1 px:** `px-[13px]`.
- **P3 margen del panel a mano:** el panel ya no usa margen; es una fila de la misma grilla
  (`LINE_GRID`) con una celda vacía bajo «#».
- **P3 comentarios obsoletos:** actualizados.
- **P3 «12.000 u» en el selector de producto:** fuera del alcance (solo las líneas); anotado en
  D-571 y en `local-data/cc37/diferencias.md`.
- **P3 «por und»:** el mensaje del mínimo dice «por unidad».
- **P3 pruebas:** el JSON enviado se comparó antes y después (idéntico); los roles de tabla se
  midieron en el DOM. Sin E2E nuevo.
