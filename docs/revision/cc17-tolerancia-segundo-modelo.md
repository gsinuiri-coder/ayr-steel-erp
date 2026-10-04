# Revisión de segundo modelo (Sonnet, contexto limpio) — cc17 / D-385 C y D

SHA revisado: `3849488` (diff `e6c2789..3849488`; E2E `4f261f4` y docs `62c2bb9` solo mirados de pasada).
Rama: `cc17/importador-bobina`. Solo lectura; no se corrió ningún test. Todos los hallazgos se verificaron leyendo el código citado.

Resumen: 0 P0, 0 P1, 3 P2, 4 P3. Lo central: la tolerancia de espesor se aplica en el preview, en la sugerencia, en el diálogo de confirmar y en el cambio de bobina, pero el alta del importador no la vuelve a exigir en el servidor.

## P2

### P2-1. El `import confirm` ya no valida que la bobina esté dentro de la tolerancia del papel

- `apps/api/src/sales/sales-lines.ts:~852-870` (`assertPaperCoilsInPool`), invocado desde `QuotationImportService.confirm` (`quotation-import.service.ts:~858`).
- Antes de cc17 la fila viajaba con `productId` = SKU del papel, y la comprobación `key.sku !== sale.pool.sku` obligaba a que la bobina fuera exactamente de ese pool. Ahora la fila viaja con el producto de la bobina elegida (`BOB028AZUL`). `coilPoolKeyOfProduct` interpreta primero el código (`normalizeCoilSku`: el código manda sobre la descripción), de modo que `key.sku` es el del producto y siempre coincide con `sale.pool.sku`. La comprobación se volvió una tautología: solo verifica que producto y bobina concuerden entre sí, y nunca compara con el papel.
- Escenario: un cliente HTTP (o una pantalla con preview viejo) manda `{productId: BOB050AZUL, saleCoilId: <bobina 0.50 azul libre>, description: "BOBINA ALUZINC AZUL 0.30 ..."}`. Pasa el pool (`coilPoolFor(sale.pool, qty)` es el pool exacto de la propia bobina) y se crea la cotización con una bobina 0.50 para un papel de 0.30. Es ADMINISTRADOR-only, y la UI no lo permite, por eso P2 y no P1; pero el pedido del dueño era justamente que el servidor no deje colar una bobina fuera de tolerancia y no hay ningún test que lo pruebe (los specs de confirm mockean `quotations.createInTx`).
- Propuesta: en el import confirm (o en `resolveSalesLines` para líneas del papel con `coilPool.paperPool`), derivar el pool del papel de `item.description` (`paperPoolOfLine`) y exigir `thicknessWithin(coil.thickness, paper.thickness, tolerancia)` y mismo atributo. Agregar el test del rechazo. Lo mismo vale para el `PUT /quotations/:id` de una importada: una bobina nueva (no `preexisting`) con producto coherente consigo misma entra con cualquier espesor.

### P2-2. La referencia de espesor del confirm (la descripción) puede diferir de la que usó el importador (el código)

- Importador: `quotation-import.service.ts:~491` llama `normalizeCoilSku({ code, description })` y manda el código. Confirm y cambio en cotización: `paper-coil-assignment.ts:~60` (`paperPoolOfLine`) llama `normalizeCoilSku({ description })` solo con la descripción de la línea.
- Escenario A: fila con código `BOB030AZUL` y columna `productName` vacía. `description` queda `undefined`, y `sales-lines.ts:~363/663` la rellena con el nombre del producto elegido (`Bobina Azul 0.28`) o `Bobina <código> × kg`. Al confirmar, el centro de la tolerancia pasa a 0.28 (o, si no parsea, `lineCoilPool` cae al producto o a la bobina de la línea): candidatas distintas a las del preview, y el diálogo dice «papel: BOB028AZUL».
- Escenario B: código y descripción discrepan (código 030, descripción 0.32): el preview usa 0.30, el confirm 0.32.
- Con el papel real (descripción completa) no ocurre, por eso P2. Propuesta: persistir el SKU del papel (o grabarlo en la descripción de forma normalizada) en vez de re-derivarlo de texto libre; o que el importador exija descripción parseable cuando usa el código para el pool; mínimo, un test de `paperPoolOfLine` con descripción no parseable y con discrepancia.

### P2-3. «Quitar bobina» con reserva temporal vigente probablemente falla con un error de stock

- `quotations.service.ts` (`setItemCoil`, bloque `saleCoilId === null`) deja la línea como `reserveItemType: PRODUCT, reserveItemId: item.productId` y llama `orders.recalculateTemporaryInTx`. Esa función usa `quotationReservableLines` + `linesWithInventory`, que solo descarta líneas de líneas de negocio `NOOP`; TRADING lleva inventario (`carriesInventory`), así que el producto `BOB028AZUL` entra a `reserveLines` y exige stock de un producto que nunca tiene saldo. `confirmPreview` sí aparta las líneas sin bobina (`sales-orders.service.ts:~750-766`), pero ni `reserve-temporary` ni el recálculo lo hacen.
- Escenario: cotización importada con bobina sugerida y reserva temporal viva (la sugerida la reserva); el usuario pulsa «Quitar bobina»: 400 de faltante del producto, y la transacción hace rollback. La línea no se puede quitar mientras exista la reserva. Es seguro (nada queda a medias) pero la acción que D-385 D promete falla con un mensaje engañoso.
- El spec mockea `recalculateTemporaryInTx`, así que no lo ve. Propuesta: que el recálculo (y `reserve-temporary`) excluya las líneas sin bobina de una importada, igual que el preview; añadir test de integración con reserva temporal.

## P3

### P3-1. Redondeo del rango de espesor con una tolerancia de entorno que no es múltiplo de 0.01

- `coil-sale-product.ts` (`coilPoolFor`): `gte/lte` con `toFixedString(center ± tol, 'MM')` redondea el borde a 2 decimales; `coilSkusWithinThickness` (`packages/shared/src/coil-code.ts`) usa `ROUND_CEIL` en el inicio y `lte` exacto en el fin. Con `ROOFING_THICKNESS_TOLERANCE_MM=0.025` y papel 0.30, `lte 0.325` pasa a `0.33` en la consulta (admite una bobina 0.33 fuera de ±0.025) mientras la lista de SKU llega hasta 0.32. Con el valor por defecto 0.02 no pasa. Propuesta: redondear hacia dentro (techo en el borde inferior, piso en el superior) o validar la variable de entorno a centésimas.

### P3-2. Los candidatos del cambio en cotización ofrecen una bobina que otra línea de la misma cotización ya vende

- `quotations.service.ts` (`itemCoilCandidates`) no excluye las bobinas de las otras líneas; `setItemCoil` la rechaza después con 400 («ya la vende la línea N»). El botón «Usar esta» aparece y falla. Propuesta: filtrar en el listado por `reserveItemType = COIL` de las demás líneas.

### P3-3. Carrera sin lock sobre la bobina entre dos cotizaciones

- `setItemCoil` bloquea solo su cotización; dos cotizaciones que elijan la misma bobina libre a la vez pasan ambas `coilPoolFor`/`findCoilTies` (no ven el `UPDATE` no confirmado de la otra). Es la misma debilidad de D-310 en `update`, y confirmar revalida bajo el lock de reservas, así que no hay daño de inventario; basta documentarlo.

### P3-4. Cobertura de pruebas más débil de lo que dicen los nombres

- `quotation-item-coil-d385.spec.ts`: el mock de `coil.findMany` devuelve todas las bobinas sin filtrar por espesor, así que «dentro de tolerancia» en el cambio de bobina no lo prueba el spec (lo cubre `coil-thickness-tolerance-d385.spec.ts` solo para `coilPoolFor` por separado). `recalculateTemporaryInTx` está mockeado (ver P2-3). No hay prueba del rechazo de una bobina fuera de tolerancia en el confirm del importador (P2-1) ni de `paperPoolOfLine` con descripción no parseable (P2-2). El test «sin tolerancia sigue siendo el pool exacto» sí es válido.

## Revisado sin hallazgo

- Rango de espesor y bordes con el valor por defecto (±0.02 → 0.28…0.32, bordes incluidos): correcto, y usa `ROOFING_THICKNESS_TOLERANCE_MM`/`roofingToleranceMm(env)` sin constante nueva.
- Color: el filtro sigue por `attributeOf(finish)` (color comercial o tipo) en `coilPoolFor`.
- Producto por defecto sin bobina: paper SKU existente, si no el único en tolerancia, si hay varios error con selector, si ninguno en rojo. Coherente entre API (`quotation-import.service.ts`) y `resolveRow` de la web.
- Peso: la tolerancia ±1 % sigue en `paperCoilWeightCheck`; la sugerencia y el cambio exigen saldo ≥ kg; el diálogo de confirmar ofrece cualquier saldo marcando «fuera de tolerancia» y el servidor lo re-chequea (`resolvePaperCoilAssignments`, dos pasadas con `exceptSalesOrderId`).
- Confirmar: la bobina elegida debe estar entre `paperCoilChoices` (tolerancia de espesor, libre, sin atar a otra cotización por `findCoilTies`), así que por esa vía no se cuela una bobina fuera de tolerancia; el producto de la línea sale de la bobina; descripción, kg e importe son del papel.
- Auditoría de `setItemCoil` (`sales.quotation.item-coil`, before/after) y el caso «quitar sin bobina» sin escritura: correctos. Estados CONFIRMED/CANCELLED bloqueados; `assertSellerAccess` aplicado en lectura y escritura.
- Decimal: todo con `toDecimal`/`Decimal`; sin `number` para dinero o kg. Barrido: `sameProductKey` empareja por color y espesor dentro de tolerancia, sin ampliar el emparejamiento de productos no bobina.
- UI: el payload del importador manda `saleCoilId` solo si hay bobina y `productId` = producto de la bobina, coherente con la validación del servidor; el diálogo no permite elegir lo que el API rechaza (salvo P3-2).

## Veredicto

Sin P0 ni P1; se puede avanzar a la revisión del dueño con los P2 anotados. Recomiendo corregir P2-1 (validación de servidor) y P2-3 (quitar con reserva temporal) antes del deploy, porque son las dos promesas del alcance que hoy no se cumplen en el servidor. P2-2 se puede resolver con una decisión de dónde guardar el SKU del papel. Los P3 pueden quedar como deuda registrada.

## Qué se hizo con cada hallazgo (agente, después de la revisión)

- **P2-1, corregido.** El confirm del importador valida, para cada fila con descripción del
  papel interpretable, que la bobina elegida (o el producto de bobina con que entra sin bobina) sea
  del mismo color y esté dentro de la tolerancia (`assertWithinPaperTolerance`). Tests: 0.28 para
  0.30 entra; 0.50 para 0.30 no entra; un producto 0.40 sin bobina no entra. El `PUT` ya validaba
  contra el papel de la descripción (`itemCoilCandidates`).
- **P2-2, riesgo aceptado** (registrado en D-385). El confirm y el cambio miden desde la
  descripción de la línea, que es el texto del papel. El importador mide desde el código. Los dos
  archivos reales (agosto y setiembre) traen el espesor en el «NOMBRE PRODUCTO» y coincide con el
  código. Guardar el SKU del papel aparte exige una columna, y esta pieza va sin migración.
- **P2-3, corregido.** Quitar la bobina con una reserva temporal vigente se rechaza con «libérala
  antes de quitar la bobina». Tiene test.
- **P3-1, corregido.** El rango de espesor se redondea hacia adentro (`ROUND_CEIL` y `ROUND_FLOOR`).
- **P3-2, corregido.** Las candidatas del cambio excluyen las bobinas que ya vende otra línea del
  mismo documento. Tiene test.
- **P3-3, sin cambio.** Confirmar revalida bajo lock.
- **P3-4, en parte.** Se agregaron los tests del rechazo del servidor y de la reserva temporal.
  El filtro de espesor del pool se prueba contra un mock que lo aplica, en
  `coil-thickness-tolerance-d385.spec.ts`.
