# cc37 — Autorrevisión (subagente nuevo; no es pase cruzado)

Fecha: 2026-10-09
Alcance: `git diff 517c3892 -- apps e2e` (incluye lo no commiteado): `sales-document-form.tsx`,
`lib/format.ts` (+spec), `lib/line-material.ts` (+spec), `e2e/tests/alcance-vendedor-ui.spec.ts`.
Método: solo lectura del diff y del código que toca (`QuietDecimalInput`, `InputWithUnit`,
`Input`/`normalizeOnBlur`, `normalizeDecimalInput`, `displayDecimal`, ids de foco) y grep de la
suite E2E. No se corrió nada (había una corrida de Playwright en curso).

Esto es una **lista de riesgos, no una aprobación**.

## Resumen

| Severidad | Cantidad |
| --------- | -------- |
| P0        | 0        |
| P1        | 0        |
| P2        | 1        |
| P3        | 5        |

No encontré ningún camino por el que cambie el JSON enviado, un cálculo, un precio, un piso, una
reserva o una validación. El único texto de validación que cambia es el mensaje del piso
(«por u» → «por und», línea ~1126), y ningún E2E lo afirma.

## (1) JSON y validación: `QuietDecimalInput` con `minDecimals` 0

Verificado leyendo `QuietDecimalInput` (sales-document-form.tsx ~2216-2256):

- Sin editar, el campo muestra `displayDecimal(value, 0)` («10.000» → «10»); el borrador sigue
  siendo «10.000». `displayDecimal` nunca pierde cifras significativas (`toFixed(max(min, dp))`,
  y `Decimal('10.000').decimalPlaces()` es 0), así que «2.5» se muestra «2.5».
- Con la primera tecla se guarda exactamente el texto visible con la tecla aplicada; si lo escrito
  vuelve a ser igual a lo mostrado («10»), se devuelve el valor de antes («10.000»). Lo intacto
  (D-255) sigue intacto y lo editado es lo que se ve.
- El normalizador temprano de `Input` (pointerdown/Enter en captura, solo `inputMode="decimal"`)
  sobre un campo enfocado sin editar recibe «10» y `normalizeDecimalInput("10")` devuelve «10»: no
  dispara `input`, no cambia el borrador. `displayDecimal` no agrega separador de miles, así que
  nunca aparece una coma que el normalizador reinterprete.
- El campo «Planchas» pasó de `Input` a `QuietDecimalInput` con `inputMode="numeric"`: no entra al
  normalizador (igual que antes), conserva `id=planchas-N` y su `aria-label` sin sufijo
  (`unit=""` → `withUnit` no agrega nada). `fill('6')`/`fill('10')` de los E2E siguen mandando ese
  texto.

Conclusión: ningún texto mostrado vuelve como un valor distinto del guardado salvo que el usuario
teclee, y entonces vuelve lo que ve. Sin hallazgo.

## (2) Regresiones funcionales y de foco

- Ids que usan la barra de faltantes y `focusLineQty`: `linea-N-product|coil|qty|price`,
  `linea-N-length-1` y `planchas-N` siguen en los mismos `<input>`/`<button>` (`InputWithUnit`
  propaga `id` y `ref` al `Input`). Sin hallazgo.
- El editor de largos (Enter, agregar largo) no está en el diff. Sin hallazgo.
- Nombres accesibles: la cantidad en unidades pasa de «Cantidad de la línea 1 (u)» a «… (und)». Los
  E2E usan `getByLabel('Cantidad de la línea 1')` (subcadena), así que siguen encontrándolo.

## (3) ARIA

### P2-1 — El panel de la línea es una 7.ª celda en una tabla de 6 columnas

`sales-document-form.tsx:2050`. El panel (`role="cell"`) es hijo directo de la fila, hermano de la
grilla que lleva las 6 celdas. Para el árbol de accesibilidad la fila queda con 7 celdas y 6
encabezados: NVDA/JAWS anuncian «columna 7» sin encabezado al entrar al panel, y la navegación por
columnas (Ctrl+Alt+→) salta de «Acciones» al panel como si fuera otra columna. La estructura no es
inválida (un `div` genérico entre `row` y `cell` es aceptado por ARIA 1.2), pero la lectura sí
cambia respecto de la tabla anterior, donde el panel era su propia fila con `colSpan`.
Reproducir: abrir una línea con panel (plancha de largo fijo) con NVDA en modo tabla y moverse por
columnas. Sugerencia: darle `aria-colspan={5}` y `aria-colindex={2}` al panel, o sacarlo a su propia
`role="row"` (la tarjeta podría ser un `role="rowgroup"` con dos filas).

### P3-1 — Fila «Agregar línea» con una sola celda

`sales-document-form.tsx:1505-1506`. Antes tenía `colSpan={6}`. Un lector puede anunciarla como
fila de 1 columna en una tabla de 6. Sugerencia: `aria-colspan={6}` en esa celda.

El resto está bien: `table` (con nombre «Líneas») > `row` > `columnheader`/`cell`, la columna de
acciones tiene nombre «Acciones» oculto, y cada fila se nombra «Línea N».

## (4) Disposición

### P3-2 — La columna de acciones (4rem) es 2 px más angosta que sus dos botones

`sales-document-form.tsx:227` y `~2018-2045`. Con el botón «Detalle» visible hay dos `size-8`
(32 px) + `gap-0.5` (2 px) = 66 px en una pista de 64 px. Con `justify-end` el exceso sale hacia la
izquierda, sobre el `gap-x-3.5`; no tapa nada, pero la columna no mide lo que dice. Sugerencia:
`4.25rem` o `gap-0`.

### P3-3 — Importe con IGV en 7.5rem

Antes 9rem. «S/ 1,234,567.89» en `font-semibold` ronda los 120 px, el ancho justo de la pista; un
total de 8 cifras se monta sobre el `gap` de acciones (la celda no tiene `min-w-0` ni
`overflow`). El «sin IGV …» de debajo se parte en el espacio, así que no desborda. Riesgo bajo con
los montos actuales; vale la pena mirarlo en el UAT con una línea grande.

### P3-4 — Encabezado desplazado 1 px

`sales-document-form.tsx:1445-1447`: el encabezado usa `px-3` y las tarjetas `p-3` **más** el borde
de 1 px, así que las columnas del encabezado quedan 1 px a la izquierda de las de las tarjetas.
Invisible a simple vista; se nota si se mide la alineación (como hace `correcciones-03-formularios`
con otras grillas). Sugerencia: `px-[calc(0.75rem+1px)]` o un borde transparente en el encabezado.

El margen calculado del panel (`ml-[calc(2.25rem+0.875rem)]`) coincide con la primera pista más el
`gap-x-3.5`: el panel arranca alineado con el producto. Los textos de ayuda siguen dentro de su
propia celda, debajo de su campo. `min-w-[62rem]` dentro de `overflow-x-auto`: desplaza en vez de
aplastar.

## (5) Textos

### P3-5 — Comentarios que hablan de la tabla que ya no existe; «und» solo en este formulario

- `sales-document-form.tsx:1707` («`align-top` en toda la fila») y `:1722` («la celda hereda
  `whitespace-nowrap` del componente `Table`») describen la tabla HTML anterior.
- «und» convive con «u» en el resto de la app (detalle de pedido, comprobantes, `formatUnitQty`).
  Está declarado en el JSDoc de `salesUnitSymbol`; lo dejo anotado para que el dueño lo vea en el
  UAT y decida si se unifica.

Ningún código interno ni texto en inglés visible en lo tocado.

## (6) E2E

- `alcance-vendedor-ui.spec.ts:71`: `page.locator('table').last()` → `getByRole('table', { name:
'Líneas' })`. Correcto: la tabla de líneas ya no es un `<table>`.
- Barrí `e2e/tests` buscando selectores que dependieran del `<table>`/`<tr>` del formulario
  (`locator('table'|'tbody tr'|'thead')`), de «u» como unidad o de los textos de estado
  («De stock · hay …», «.000 u»): los `tbody tr`/`thead` restantes son de listados
  (`/cotizaciones`, `/clientes`, reportes), no del formulario.
  `cotizacion-formulario-cc31.spec.ts:86` (`getByRole('cell').filter({ has: productField })`)
  sigue funcionando: la celda del producto conserva `role="cell"`.
- Unitarios: `format.spec.ts` cubre `formatSalesQty`/`salesUnitSymbol`/`displayDecimal(…, 0)`;
  `line-material.spec.ts` actualiza «420.000 u» → «420 und». Ningún unitario cubre
  `QuietDecimalInput` con `minDecimals` 0 (el ida y vuelta «10» → «10.000»); lo cubre solo el E2E
  si alguno toca una cantidad en unidades ya guardada sin editarla.

## Lo que no revisé

- No corrí lint, typecheck, unitarios ni E2E (corrida en curso en el worktree).
- No miré la pantalla: las observaciones de disposición salen de leer las clases, no de medir el
  DOM.

## Respuesta de la sesión (2026-10-09)

- **P2-1 (ARIA del panel):** corregido. La tarjeta es un `rowgroup` («Línea N») con dos filas: la de
  los campos (6 celdas) y la del panel (una celda vacía bajo «#» y otra con `aria-colspan={5}`).
  Medido en el DOM: todas las filas tienen 6 columnas.
- **P3-1:** «Agregar línea» lleva `aria-colspan={6}`.
- **P3-2 y P3-3:** importe a 8.5 rem y acciones a 4.25 rem.
- **P3-4:** el encabezado usa `px-[13px]` (borde de 1 px más el relleno de la tarjeta).
- **P3-5:** comentarios sobre `align-top` y `whitespace-nowrap` de `Table` actualizados o quitados.
  «und» frente a «u» en el resto de la app queda para el dueño (D-571).
- **Sin unitario de `QuietDecimalInput` con `minDecimals`:** la ida y vuelta queda cubierta por la
  comparación del JSON antes y después (idéntico) y por `displayDecimal('10.000', 0)` en
  `format.spec.ts`.
