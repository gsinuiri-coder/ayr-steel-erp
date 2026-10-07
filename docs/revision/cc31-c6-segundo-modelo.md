# cc31 corte 6 — revisión de segundo modelo

Revisor: Sonnet (contexto limpio). Diff: `origin/main...cc31-c6` (7 archivos, +813 −368).
No es aprobación: es una lista de riesgos (AGENTS.md §2.2).

## Resumen

La afirmación «solo disposición, textos y ayudas» se sostiene para lo que importa al dinero:
el payload (`validate()` y `pricing.payload`), el cálculo de precios, los pisos, las
reservas, las validaciones y el habilitado del botón principal no cambian. `floorStatus`
es una extracción literal de la lógica que tenía `PriceFloorHint`, y `lineIssue` replica
las condiciones de `validate()` solo para presentación. Todo el dinero nuevo usa `Decimal`
(`listPriceWithIgv`, `typeable`, totales); el único `Number(...)` es la vigencia en días.
No encontré P0 ni P1.

La afirmación es inexacta en un punto: hay comportamiento nuevo, no solo disposición
(ver P2-1). No cambia datos enviados, pero sí lo que el vendedor puede hacer.

Verificado contra el código:

- `focusField` resuelve por `id`: `customer`, `validity` y los `linea-N-*` existen
  (`SearchSelectField id="customer"`, `InputWithUnit id="validity"`, ids de línea).
- Filas de detalle (`<TableCell />` + `colSpan={5}`) suman 6 columnas, igual que el encabezado.
- `TableBody ref` funciona: `TableBody` es función con `...props` y React 19 pasa `ref`.
- `Button size="xs"` y `variant="link"` existen. `InputWithUnit` reenvía `id`.
- `fixedLengthValuePerMeter` lanza con largo 0, pero `listPriceWithIgv` entra solo tras
  `sellsByFixedLength` (largo > 0): no hay caída del render por catálogo roto.
- `onPatch(reset)` + `onChooseProduct` en el mismo tick se componen bien (`patchLine`
  usa actualización funcional).
- E2E tocados: los dos ajustes son correctos. Revisé los specs que usan «Vigencia (días)»,
  «Producto de la línea», las filas del picker y los textos viejos («Valor de lista»,
  «Mínimo con IGV», «Agregar otro largo»): ninguno rompe. Los `aria-label` de los
  campos se conservaron.

## Hallazgos

### P0

Ninguno.

### P1

Ninguno.

### P2

**P2-1. Comportamiento nuevo sin cobertura e2e, fuera de lo declarado.**
`product-stock-picker.tsx:228-232,296-318` y `sales-document-form.tsx:1124-1141,1531-1543`.
Escenario: en el selector, el vendedor cambia de filtro de línea y elige un producto de
otra línea: la fila cambia de línea de negocio (y limpia cantidad, largos y descripción).
Antes, el selector solo mostraba la línea de la fila. Además, «Usar X» escribe el mínimo
en el precio, y al elegir el foco salta a la cantidad. Ninguno altera el payload y las
reglas siguen en `validate()` y el API, pero no es «solo disposición» y ningún spec lo
cubre (cambio de línea desde el selector, «Usar X», foco a la cantidad, barra de
faltantes del formulario de venta).
Arreglo: declararlo así en el handoff y agregar un spec corto (elegir producto de otra
línea y comprobar la línea de la fila; precio bajo el mínimo, «Usar X», y que el botón
sigue habilitado y el precio pasa el 400).

**P2-2. Barra de faltantes: `role="status"` permanente que cambia por tecla.**
`sticky-action-bar.tsx:38-43` usado desde `sales-document-form.tsx:1503`.
Escenario: en un formulario recién abierto la barra ya dice «Faltan 2 datos: Cliente ·
Línea 1 · línea de negocio»; mientras el vendedor tipea el precio, el texto cambia
(«precio bajo el mínimo» aparece y desaparece) y un lector de pantalla lo anuncia en cada
cambio. Visualmente es ruido al abrir. No bloquea nada.
Arreglo: aceptable como diseño del corte 3 del despacho; si molesta, no mostrar los
faltantes de línea hasta el primer intento de guardar o la primera edición, o anunciar
solo por conteo (`aria-live="polite"` con `aria-atomic`).

### P3

**P3-1. Una tecla de flecha arriba no vuelve al buscador.**
`product-stock-picker.tsx:235-242`. `focusRow(from, -1)` en la primera fila se queda en
la primera (clamp). Con ↓ desde el input se entra a la lista, pero no se sale con ↑.
Arreglo: si `at === 0` y `step === -1`, enfocar el input de filtro.

**P3-2. La unidad dentro del campo es `aria-hidden`.**
`sales-document-form.tsx` (`InputWithUnit unit={qtyUnit|priceUnit}`) y `input.tsx:76`.
Antes la unidad era texto visible bajo el campo; ahora el nombre accesible del campo
(«Cantidad de la línea 1») no dice kg/und ni «/m». Para lectores de pantalla se pierde
la unidad. Arreglo: `aria-description` o sumar la unidad al `aria-label` (cuidando los
specs que buscan por `getByLabel`, que usan coincidencia por subcadena).

**P3-3. Posible solape número/unidad en el campo de precio.**
`input.tsx:75` fija `pr-9` (2.25 rem) y la unidad ocupa `right-2.5`. Con «/und» o «/m²»
el texto de la unidad mide ~1.9 rem: queda al borde. No lo pude comprobar a ojo (solo
leí código). Arreglo: medir en el DOM con precio de 6 dígitos y unidad más larga, o
subir a `pr-11` en la línea (como ya hace Vigencia).

**P3-4. La suma de «Importe con IGV» por línea puede diferir un céntimo del total.**
`sales-document-form.tsx:1391-1399` vs la barra (`documentTotals.total`, D-377: se
redondea una sola vez sobre Σ subtotal y Σ IGV). Cada línea redondea su propio total.
Escenario: tres líneas con IGV de fracciones que se redondean para el mismo lado.
Arreglo: nada que cambiar si se acepta; un rótulo «referencial» o mostrar solo el
«sin IGV» evitaría la pregunta del vendedor.

**P3-5. Sin piso explicable, la lista desaparece.**
`sales-document-form.tsx` (`PriceFloorHint`, rama `status.kind === 'none'`). Si hay
`noFloorReason` solo se pinta la advertencia y se pierde «Lista X», que antes salía en
un renglón aparte. Arreglo: pintar también la lista bajo la advertencia.

**P3-6. Lógica de lista con IGV duplicada.**
`list-price.ts` repite la traducción de `chooseProduct` (`sales-document-form.tsx:789-`
y `seededPrice`). Hoy coinciden (el campo siembra 4 decimales y la ayuda muestra 2).
Arreglo: que `chooseProduct` use `listPriceWithIgv`/un helper común para que no diverjan.

**P3-7. `focusLineQty` depende de que `activeElement` sea `body`.**
`sales-document-form.tsx:502-518`. Es correcto con la animación de cierre de Radix y con
`preventDefault` en `onCloseAutoFocus`. Pero si la restauración de foco se cambiara a otra
versión de Radix/shadcn, el guardia puede dejar de saltar. No hay test que lo fije;
cae bajo P2-1.

## Textos y accesibilidad

Textos en español con tuteo correcto («reserves», «confirmes», «Súbelo», «Agrega una
fila»). `aria-pressed` en los filtros, `role="group"` con etiqueta, `kbd` semántico,
`Label` «Vigencia» con `aria-label` «Vigencia (días)» (contiene el texto visible).
Los `aria-label` de los controles de línea se conservaron.

## Veredicto

Apto para el pase del dueño, sin P0 ni P1. Corregir o aceptar explícitamente P2-1 (documentar
el alcance real y sumar cobertura) antes del deploy; el resto son P3 de pulido. La unica
corrida que falta es la de los e2e afectados, que no ejecuté (revisión estática del diff).

## Estado tras las correcciones (autor del corte)

- P2-1: declarado en el PR y en el handoff; spec nuevo `e2e/tests/cotizacion-formulario-cc31.spec.ts`
  (cambio de línea desde el selector, foco a la cantidad, «Usar X» y la barra).
- P2-2: `MissingFieldsHint` deja de ser región viva (`role="status"` quitado).
- Autorrevisión, P2: sin «Usar X» ni rojo en líneas importadas (D-163/D-255); en modo importe el
  mínimo lleva unidad y «con IGV» y no se muestra «Lista». P3 de la unidad ZZ corregido.
- El resto de P3 queda anotado en el handoff.
