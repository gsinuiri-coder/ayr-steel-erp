# Diagnóstico de LOG-3 y LOG-2 (2026-09-28)

Sesión de **solo diagnóstico**, rama `fix/investigacion-log`, desde `origin/main` en `bc0c331`. No se
cambió código. Origen: `docs/analisis/ux-recorrido-2026-09-28.md` §5 (PR #54, todavía abierto),
filas LOG-3 (D-379) y LOG-2 (D-377). Orden del dueño: LOG-3 primero.

## Resumen para la reunión

|                                 | LOG-3 «0.000 m de 60.000 m»                                                                | LOG-2 98.0001 y saldo 0.0024                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Qué es**                      | Lectura. El dato está grabado; una pantalla lo lee de la columna equivocada.               | Valor grabado con 4 decimales (redondeo intermedio en el formulario) **y** listas de Cobranzas que no miden en céntimos.                          |
| **¿`number`?**                  | No aplica.                                                                                 | **No.** Todo es `Decimal`; falla dónde se redondea, no el tipo.                                                                                   |
| **¿Datos malos en producción?** | No. 7 OP de plancha (4 pedidos) **se ven** mal; ninguna está mal grabada.                  | 29 de 33 comprobantes tienen total con fracción de céntimo; ninguno está mal cobrado todavía. 14 dejarían residuo si se cobra tecleando el papel. |
| **¿Relleno o migración?**       | No.                                                                                        | No.                                                                                                                                               |
| **Arreglo**                     | Campo de lectura nuevo con los metros desde el detalle de largos (como ya hace `/planta`). | A: listas de saldo y tope del diálogo de cobro en céntimos (S). B: sacar la plancha del viaje ida-vuelta por el IGV, como D-255 (M).              |
| **Esfuerzo**                    | S, media sesión.                                                                           | A: S. B: M.                                                                                                                                       |

**Para explicarlo en pantalla (19:00):**

- _LOG-3:_ «La orden está completa y el sistema lo sabe —en planta se ve bien—. El detalle del pedido
  suma los metros desde un campo que solo llenan las coberturas a medida; para la plancha de catálogo,
  que se lleva en piezas, ese campo está vacío a propósito. Es un error de la pantalla, no del dato, y
  se corrige sin tocar nada de lo grabado.»
- _LOG-2:_ «El precio de la plancha se muestra por metro con IGV a 4 decimales y al guardarse se
  recalcula, y ahí se gana una diezmilésima (98.0001). En el papel sale redondo. Si se cobra con el
  monto que propone el sistema, la factura cierra. Si se teclea el del papel, según hacia dónde
  redondee: o queda una fracción de céntimo que la lista de cobranzas todavía cuenta como deuda y
  muestra como S/ 0.00, o el botón de cobrar no deja pasar un céntimo de más. Nada del dinero está
  mal: es una diferencia por debajo del céntimo que el sistema tiene que tratar en céntimos en todas
  partes, como ya hace al validar el cobro.»
- _Consejo operativo mientras no se arregla:_ registrar los cobros **aceptando el monto que precarga
  el diálogo**. Cierra el comprobante en todos los casos.

---

## LOG-3 — «0.000 m de 60.000 m» en una orden de plancha completa

### Veredicto

**El dato está; la lectura no lo usa.** Es un defecto de lectura, no de escritura. No hace falta
relleno ni migración: los largos producidos de cada reporte están grabados desde el primer día en
`production_report_pieces`, y el camino de `/planta` que muestra la orden abierta ya los usa y da
la cifra correcta. Lo que falla son **dos lecturas** que suman `meters_m`, una columna que la plancha
de catálogo no llena **por diseño**.

### Evidencia

1. **La escritura deja `meters_m` en `null` a propósito para la plancha de catálogo.**
   `apps/api/src/production/roofing-production.service.ts:1139-1141` y `:1182`:

   ```ts
   const byLength = sellsByLength(product);           // unit === MTR
   ...
   metersM: byLength ? toFixedString(piecesMeters(pieces), 'KG') : null,
   ```

   La plancha de catálogo es `NIU` (D-083), así que `byLength` es `false` y `meters_m` queda nulo. Es
   correcto: `meters_m` es «lo que entró al kardex en metros», y el kardex de la plancha va en piezas.
   El comentario del modelo lo dice: `schema.prisma:1493` («**Solo ROOFING a medida** (D-083)»).

2. **La misma escritura sí graba los largos.** `roofing-production.service.ts:1192`:
   `...(accessory ? {} : { piecesDetail: { create: pieces } })` — toda plancha no accesorio deja sus
   filas `{lengthMm, qty}` en `production_report_pieces` (`schema.prisma:2467-2478`). Esa línea existe
   igual desde `bf6fef4` (2026-09-04, anterior al día D y a la recarga V-4 del 2026-09-15): **no hay
   reportes de producción sin detalle de largos** en la base actual.

3. **El denominador sí cuenta la plancha; el numerador no.** En el listado `GET /production`
   (`apps/api/src/production/production.service.ts:1684-1730`, `toListItem`):

   - `planMeters` se calcula para **toda** OP `ROOFING` desde `order.items` (líneas 1725-1730): la
     plancha de 20 × 3.00 m da `60.000`.
   - `metersReported` suma **solo** `r.metersM` (líneas 1686-1692) y devuelve `null` si ningún
     reporte lo trae: en plancha, siempre `null`.

   Es la misma asimetría que el recorrido midió en el API: `piecesReported: 20, metersReported: null,
planMeters: "60.000"`.

4. **`/planta` (orden abierta) calcula bien porque lee otra fuente.**
   `roofing-production.service.ts:1393` pide `piecesDetail` y `:1420-1421` hace
   `roofingPlanProgress(planPieces, piecesMeters(reportedPieces))`; lo mismo el borrador,
   `roofing-drafts.service.ts:343`. Hay **dos derivaciones de «metros reportados»** en el API y solo
   una es correcta para la plancha. Por eso el síntoma aparece cuando la OP se **cierra** y pasa a
   leerse desde el listado.

### Dónde se ve (tres pantallas, un solo origen)

| Pantalla                                | Código                                                                                       | Qué hace con el `null`                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Detalle del pedido, tarjeta de órdenes  | `apps/web/src/app/(app)/pedidos/[id]/production-orders-card.tsx:154-160`                     | `metersReported ?? '0.000'` de `planMeters` → «0.000 m de 60.000 m»                     |
| `/planta?historial=1`, fila del pedido  | `apps/web/src/lib/order-history.ts:36-56`, `components/production/order-history.tsx:322-324` | suma `planMeters` de todas (60 + 42) y `metersReported ?? '0'` → «42.000 m / 102.000 m» |
| `/planta?historial=1`, fila de la orden | `components/production/order-history.tsx:476-485`                                            | aquí **no** falla: con `null` muestra «20 / 20 pzs»                                     |

El detalle de la OP (`produccion/[id]/produccion-detalle-view.tsx:244-246`) tampoco falla: usa el
`null` como señal de «la unidad son piezas» y muestra «Piezas buenas 20». **Esa semántica del `null`
es la razón de no arreglarlo cambiando `metersReported`** (ver propuesta).

### Hallazgo lateral (no visible hoy, no se toca)

`sales-orders.service.ts:2797-2811` y `:2929-2938` arman `readiness` con `orderedMl =
reservation.salesOrderItem.reserveQty` y `reportedMl = Σ metersM`. `reserveQty` de una línea de
cobertura es **kilos de bobina** (`reserveQty = roundTo(v, 'KG')`, `packages/shared/src/schemas/sales.ts:1673`),
no metros, y `reportedMl` en plancha es 0. `missingMl` sale de restar kilos menos metros. **No se ve
en pantalla**: el web no lee `missingMl`, y `deriveOrderStage` trata igual `LISTO` y
`LISTO_CON_FALTANTE` (`order-readiness.ts:66-74`), así que el estado «Listo» del pedido es correcto.
Queda anotado para que quien arregle LOG-3 no lo «aproveche» sin decisión: es otra pregunta.

### ¿Afecta datos de producción?

**Ningún dato grabado está mal.** Afecta la **lectura** de toda OP `ROOFING` de producto `NIU` con
al menos un reporte vigente: en el detalle de su pedido se ve «0.000 m de N m», y en el historial
suma cero. En producción: **las 7 OP de plancha, todas cerradas, en 4 pedidos** (§Conteos).

### Propuesta de arreglo

Añadir al DTO del listado un campo nuevo, simétrico de `planMeters`, calculado igual que en
`/planta`, y que lo lean las pantallas que comparan contra `planMeters`:

1. `production.service.ts:171`: sumar `piecesDetail: { select: { lengthMm, qty } }` al `select` de
   `reports` del listado.
2. `toListItem`: `planMetersReported` = en `ROOFING`, `piecesMeters(piecesDetail de reportes
vigentes)`; en accesorio (D-343, sin detalle), `Σ metersM`; en drywall, `null`. Mismo criterio que
   `roofing-production.service.ts:1420-1421` y `:1428-1431`.
3. `production-orders-card.tsx:156` y `order-history.ts:51-56`: leer `planMetersReported` en lugar
   de `metersReported`. `metersReported` queda como está (su `null` sigue significando «la unidad son
   piezas» para el detalle de la OP).
4. Tests: unitario de `toListItem` con plancha `NIU` cerrada (20 × 3.00 → `60.000`), el caso de
   `order-history.spec.ts` con una plancha y una a medida en el mismo pedido (102 / 102), y un
   aserto en el E2E del pedido.

- **Esfuerzo:** S — media sesión con revisión y E2E del área. Cambio de lectura, sin migración ni
  relleno, sin tocar kardex.
- **Riesgo:** bajo. Presupuesto de consultas: el `select` suma un `include` anidado en la misma
  consulta; hay que medirlo en el test de presupuesto del listado si existe.
- **Alternativa descartada:** llenar `meters_m` también en la plancha (escritura + relleno). Rompe
  el significado de la columna (lo que entró al kardex, D-083/D-171) y obliga a reescribir datos
  reales para arreglar una pantalla.

---

## LOG-2 — valor 98.0001 y saldo de 0.0024 en Cobranzas

### Veredicto

**Es un valor persistido, no un redondeo de presentación.** El 98.0001 se genera en el
**formulario** al hacer un viaje de ida y vuelta por el IGV redondeando a 4 decimales en el medio, y
se **graba** así en la cotización, el pedido y el comprobante (`Decimal(18,4)` en todas las
tablas). **No hay `number` en el camino**: todo es `Decimal`. El invariante D-003 se cumple; lo que
falla es **dónde** se redondea.

El residuo de Cobranzas tiene **una segunda causa, independiente**: los comprobantes de venta nunca
se redondean al céntimo, y las listas de Cobranzas comparan el saldo crudo contra cero, mientras que
el cobro (D-169) ya compara en céntimos. Arreglar solo el 98.0001 no cierra la clase: cualquier
subtotal cuyo 18 % no cae en céntimo (p. ej. 10.01 → IGV 1.8018) deja la misma cola.

### Cómo sale 98.0001 (plancha de 3.00 m, valor de lista 98.0000 sin IGV)

| Paso                        | Dónde                                                            | Operación                                                    | Resultado                  |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------- |
| 1. Siembra por metro        | `apps/web/src/components/sales/sales-document-form.tsx:649-654`  | `fixedLengthValuePerMeter(3000, 98)` = 98 ÷ 3                | 32.6666… (sin redondear)   |
| 2. Precio con IGV del campo | `sales-document-form.tsx:665`                                    | `money(salePriceFromValue(·))` = × 1.18, **a 4 decimales**   | **38.5467**                |
| 3. Vuelta a valor           | `sales-document-form.tsx:374` (`lineValues`)                     | `money(saleValueFromPrice(38.5467))` = ÷ 1.18, a 4 decimales | **32.6667**                |
| 4. Valor por plancha        | `sales-document-form.tsx:383-386`                                | `money(fixedLengthUnitValue(3000, 32.6667))` = × 3           | **98.0001**                |
| 5. Payload                  | `sales-document-form.tsx:340-345`                                | viaja solo `{ valuePerMeterPen: "32.6667" }`                 | —                          |
| 6. API                      | `apps/api/src/sales/sales-lines.ts:448-456`                      | repite el paso 4 desde `valuePerMeterPen`                    | `unitPricePen` **98.0001** |
| 7. Totales de línea         | `packages/shared/src/schemas/sales.ts:93-97` (`salesLineTotals`) | `money(qty × 98.0001)`, IGV `money(subtotal × 18 %)`         | subtotal y total con cola  |

Helpers: `packages/shared/src/tax.ts:38-45` (× / ÷ 1.18, sin redondear),
`packages/shared/src/schemas/roofing.ts:287-312` (valor por metro ↔ por plancha),
`packages/shared/src/decimal.ts:13` (escala MONEY = 4, HALF_UP).

Con los números del recorrido: el subtotal correcto es 3,325.0000 (3,923.50 ÷ 1.18); con +0.0001 por
plancha × 20 planchas queda **3,325.0020**, IGV `money(598.50036)` = 598.5004, total **3,923.5024**.
Cierra exacto con lo que midió la auditoría.

Nota: D-255 (`sales-document-form.tsx:150-156`) ya eliminó este mismo viaje de ida y vuelta para
las líneas normales (ahora viajan con `unitPriceWithIgvPen` y el API deriva desde el total). **La
línea de plancha de catálogo quedó fuera de D-255** y sigue con el viaje: ese es el origen.

### Por qué se propaga y no se «deshace»

- Se graba `value_per_meter_pen = 32.6667` y `unit_price_pen = 98.0001` (`schema.prisma`
  QuotationItem 1617-1634 y SalesOrderItem 1732-1741, `Decimal(18,4)`).
- Al reabrir la línea (`sales-document-form.tsx:448-450`) se vuelve a mostrar 38.5467 y, al
  guardar, sale otra vez 98.0001. Al duplicar la cotización (`quotations.service.ts:644-654`) se
  copia `valuePerMeterPen` 32.6667.
- El comprobante copia subtotal/IGV/total de la línea del pedido (`invoicing.service.ts:828-873`,
  D-169/D-265) y suma la cabecera sin redondear al céntimo (`:570-571`, `sales.ts:1619-1628`): el
  total del comprobante queda **3,923.5024**. `cents()` (D-359) existe pero solo se usa en compras.
- El papel y la pantalla dicen 3,923.50 solo porque `formatMoney` muestra 2 decimales
  (`apps/web/src/lib/format.ts:32`).
- COT-7 (valor en naranja, `cotizaciones/[id]/cotizacion-detalle-view.tsx:349-350`): compara el
  string de lista `"98.0000"` con el grabado `"98.0001"`. **La pantalla dice la verdad**: el valor
  grabado sí es distinto.

### Por qué queda saldo 0.0024 en Cobranzas

- Cobrar: `receivables.service.ts:150-157` compara contra `payableBalance(saldo)` =
  `toDecimalPlaces(2, ROUND_CEIL)` (`packages/shared/src/schemas/invoicing.ts:161-163`, D-169).
  Admite hasta 3,923.51 y el diálogo precarga 3,923.5024: el camino por defecto cierra. **Pero el
  diálogo del web no usa esa regla**: `comprobante-detalle-view.tsx:1483-1490` deshabilita el botón
  si el monto supera el saldo crudo (3,923.5024), así que teclear 3,923.51 no llega al API. D-169 vive
  en el API y no en el formulario.
- Listar: `receivables.service.ts:287-288` (`balance.lte(0)`), `:252-261` (`totalBalancePen`) y
  `invoicing.service.ts:3055` (`pendingOnly`: `balancePen.gt(0)`) usan el saldo **crudo**
  `total − cobrado − notas` (`documentBalance`, `invoicing.ts:126-146`). Con 3,923.50 cobrado queda
  0.0024 > 0: el comprobante sigue «con saldo», cuenta un cliente, y la celda muestra «S/ 0.00».

Es decir: **D-169 resolvió el cobro pero no la lectura.** La regla «el saldo se mide en céntimos»
vive en un solo punto de cuatro.

### Riesgo adicional a futuro (no activo hoy)

`nubefact-payload.ts:130-158` envía `Number(command.totalPen)`: el PSE recibiría 3923.5024. Hoy
`PSE_ENABLED` está apagado en producción (solo comprobantes manuales), así que no hay efecto. Antes
de encender el PSE conviene que los totales de venta estén al céntimo; lo dejo anotado, no evaluado.

### Propuesta de arreglo (dos piezas, en este orden)

**A. Lectura de saldos al céntimo (cierra el síntoma, incluye lo ya grabado).** Llevar la escala
de D-169 (céntimos) a las lecturas. Ojo: **no sirve reutilizar `payableBalance` tal cual**, porque
su `ROUND_CEIL` convierte 0.0024 en 0.01 — correcto como tope de cobro, equivocado para decidir si
algo se lista. La regla de listado sería «saldo redondeado HALF_UP a 2 decimales > 0» (0.0024 → 0.00,
cerrado; 0.005 → 0.01, abierto), en un helper compartido nuevo junto a `payableBalance`. Puntos:
`receivables.service.ts:288`, `:252-261`, `invoicing.service.ts:3055`, el saldo que muestra cada
fila, y **el tope del diálogo de cobro** (`comprobante-detalle-view.tsx:1483-1490`), que tiene que
comparar contra `payableBalance(d.balancePen)` —la misma regla que valida el API— y no contra el
saldo crudo. Sin este quinto punto, una factura de cola `50`–`99` sigue sin poder cobrarse por el
importe del papel.

- **Decisión del dueño que pide:** ¿un saldo por debajo de medio céntimo se considera cobrado a
  efectos de listas y totales, aunque el dato siga en 0.0024? (Recomendación: sí; el dato no se
  toca, la auditoría conserva los dos montos.)
- **Esfuerzo:** S. Sin migración, sin relleno, sin tocar lo grabado. Arregla los comprobantes ya
  emitidos sin editarlos.

**B. Origen: sacar la plancha de catálogo del viaje de ida y vuelta (D-255 para la plancha).**
Opciones, de menor a mayor alcance:

1. Si el vendedor no tocó el precio, enviar el valor por plancha de lista (98.0000) y no el valor
   por metro recalculado. Arregla el caso común; un precio tipeado por metro sigue pudiendo dejar cola.
2. Llevar la plancha al esquema de D-255: el campo envía el precio **con IGV** por metro tal cual y
   el API deriva desde `redondeo(cantidad × largo × precio)`. Mismo criterio que ya rige las líneas
   normales.

- **Esfuerzo:** M (formulario + `sales-lines.ts` + tests de las tres formas de línea + E2E de
  cotización con plancha). Recomendación: opción 2, por consistencia con D-255.
- **Lo ya grabado:** cotizaciones, pedidos y comprobantes existentes **no se corrigen**. Un
  comprobante emitido es un documento fiscal; las cotizaciones y pedidos con 98.0001 son
  diferencias de diezmilésimas que A ya neutraliza en Cobranzas. Si el dueño quiere limpiarlas,
  sería re-guardar la línea desde la pantalla (sin SQL), una por una; no lo recomiendo.
- **No necesita migración.**

**C. (Opcional, decisión aparte) Totales de comprobante de venta al céntimo**, como D-359 hizo en
compras. Es la solución de fondo de la clase y la precondición del PSE, pero cambia totales que hoy
coinciden con el pedido línea a línea. No para esta semana.

---

## Conteos en producción

Medidos el 2026-09-28 contra `https://v2.mareliac.pe` con dos scripts de **solo lectura** (un POST
de login con el admin de `.env.setup` y después solo GET), cada uno con OK del dueño por comando
(D-251). Sin SQL. Los scripts vivieron en el scratchpad de la sesión y no se commitean. No se
imprimieron montos ni RUC.

### LOG-3

`GET /api/production?kind=ROOFING&status=DRAFT,IN_PROGRESS,CLOSED,CANCELLED`:

| Qué                                            | Cuántas                       |
| ---------------------------------------------- | ----------------------------- |
| OP de coberturas (todas)                       | 28                            |
| de plancha de catálogo (`NIU`)                 | 7                             |
| `NIU` con reportes y `metersReported = null`   | **7** (las 7, todas `CLOSED`) |
| pedidos distintos donde se ve «0.000 m de N m» | **4**                         |

Es decir: **toda** OP de plancha cerrada en producción muestra el síntoma. Ningún dato está mal:
el arreglo es de lectura y las corrige a las 7 sin tocarlas.

### LOG-2

`GET /api/invoicing/documents` (33 comprobantes, todos `MANUAL`, todos `ACCEPTED`):

| Tipo      | Total  | Con total con fracción de céntimo | Con saldo pendiente |
| --------- | ------ | --------------------------------- | ------------------- |
| Factura   | 22     | 18                                | 22                  |
| Boleta    | 11     | 11                                | 11                  |
| **Total** | **33** | **29**                            | **33**              |

- Colas medidas (dígitos 3-4 del total), facturas: `01`, `02`×2, `03`×2, `04`×4, `05`, `64`,
  `94`, `95`×2, `97`, `98`×3; boletas: `02`×3, `03`, `87`, `95`, `96`×2, `97`, `99`×2.
- **Qué pasa al cobrar tecleando el importe del papel** (el papel redondea HALF_UP a céntimos):
  - cola `01`–`49` → el papel redondea **hacia abajo** y queda residuo, el síntoma de LOG-2:
    **14 comprobantes** (10 facturas, 4 boletas);
  - cola `50`–`99` → el papel redondea **hacia arriba** y se teclea menos de un céntimo **de más**.
    El API lo admitiría (D-169) y `documentBalance` no baja de cero, pero **el diálogo no deja
    enviarlo**: el botón «Registrar cobro» se deshabilita si el monto supera el saldo **crudo**
    (`comprobantes/[id]/comprobante-detalle-view.tsx:1483-1490`, `.gt(toDecimal(d.balancePen))`).
    Hay que aceptar el precargado o teclear a la baja. 15 comprobantes. (Hallazgo de la revisión de
    segundo modelo, verificado en el código.)
- Hay totales justo por debajo del céntimo (`95`–`99`): el viaje de ida y vuelta de la plancha solo
  **suma** diezmilésimas, así que **no todas las colas vienen de la plancha**. La clase es más ancha
  que el 98.0001; no atribuí cada comprobante a su línea (haría falta leer el detalle de cada uno).
  Esto refuerza que la pieza A (lectura en céntimos) va primero.
- **Hoy ningún comprobante tiene saldo entre 0 y 0.01**, y los 33 tienen saldo pendiente: todavía
  no hay cobros que hayan dejado residuo. La pieza A conviene antes de que empiece la cobranza en serio.
- Ningún dato grabado necesita corrección para cerrar el síntoma.
