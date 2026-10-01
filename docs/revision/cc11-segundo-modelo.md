# Revisión de segundo modelo: cc11 (D-377, decimales / totales al céntimo)

Revisor: Sonnet 5.5, contexto limpio. Rama `cc11/decimales`, diff `origin/main...HEAD` más `e2e/tests/totales-centimo-d377.spec.ts` (sin commitear). Solo lectura de código; se corrió `jest` sobre `src/invoicing src/sales src/pos src/imports src/production` (85 suites, 1120 tests, verdes) y `tsc --noEmit` en api y web (limpios). No se corrió E2E.

## Alcance revisado

- 8a009a6 docs(analisis): inventario de decimales y propuesta D-377
- b66732c fix(pos): arqueo esperado y diferencia al céntimo
- bad35f2 fix(sales): PDF de cotización redondea
- 1980ab5 fix(web): costo unitario y costo/kg a 4 decimales
- 4e41a99 fix(production): peso teórico de planchas, un solo redondeo
- bb4119e fix(imports): unitario editado del importador a 10 decimales
- f01f1ed feat(sales): totales del documento al céntimo (R2), B1, B3
- caf0fb7 fix(invoicing): cobro al céntimo y saldo cobrable (arreglo A)
- 6c4486c docs(manual): corregir comprobante manual
- 9e9ae2d fix(invoicing): tolerancia de un céntimo por documento en el tope por pedido
- 2ccac2a docs(cc11): D-377, progreso, runbook
- sin commitear: `e2e/tests/totales-centimo-d377.spec.ts`

La implementación de la política es correcta en lo que revisé: `roundDocumentTotals` (cents HALF_UP sobre Σ subtotales y sobre Σ × 18 %), aplicado de forma consistente en `documentTotals` (cotización, pedido directo, duplicado), `refreshTotals` (edición de pedido), `sumLineTotals` (comprobante y nota de crédito) y en las vistas previas web (formulario de ventas, nuevo comprobante, POS). La confirmación cotización → pedido copia la cabecera (no recalcula), así que no hay deriva entre ambos. No hay uso de `number` para dinero en el diff. La ida y vuelta precio con IGV ↔ valor (B1/B3) recupera exactamente el valor de lista a 4 decimales (el error del precio redondeado, ≤ 0.00005, dividido entre 1.18 queda bajo 0.00005), así que la comparación por igualdad de `listValueForPlancha` y `seededPrice` es estable.

## Hallazgos

### 1. [P1] Cuatro specs E2E existentes siguen afirmando la cabecera a 4 decimales y van a fallar

La entrega solo tocó `importe-importado-d169.spec.ts` (la constante `PREVIEW_UNIT_PRICE`). Con R2 la cabecera de cotización, pedido y comprobante queda al céntimo, y estas aserciones no se actualizaron:

- `e2e/tests/importe-importado-d169.spec.ts:213-214`: `quotation.igvPen` '752.2434' y `totalPen` '4931.3734' (ahora '752.2400' y '4931.3700').
- `e2e/tests/importe-importado-d169.spec.ts:225`: `order.totalPen` '4931.3734'.
- `e2e/tests/importe-importado-d169.spec.ts:344-345`: `draft.subtotalPen` '117.9999' y `totalPen` '139.2399' (ahora '118.0000' y '139.2400'). Además este escenario existe para fabricar una cola de diezmilésimas y probar que el cobro cierra; con R2 ya no se puede fabricar por cabecera, así que el test pierde su propósito y hay que rediseñarlo (por ejemplo, con un documento anterior a R2 sembrado por helper, como hace `bobina-pool-cot000002` con `breakQuotationLineForTest`).
- `e2e/tests/importe-importado-d169.spec.ts:553`: `after.totalPen` '4931.3734'.
- `e2e/tests/precios-d161-d163.spec.ts:546-548`: cabecera de la cotización '8.4746' / '1.5254' / '10.0000' (ahora '8.4700' / '1.5300' / '10.0000').

Escenario de falla: la suite E2E completa en CI queda roja por producto/aserción obsoleta, no por infraestructura. Sugerencia: actualizar las aserciones de cabecera (las de línea son correctas) y correr la suite completa desde el worktree antes del deploy; mi barrido fue por regex sobre literales de 4 decimales, así que puede haber más aserciones por texto de UI (`S/ 4,931.37`, etc.) que conviene buscar al correr la suite.

### 2. [P2] El segundo test del spec nuevo no prueba lo que dice

`e2e/tests/totales-centimo-d377.spec.ts`, test «un saldo de fracciones de céntimo no es pendiente...». Recorre `pendingOnly=true` y exige `hasCollectibleBalance(doc.balancePen)` para cada ítem. Eso pasa por vacío si la lista no tiene comprobantes con cola, y el comentario admite que no se puede fabricar la cola con R2. No hay ninguna referencia al comprobante cobrado del primer test (el comentario dice que «no aparece» pero no se verifica), y la lista usa `pageSize=200` sin filtrar por el cliente del caso, así que además depende de datos ajenos de la base compartida. El arreglo A (la parte que más afecta datos ya grabados) queda sin prueba de integración. Sugerencia: sembrar un comprobante anterior a R2 con total de 4 decimales (helper de DB como el de COT-000002), cobrarlo al céntimo y afirmar que sale de `pendingOnly`, de vencidos, y que el botón «Registrar cobro» no se ofrece. Hoy solo hay cobertura unitaria de `hasCollectibleBalance`.

### 3. [P2] El total del papel de un comprobante importado ya no queda garantizado en la cabecera

`packages/shared/src/schemas/sales.ts:1646` (`roundDocumentTotals`), usado por `invoicing.service.ts:571` y `quotations.service.ts` vía `documentTotals`. D-255 admite el trío del papel (`paperTriplet`) con el IGV a un céntimo del 18 %, y guarda el IGV de línea como `total − valor`. Antes, la cabecera sumaba esos IGV y reproducía el total del papel. Ahora el IGV de cabecera es `céntimo(Σ valor × 18 %)` y descarta el IGV de línea del papel. Ejemplo: línea con valor 100.00, IGV 18.01, total 118.01 (admitido por `paperTriplet`): la cabecera da 118.00. Si el cliente pagó 118.01 según el papel, `payableBalance` (118.00) rechaza el cobro por exceso. El análisis midió que los exportes de Nubefact traen IGV exacto al 18 %, así que el caso debería ser raro, pero el riesgo existe para los comprobantes importados (RF-71) y no está reconocido en D-377. Sugerencia: confirmar con el dueño (o documentar en D-377) que para líneas con trío del papel manda la fórmula R2; o, si se quiere conservar el total del papel, que el IGV de cabecera use la suma de los IGV de línea cuando todas las líneas traen trío.

### 4. [P2] El peso teórico cambia los topes y el consumo teórico de producción, y la entrega dice que no toca nada de kardex

`packages/shared/src/schemas/production.ts:134-190`. `piecesTheoreticalKg` ahora redondea una vez; `theoreticalKg(pieces, kgPerPiece)` (línea 152) y `theoreticalKgPerPiece` siguen redondeando por pieza. Efectos: (a) el tope de kg declarado de los reportes (`roofing-drafts.ts:126`, `roofing-production.service.ts:1117`) baja o sube hasta decenas de gramos (el caso real pasa de 4 043.952 a 4 043.916), de modo que un reporte que antes pasaba justo por el tope puede rechazarse; (b) `neededKg` de reserva (`roofing-production.service.ts:1011`) cambia; (c) quedan dos totales distintos para la misma cantidad de planchas según la ruta (por pieza × cantidad contra total redondeado una vez), y `theoreticalKgPerSellingUnit` sigue en la forma antigua. No es dinero y la política lo aprueba como «peso de plancha», pero el resumen de la entrega lo ubica fuera de lo que toca kardex. Sugerencia: anotarlo en el handoff como cambio de tope (y revisar en `docs/PROGRESO.md` el registro de piezas que tocan kardex), y buscar si hay algún consumidor que compare el total redondeado con `theoreticalKg(pieces, kgPerPiece)`.

### 5. [P3] La tolerancia del tope por pedido cuenta también las notas de crédito

`apps/api/src/invoicing/invoicing.service.ts:610` y `invoicing-math.ts:88`: `committedCount = existing._count + creditNotes._count`, y la tolerancia es `0.01 × (count + 1)`. Cada nota de crédito viva suma un céntimo de holgura adicional, aunque la nota resta del `net` y su redondeo ya está en su propio total. Es holgura de céntimos, no cambia lo que el tope frena (el duplicado entero), pero el razonamiento del comentario («cada documento redondea su total») aplica menos a notas, y la holgura crece con el número de documentos. Sugerencia: contar solo comprobantes (`existing._count`) y probar el caso con notas, o dejarlo documentado como aceptado. El mensaje de rechazo sigue mostrando importes sin mencionar la tolerancia, lo que puede confundir con un rechazo de «S/ 0.01 por encima» en pantalla; no hay forma de que ese caso se dé porque la tolerancia lo absorbe, así que está bien.

### 6. [P3] Vista previa del total del importador no es R2

`apps/web/src/app/(app)/cotizaciones/importar/importar-view.tsx` (`groupByDocument`): suma `importRowNetPen` por línea (4 decimales) sin pasar por `roundDocumentTotals`, mientras el API guardará la cabecera al céntimo. La comparación del total de la cabecera contra el papel que el usuario hace en el preview puede diferir en un céntimo. Sugerencia: aplicar `roundDocumentTotals` a la suma de los subtotales (gravada), igual que el resto de las vistas.

### 7. [P3] Saldos de 0.0049 siguen sumando en agregados que no pasan por `hasCollectibleBalance`

`hasCollectibleBalance` se aplicó a pendientes, vencidos, aging de cobranzas y el botón de cobro, pero otros agregados que suman `balancePen` por documento (por ejemplo, el estado de cuenta o los totales por cliente en reportes) siguen incluyendo la cola. No se encontró un lugar que decida un estado (cerrado/abierto) con `balance > 0` fuera de lo cubierto; el efecto es cosmético (S/ 0.00 en un total). Sugerencia: dejar anotado que los totales monetarios no se filtran.

### 8. [P3] Notas de las pruebas

- `apps/api/src/invoicing/invoicing-math.spec.ts`: bien dirigidas. El caso «pero no por más de lo acreditado» (newTotal 295.04 con count 2, tolerancia 0.03) es el límite exacto; está bien pero depende de la fórmula `(count + 1)`, y si se corrige el hallazgo 5 hay que mover el número.
- `totales-centimo-d377.spec.ts`: la ruta B3 de la web (`linePricing` mandando `unitPricePen`) no está cubierta: el test crea la cotización por API sin precio, que ya tomaba la lista antes de la entrega. Un escenario con el formulario real (elegir producto, no tocar precio, guardar) probaría el cambio del web. El correlativo `uniqueCorrelative()` (últimos 7 dígitos de `Date.now()`) en la serie F904 puede chocar entre corridas rápidas; es poco probable.
- Los tests unitarios modificados de producción (`mounted-kg.spec.ts`, `roofing-math.spec.ts`) cambian los números esperados con comentarios que explican el motivo; no se debilitaron.

## Verificaciones sin hallazgo

- Compatibilidad con datos de 4 decimales: el tope por pedido admite el pedido anterior a R2 (35.4354) facturado entero a 35.44; `documentBalance` recorta saldo negativo a cero, así que una nota de crédito de 35.44 contra un comprobante de 35.4354 no rompe; el cobro precargado se redondea HALF_UP y el tope del API (`payableBalance`, techo) nunca queda por debajo; el esquema de cobro a 2 decimales no afecta al POS (que cobra por el servicio con el total del comprobante, ya al céntimo).
- Vista previa web contra API: el formulario de ventas, nuevo comprobante y POS usan la misma `roundDocumentTotals` sobre la suma de subtotales que `documentTotals`/`sumLineTotals`. Las rutas B1 y B3 usan las mismas funciones que el API.
- Importador: el schema del confirm acepta hasta 10 decimales, redondea con HALF_UP y rechaza ≤ 0; el unitario de 10 decimales alimenta `salesLineTotals` y el subtotal persistido queda a 4 decimales; la tolerancia compara contra el unitario de la fila, como antes.
- Arqueo POS: el esperado y la diferencia se calculan al céntimo en API y web con la misma regla; lo persistido (`expectedCashPen`, `differencePen`) queda coherente. Las cajas ya cerradas conservan sus valores.
- PDF de cotización: `formatMoney` redondea HALF_UP con `cents`; el caso de arrastre a miles está probado.

## Veredicto

Sin P0. Un P1 (hallazgo 1): la suite E2E existente tiene al menos seis aserciones de cabecera que dejan de cumplirse con R2, y la entrega no las actualizó ni, aparentemente, corrió la suite completa; hay que corregirlas y demostrar la suite verde antes del deploy. Los P2 (2, 3, 4) no bloquean el código, pero el 3 conviene resolverlo con el dueño (o dejarlo registrado en D-377) antes de la ventana porque afecta comprobantes importados, y el 2 deja el arreglo A sin prueba de integración real. Con el hallazgo 1 corregido y la suite E2E completa en verde, la implementación de la política es aceptable para pasar a la revisión del dueño.
