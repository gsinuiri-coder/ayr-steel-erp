# Importador de compras: el total del papel manda (D-359). Autorrevisión

> **Autorrevisión** (AGENTS.md §2.2.1). La hizo un subagente nuevo que no escribió el cambio ni leyó
> el handoff de implementación. **No vale como pase cruzado**: es una lista de riesgos, no una
> aprobación.

- Rama: `fix/import-compras-totales`, commit `f6509ca` (`git diff origin/main..HEAD`).
- Leído: el diff completo; `purchases.service.ts` (`receive`, `cancel`, `applyLandedCost`,
  `applyCuttingOrderCost`, `bumpCoilDocumentCost`); `inventory.service.ts` (`record`, `adjustCost`,
  `reverse`, saldo corrido del kardex); `coils.service.ts#create`; `coil-operations.service.ts`
  (partido, recosteo D-045); `kardex-peps.ts`; `parse-spreadsheet.ts`; `importRoundingTolerance`.
- Corrido (unitarios): `src/inventory/inventory-total-cost.spec.ts`, `src/imports/purchase-import-*.spec.ts`,
  `src/purchases`, `src/coils`. Resultado: **18 suites y 274 tests en verde**. No corrí el E2E.

## Veredicto corto

No encontré ningún P0. El cambio de `record()` es **aditivo**: sin `totalCost`, `totalCost = qty × unitCost`
y el promedio queda igual que antes (`balance.qty ≤ 0 → totalCost/qty = unitCost`). Las reversas usan
`original.totalCost`, así que anular una compra recibida saca exactamente lo que entró. `paperAmounts`
no llega por HTTP: el único llamador es `purchase-import.service.ts:412`, y `create()` (`:164`) no pasa
opciones. El partido sigue sacando la madre al promedio y pasando `kardexUnitCostPen` a las hijas, que
no reciben `totalCost`. Hay un P1 de uso (la validación cruzada precio/importe) y varios P2.

---

## P1

### P1-1. Un precio unitario impreso con 2 o 3 decimales junto al importe rechaza la fila

`apps/api/src/imports/purchase-import-validate.ts:529-541`. Cuando la fila trae precio **e** importe,
se compara `money(qty × unitPrice)` con el importe y la tolerancia es `importRoundingTolerance([qty])` =
`max(0.10, (qty + 1) × 0.00005)`. Esa cota supone un precio con **cuatro** decimales. Las facturas
impresas suelen mostrar el P. unit. con 2 o 3 decimales, y el usuario copia lo que ve.

Escenario: el caso de la propia D-359 (bobina de 4 520 kg, importe del papel 4 430.16 USD). Si el P. unit.
se tipea como aparece en el papel, `0.98`, entonces 4 520 × 0.98 = 4 429.60. La diferencia de 0.56 supera
la tolerancia, `max(0.10, 4 521 × 0.00005 = 0.226)`, y la fila queda en **error** («no cuadra con cantidad
× precio… una columna pegada donde no iba»). Pasa lo mismo con 2 500 kg a 3.75 cuando el precio real
es 3.7468: la diferencia es de unos S/ 8. La regla que D-359 quiere instalar («el importe manda») queda
bloqueada justo cuando el papel trae los dos datos. El mensaje además señala una causa que no es la real.

Sugerencia (lo decide el dueño, AGENTS §3.16): acotar la diferencia por la precisión **del precio
tipeado**, es decir `qty × 0.5 × 10^(−decimales del precio)` más el colchón. Otra opción es bajar el
caso a **aviso** cuando el importe manda. Mientras tanto, el README debería decir que, si se llena el
importe, el precio unitario va vacío o con todos sus decimales.

---

## P2

### P2-1. El test del promedio ponderado no discrimina lo que dice

`apps/api/src/inventory/inventory-total-cost.spec.ts:110-117`. El caso compara «(1000 × 3 + 1.00) / 1003»
contra la alternativa «(3000 + 0.9999) / 1003». A cuatro decimales las dos dan **2.9920**:
3001/1003 = 2.992024 y 3000.9999/1003 = 2.992024 (difieren en la 7.ª decimal). La aserción de
`avgCost` pasa con o sin el cambio, y solo la de `movements[1].totalCost` prueba algo. Sugerencia:
elegir cantidades donde las dos cuentas difieran en la cuarta decimal. Por ejemplo, sin saldo previo:
0 kg y luego 3 kg con total 1.0000 no sirve, porque también redondea igual. Hay que buscar un caso con
un saldo previo **chico** (1 kg a 3.0000) y una entrada grande cuyo `qty × (total/qty − unitario₄)` mueva
la cuarta decimal del promedio. Hay que comprobar el caso con la cuenta antes de fijarlo.

### P2-2. Faltan unitarios de `CoilsService.create` con `totalCost` y de `receive()` para la compra manual

`coils.service.spec.ts` no cubre la rama nueva (`coils.service.ts:156-160, 232-240`), y ningún unitario
cubre `receive()` con `receptionCost`. La única cobertura es el E2E nuevo
(`e2e/tests/importar-compras-totales-d359.spec.ts:195-226`), que prueba compras **importadas**. El cambio
de `receive()` alcanza a **toda** compra manual (PEN y USD, producto y bobina): el valor del kardex en
USD pasa de `qty × round4(unit × TC)` a `round4(round4(qty × unit) × TC)`. Varios specs E2E afirman
`unitCost`/`avgCost` exactos (`fase3.spec.ts`, `fase3b.spec.ts`, `fase4-bordes.spec.ts`, `fase6.spec.ts`,
`precios-d161-d163.spec.ts`, `cierre-bobina-d164.spec.ts`, `inventario-inicial-productos-f8s6a2.spec.ts`).
Es un cambio de regla no aditivo sobre el kardex: según D-123 se verifica contra la **suite completa**,
no contra una muestra.

### P2-3. El landed cost y su anulación rehacen el total de la bobina desde el unitario y borran el total del papel

`apps/api/src/purchases/purchases.service.ts:1018-1024` (`bumpCoilDocumentCost`) y
`coil-operations.service.ts:936, 970-971` (recosteo D-045). Después de D-359, `coil.totalCost` =
subtotal del papel y `coil.unitCostPerKg` = unitario derivado de cuatro decimales, así que
`weightKg × unitCostPerKg ≠ totalCost`. Imputar un flete, o anularlo, recalcula
`totalCost = weightKg × newUnitCost`: la bobina pierde el total del papel, y tras flete + anulación ya no
vuelve a su valor original, por hasta `weightKg × 0.00005`. El kardex no se ve afectado porque va por
delta. En el recosteo, corregir solo el TC reingresa por `weightKg × unit × TC` y descarta el total del
papel. Sugerencia: en `bumpCoilDocumentCost` sumar el delta al `totalCost` guardado
(`totalCost + amountPen / TC`) en vez de recalcular desde el unitario. En el recosteo, conservar el
total si no cambió el unitario, o al menos documentarlo.

### P2-4. En ítems de un solo uso, el kardex arrastra un residuo de valor con saldo cero

`inventory.service.ts:258-260, 268-269` junto con el saldo corrido de `:1108-1123`. Antes, el ingreso de
una bobina valía `Q × u₄` y el consumo total salía por `Q × u₄`, así que el valor corrido quedaba en 0
exacto. Ahora entra por `T` y sale por `Q × round4(T/Q)`: al consumirla toda queda un residuo de hasta
`Q × 0.00005` (±0.23 en 4 520 kg) con cantidad 0, y el kardex por ítem muestra valor sin kilos. El
comentario de `:1096-1100` («esta vista no puede divergir de `inventory_balances`») deja de ser cierto
por redondeo. Es menor y el promedio ya tenía un efecto parecido con entradas mezcladas, pero antes no
aparecía en bobinas. Sugerencia: aceptarlo por escrito en D-359, o cerrar el residuo al llegar a
cantidad 0.

### P2-5. «Al céntimo» es falso en el código y en la documentación: la escala es de 4 decimales

`purchase-math.ts:157-172` (`receptionCost`), `coils.service.ts:67-71`, la fila D-359 de
`docs/ARQUITECTURA.md`, `README-importar-compras.md` («al céntimo») y el E2E (`:23, :208`). `money()`
redondea a **4** decimales (`SCALE.MONEY = 4`): el test mismo espera `16590.9342`, no `16590.93`. Ese
número es lo que se guarda. El texto de D-359 dice «el papel dice 16 590.93», pero un papel en USD no
trae un total en soles. Sugerencia: corregir el texto a «a escala de dinero (4 decimales)».

### P2-6. Sin importe de línea, la compra no guarda ni el valor ni el IGV del papel, solo el total

`purchase-import-validate.spec.ts`, caso «el archivo del dueño». Con precio 0.144068 y sin importe,
queda `subtotal 72.0340`, `igv 12.9660` y total 85.00, pero el papel dice 72.03 y 12.97. El kardex
entra por 72.034 y no por 72.03. Es coherente con la regla (el total manda), pero el README («sus
importes no se recalculan, se copian») promete más de lo que pasa. Sugerencia: decirlo en el README (el
importe de línea es la única manera de que el valor sin IGV sea el del papel), o redondear a 2 el
subtotal derivado cuando hay `documentTotal`.

### P2-7. Una celda de importe con fórmula entra por su valor crudo, no por el que se ve

`parse-spreadsheet.ts:37` (`sheet_to_json` con `raw` por defecto) y `rawToString`. Si IMPORTE SIN IGV
es `=B2*C2` y se muestra 72.03, se lee 72.034. El README dice que todas las celdas son texto, así que es
un riesgo de uso y no un defecto de código. Sugerencia: una línea en el README, o un aviso cuando el
importe traiga más de 2 decimales.

### P2-8. La absorción en tasa 0 separa la última línea de su propio importe del papel

`purchase-import-validate.ts:354-359`. En un comprobante exonerado con IMPORTE SIN IGV y un
`documentTotal` que difiere dentro de la tolerancia, el valor de la última línea se mueve y deja de ser
su importe del papel. El `unitPrice` guardado (derivado antes de absorber) ya no corresponde al
subtotal guardado. El preview (`line.subtotal`) muestra la cifra previa a la absorción, mientras que
`dto.total` muestra la posterior. Además, si la última línea tiene un IGV chico y la diferencia es
negativa, `absorbed.igv.isNegative()` da error aunque la diferencia entre en la tolerancia y otra línea
pudiera absorberla. Sugerencia: para tasa 0 con importes de línea, tratar la diferencia como error, o
por lo menos como aviso. Absorber en la línea de mayor importe en vez de la última.

### P2-9. La tolerancia del total va en la moneda del comprobante

`paperAmounts` (`:352`) aplica `importRoundingTolerance`, cuyo piso de 0.10 está definido «en soles»
(D-169), sobre un total en USD. En la práctica es 0.10 USD ≈ S/ 0.37. Ya pasaba antes con
`PURCHASE_IMPORT_TOTAL_TOLERANCE`, pero ahora la diferencia se **absorbe** en el IGV en vez de solo
avisar. Sugerencia: dejarlo explícito en D-359.

### P2-10. `normalizeIgvRate`: `0.18%` con el signo escrito se lee como 18 %

`packages/shared/src/schemas/purchase-import.ts:845-850`. Se quita el `%` y todo valor entre 0 y 1 se
multiplica por 100. Un `0.18%` escrito explícitamente (que nadie querría, pero es literalmente 0.18 %)
se lee como 18 %. `1.18` (el factor) da 1.18 %, pero el descuadre del total lo detecta. Verifiqué el
resto de los casos: `'1.5'` → 1.5, `'100'` → 100, `'0.105'` → 10.5 y `'18,00%'` → 18, todos correctos.
Sugerencia: aplicar la conversión de fracción solo si el texto **no** traía `%`.

### P2-11. En el preview, corregir la cantidad de una fila que solo traía importe la deja inválida

`apps/web/src/lib/purchase-import.ts:723-729`. Editar `qty` siempre vacía `lineAmount`. En una fila sin
precio unitario, el importe desaparece y la fila pasa a «precio obligatorio», con lo que se pierde el
dato del papel. Sugerencia: vaciar el importe solo si la fila tiene precio, o no vaciarlo al editar la
cantidad cuando no hay precio.

### P2-12. `CoilsService.create` ignora `kardexUnitCostPen` en silencio si también llega `totalCost`

`coils.service.ts:232-236`. Hoy ningún llamador pasa los dos, pero la interfaz lo admite. Sugerencia:
rechazar la combinación o documentarla en el tipo.

### P2-13. Detalle de fechas

La fila D-359 está fechada **2026-09-28** y la sesión es del 2026-09-27.

---

## Verificado sin hallazgo

- **Compra manual, producto terminado:** `receptionCost(item.subtotal, qty, TC)`. `assertTotalMatchesUnit`
  nunca rechaza porque el unitario es `money(total/qty)` con ROUND_HALF_UP y la diferencia es ≤ 0.00005
  por construcción.
- **Anulación de una compra recibida:** `reverse` de IN usa `original.totalCost` (el del papel). En una
  bobina `newQty = 0`, y el residuo negativo por redondeo se cierra en 0 (`:557-561`).
- **Saldo cero o negativo:** `newAvg = totalCost/qty`, la misma semántica que antes (`= unitCost`).
- **Salida con `totalCost`:** se rechaza con 400 antes de tocar nada.
- **Partido y corte tercerizado:** sin cambios de firma. La madre sale al promedio, las hijas entran con
  `kardexUnitCostPen` y el prorrateo del corte va por `adjustCost`.
- **`paperAmounts` por HTTP:** no existe. `computeTotals` exige `length === items.length`, y en
  `validateDocument` `amounts` y `items` salen del mismo `lines.map`.
- **`normalizeDecimal`:** `3,745` y `0,980` siguen siendo decimales. `1.234.567`, `1,234,567` y
  `1.234.567,89` se leen bien, y `1.23.4` y `12,34,56` dan `null`. No hay negativos ni exponentes, así que
  no puede entrar un IGV negativo.
- **Decimal y number (AGENTS §3.4):** en el camino nuevo toda la aritmética es `Decimal`. No encontré
  ningún `Number(...)` sobre dinero.
- **Encabezado anterior `TOTAL COMPROBANTE`:** se lee vía `aliases`. `assertPurchaseColumns` solo exige
  los encabezados obligatorios, así que la plantilla anterior no se rechaza.

## Resumen

Sin P0. Hay **1 P1**: la validación cruzada de precio contra importe rechaza el caso normal de un P. unit.
impreso con 2 o 3 decimales. Hay **13 P2**, entre ellos:

- un test del promedio que no discrimina;
- falta de cobertura unitaria de `CoilsService.create`/`receive`, con el aviso de correr la suite E2E
  completa porque el kardex de toda compra manual cambia de valor;
- el landed cost y el recosteo, que borran el total del papel de la bobina;
- el residuo de valor con saldo cero;
- «al céntimo», que en realidad es escala de 4 decimales;
- `0.18%`, que se lee como 18 %;
- el preview, que borra el importe de una fila sin precio.

## Respuesta de la sesión

- **P1 (tolerancia del cruce precio ↔ importe): corregido.** La cota es ahora `cantidad × 0,5 × 10^-d`
  según los decimales del precio escrito (nunca menos que la de D-169): 0.98 en 4 520 kg con importe
  4 430.16 pasa; el precio con IGV en la columna sin IGV sigue siendo error. Tests de los dos casos.
- **P2 «al céntimo»: corregido en el código.** Los importes del papel (valor de línea, IGV, total) se
  calculan en céntimos (`cents`, nuevo en `@ayr/shared`), y el kardex de la recepción entra en
  subtotal × TC **al céntimo**, como decidió el dueño. Sin importe de línea, 500 × 0.144068 queda en
  72.03 (el valor del papel) e IGV 12.97.
- **P2 `bumpCoilDocumentCost` pisaba el total del papel: corregido** (suma el delta).
- **P2 test del promedio que no distinguía: corregido** (caso que sí separa total y qty × unitario).
- **P2 `0.18%` leído como 18: corregido** (con el signo escrito, la cifra ya está en puntos).
- **P2 editar la cantidad de una fila con solo importe la invalidaba: corregido** (`lineEditPatch`
  conserva el importe si la fila no trae precio).
- **Anotados sin cambio:** el residuo de valor con 0 kg al consumir entera una bobina (la salida sale a
  `qty × round4(T/Q)`; es el mismo redondeo del promedio de siempre, acotado a `Q × 0.00005`); el
  recosteo manual (`coil-operations.service.ts:936`) recalcula `peso × unitario` a propósito, porque el
  usuario cambió el unitario; la absorción con tasa 0 (hoy sin caso: con importes de línea no hay
  diferencia); celdas con fórmula leídas por su valor; la tolerancia en la moneda del comprobante (la
  de D-169 también); `kardexUnitCostPen` ignorado con `totalCost` (ningún llamador pasa los dos); la
  fecha de la fila D-359 (2026-09-28 es el día de negocio en que se cierra). El E2E completo del runner
  pasó en verde sobre `f6509ca` (los 7 specs con costos exactos incluidos) y vuelve a correr sobre el
  commit de las correcciones.
