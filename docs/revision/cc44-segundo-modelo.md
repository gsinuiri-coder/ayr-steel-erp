# Revisión de segundo modelo: cc44 (kerf con costo, perfiles a stock; D-597..D-601)

- **Fecha:** 2026-10-11
- **Revisor:** segundo modelo, Sonnet, contexto limpio (no es una persona; AGENTS.md §2, punto 2.2).
- **Alcance:** `git diff origin/main...HEAD` (19 archivos: `cutting.service.ts`, `cutting-math.ts`,
  `coils.service.ts`, `cutting-kerf-cost.db-spec.ts`, la web de planta/producción/pedidos, tres E2E, el
  diagnóstico `inspect-cc44`).
- **Método:** solo lectura. No corrí jest, db-spec ni Playwright: lo que sigue sale de leer el código y de
  cuentas a mano. Los valores de los E2E ajustados (4.2069, 4.4172, 6517.2422) los recalculé a mano y
  cuadran; no los ejecuté.

Resumen: 0 P0, 0 P1, 2 P2, 4 P3. La aritmética del kerf es correcta; los hallazgos son de cobertura de
pruebas y de consistencia de cifras secundarias.

---

## Hallazgos

### P2-1. Ninguna prueba cubre un costo del documento en USD ni una madre con landed cost

- **Archivos:** `apps/api/src/cutting/cutting-kerf-cost.db-spec.ts` (solo `currency: 'PEN'`, madre sin
  landed cost); `apps/api/src/cutting/cutting.service.ts:306-314` (`documentUnitCost`).
- **Escenario:** el valor que se reparte (kardex, en soles) y el costo del documento (`coil.unitCostPerKg`, en
  la moneda de la bobina) se calculan por caminos distintos: el primero sale de `out.totalCost` (promedio del
  kardex, que incluye landed cost, D-043) y el segundo de `coil.unitCostPerKg × kilos que salieron / kilos en
fleje`. En PEN sin landed cost coinciden; en USD, o con landed cost ya imputado al kardex pero no al
  documento (o al revés), el fleje queda con kardex y documento en proporciones distintas. Eso ya pasaba antes
  del cambio (el documento heredaba `unitCostPerKg` y el kardex heredaba el promedio), así que no es una
  regresión, pero D-597 no lo menciona y ninguna prueba lo fija. Lo revisé en código: el factor del documento
  usa solo kilos, no soles, y `bumpCoilDocumentCost` (factura de corte) divide por el tipo de cambio de la
  bobina, que se hereda; no vi un error, solo una zona sin red.
- **Corrección sugerida:** sumar al db-spec un caso con madre en USD (TC 3.7xxx) y otro con un landed cost
  previo, y afirmar (a) la suma de los flejes en el kardex = salida de la madre y (b) que
  `unitCostPerKg × TC` queda dentro de la tolerancia esperada del `totalCostPen` del fleje, o documentar en
  D-597 que no es igual.

### P2-2. La prueba de «reversa exacta» comprueba en parte una tautología

- **Archivo:** `apps/api/src/cutting/cutting-kerf-cost.db-spec.ts` (test «la reversa de la recepción lo
  deshace exacto»).
- **Escenario:** `reversal.totalCost == m.totalCost` es verdad por construcción (`InventoryService.reverse`
  copia `origValue`, `inventory.service.ts:~512`), así que no detectaría un error en el reparto. Lo que sí
  prueba el test es que la madre vuelve a 2000.000 kg y 4.1234, y eso es lo valioso. No prueba que el
  valorizado total (Σ qty × avgCost de madre y flejes) vuelva al de antes de recibir, que es lo que importa al
  dueño.
- **Corrección sugerida:** afirmar el valorizado de la madre antes de recibir y después de revertir
  (`qty × avgCost` iguales), y que el saldo de cada fleje queda en 0 kg y `avgCost` 0.

### P3-1. El valorizado por saldo (`qty × avgCost`) no cuadra al céntimo con la suma de movimientos

- **Archivos:** `apps/api/src/inventory/inventory.service.ts:926` (`avg_cost Decimal(18,4)`), `writeBalance`
  (~761).
- **Escenario:** la suma de las entradas de los flejes es exactamente `out.totalCost` (verificado: el reparto
  cierra por construcción y `out.totalCost` es el valor ya redondeado que se guardó). Pero cada saldo guarda el
  promedio a 4 decimales. En el caso del db-spec, la madre sale por S/ 6 185.1000 y el fleje de 737.705 kg
  recibe ≈ S/ 3 199.08, es decir 4.33667/kg, que se guarda como 4.3367: el valorizado por saldo del fleje
  difiere unos S/ 0.02 de su movimiento. Pasa con toda entrada del sistema (D-359 igual); el reporte que sume
  movimientos cuadra, el que multiplique saldo × promedio puede variar centavos. No afecta la reversa
  (`stockAfterReverseIn` cierra en 0 cuando no quedan kilos).
- **Corrección sugerida:** nada en código; aclarar en D-597 que «al céntimo» vale para el kardex (movimientos),
  no para `qty × avgCost`.

### P3-2. `coil.totalCost` (documento) y `coil.totalCostPen` del fleje ya no coinciden en PEN

- **Archivo:** `apps/api/src/coils/coils.service.ts:164-170`.
- **Escenario:** con `kardexTotalCostPen`, `totalCostPen` guarda el reparto exacto, pero `totalCost` se calcula
  como `weightKg × unitCostPerKg` con el unitario ya redondeado a 4 decimales. En una bobina en PEN (TC 1) las
  dos columnas difieren hasta ≈ `peso × 0.00005` (S/ 0.04 en un fleje de 737 kg). Antes de D-597 eran iguales
  en PEN. Ningún reporte que revisé las compara; las fichas muestran una u otra. No lo pude llevar a un número
  visible.
- **Corrección sugerida:** aceptar y anotarlo, o derivar `totalCost` del reparto dividido por el TC (con cuidado:
  `cents()` redondea a 2 decimales y rompería el cierre exacto del kardex, así que habría que usar `money()`).

### P3-3. Asimetría entre corte tercerizado y partido interno

- **Archivos:** `apps/api/src/coils/coil-operations.service.ts:143-148` (el comentario sigue diciendo que «el
  valor del inventario solo pierde lo que se lleva la merma de corte»); `cutting.service.ts`.
- **Escenario:** el mismo kerf físico ahora se capitaliza en los flejes si lo corta un tercero y se pierde si lo
  parte la planta. Es la decisión del dueño (D-597 dice «el partido interno no cambia»), pero conviene que
  quede dicho en la ficha de D-597 con la razón, para que la siguiente sesión no «arregle» el partido.

### P3-4. «Piezas teóricas» entero en pantalla vs. teórico exacto en el cierre

- **Archivos:** `apps/web/src/app/(app)/planta/drywall-order-panel.tsx:~227`,
  `apps/web/src/app/(app)/produccion/[id]/produccion-detalle-view.tsx:~154`.
- **Escenario:** la nota «Fleje montado: +N vs. reportado» usa el entero hacia abajo; el cierre calcula la
  merma de proceso con el teórico decimal. Con 1 199.6 teóricas y 1 199 reportadas, la pantalla dice «+0» y el
  cierre calcula 0.6 pieza de merma. D-600 lo declara («solo pantalla»), así que es cosmético; lo anoto por
  si el operario pregunta por qué no cuadra.

---

## Lo que verifiqué y no encontró problemas

- **Suma exacta del reparto.** `prorateReceptionValue` (`cutting-math.ts:36-62`): cada parte se redondea a 4
  decimales y el fleje más pesado (primer índice en empate, comparación estricta `gt`) recibe
  `total − Σ otros`, así que Σ partes = `out.totalCost` sin residuo. Recalculé a mano los casos del spec
  (12000 sobre 1475.410/1377.049 → 6206.8973 + 5793.1027; 100 sobre 1/3/3 → 14.2857/42.8572/42.8571): coinciden.
  Con valor 0 o sin kilos devuelve ceros (sin división por cero). El único borde teórico (valor total de
  unos pocos diezmilésimos repartido entre muchos flejes dejaría negativo al más pesado y
  `assertTotalMatchesUnit` lo rechazaría) no es alcanzable con costos reales.
- **El valor que se reparte es el que salió.** `out.totalCost` es la fila del kardex ya guardada
  (`createMovement`, `toFixedString(.., 'MONEY')`), no un recálculo; el reparto no puede quedar distinto de lo
  que se restó a la madre.
- **Kilos de flejes vs. denominador del documento.** `childrenKg = splitWeightKg − kerfLossKg` es igual a la
  suma de `plan.children[].weightKg` (`planCoilSplit`: `kerfLossKg = splitWeight − previousWeight`), y es
  > 0 porque cada hija pesa > 0. Sin división por cero.
- **Coherencia con `InventoryService`.** El IN llega por `record` con `totalCost` y `unitCost = total/kg`
  redondeado a 4; `assertTotalMatchesUnit` (tolerancia 0.00005) pasa por construcción. Regla dura 8: no
  hay escritura nueva a kardex fuera de `InventoryService`; el centinela no se toca. Regla 9: todo el cálculo
  usa `Decimal`/`money`/`toFixedString`, sin `number`. Regla 17: el orden de bloqueos de `receive`
  (orden → fila → bobina → saldo de la madre → altas de flejes) no cambió.
- **Reversa.** `reverse` (`cutting.service.ts`) revierte cada IN de fleje (valor = el que entró, sacado de la
  fila del movimiento) y luego la OUT de la madre (vuelve `origValue`, y con 4.1234 × 500 + 6185.1 el promedio
  recompone en 4.1234). Funciona igual para recepciones anteriores a D-597, porque usa los valores grabados en
  cada movimiento, no recalcula. La guarda de «movimientos posteriores del fleje» sigue impidiendo revertir
  tras una factura de corte (comportamiento previo, sin cambios).
- **Factura de corte posterior.** `applyCuttingOrderCost` reparte por kilo disponible con `adjustCost` sobre los
  flejes y sube el costo del documento con `bumpCoilDocumentCost`; no asume nada del costo de entrada del
  fleje. El E2E ajustado en `fase3.spec.ts` (4.2069 → 4.4172, totalCostPen 6517.2422 / 6082.7578) coincide con mi
  cálculo (12000/2852.459 = 4.2069; +600/2852.459 = +0.2103).
- **Otros módulos que podrían asumir «fleje al costo de la madre».** Revisé `purchase-received-edit.service.ts`
  (ya advierte que los flejes conservan el costo con que nacieron), `coil-close-math` / `coil-operations`
  (usa `avgCost` del saldo y el unitario del documento solo para sobrantes sobre saldo 0),
  `production*.ts` (costea con el kardex del fleje), `kardex-peps.service.ts` (clasifica CUTTING IN/OUT como
  26/27 de SUNAT: con el cambio el valor de entrada ya iguala al de salida, más consistente que antes),
  reportes (`receivedKerfLossKg` solo se muestra en pantalla, nunca se valoriza). Ninguno rompe.
- **`inspect-cc44-cli.ts`.** Transacción `READ ONLY`, sin argumentos, sin modo execute, sin credenciales en
  argv, registrado en `tsconfig.cli.json` y `package.json`.
- **Web.** No quedan lecturas de `targetPieces` ni de `reservationId` para crear órdenes de perfiles
  (`grep` en `apps/web/src`); el resto de usos de `reservationId` son otras pantallas (liberar/restaurar). Se
  quitaron los imports huérfanos (`Input`, `ReservationDto`, `MAX_REPORT_PIECES`, `unitSymbol`). El panel pasa
  a 4 columnas sin dejar hueco. `formatUnits(x.toFixed(0))` formatea con separador de miles y símbolo,
  consistente con «Alcanza para».
- **E2E existentes.** Ningún spec escribe en «Meta de piezas» ni «Pedido a atender» por la UI (`grep` en
  `e2e/`); los que mandan `targetPieces`/`reservationId` lo hacen por API, que sigue aceptándolos
  (fase4, fase4-bordes, fase5a, fase7final, idempotencia, kardex-clickable). `fase3.spec.ts` y
  `fase7e-ajustes-d121.spec.ts` quedaron ajustados; `fase3b` y `fase7-consolidada` recibe a 600+600 sobre 1200
  (sin borde) o solo verifican saldos de la madre, así que su costo no cambia (no los ejecuté).
- **E2E nuevo `drywall-stock-cc44.spec.ts`.** Prueba lo que dice (rebote sin stock con «disponibles» y SKU en
  el mensaje, OP sin reserva ni pedido ni meta, confirmación con stock y reserva `PRODUCT` sin OP); limpia su
  rastro en `finally` y se salta contra producción.
- **Datos reales.** D-597 anota que producción no tenía recepciones de corte (según `inspect:cc44`); el cambio
  no migra ni repara nada y no toca el schema.

## Atención de los hallazgos (sesión cc44)

Sin P0 ni P1. La autorrevisión (subagente sin el handoff) tampoco encontró P0 ni P1.

- **P2-1 (USD):** nuevo caso en `cutting-kerf-cost.db-spec.ts`: bobina en USD. El kardex reparte
  en soles exacto, el documento sube en dólares en la misma proporción y el `totalCostPen` del
  fleje es su valor de kardex. El landed cost no tiene caso propio: el reparto toma el `totalCost`
  de la salida ya grabada, sea cual sea el promedio de la madre.
- **P2-2 (reversa tautológica):** el caso de reversa ahora compara el saldo y el promedio de la
  madre con los de antes de recibir, comprueba el valor cero de los flejes y vuelve a recibir
  (segunda generación, suma exacta otra vez).
- **Borde de la autorrevisión (parte negativa del fleje pesado):** las partes se truncan a 4
  decimales en vez de redondear al más cercano; el resto del pesado nunca es negativo. Unitario
  nuevo en `cutting-math.spec.ts`.
- **P3-2 y P3-3:** anotados en D-597 (`totalCostPen` = valor de kardex, como D-359; el partido
  interno no cambia a propósito).
- **P3-1 y P3-4:** se quedan como están (el «al céntimo» es el del kardex; la pantalla entera es
  D-600).
