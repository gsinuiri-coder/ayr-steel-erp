# cc56 corte B (D-669): autorrevisión

**Tipo:** AUTORREVISIÓN (subagente con contexto nuevo, sin leer el handoff). Es una lista de riesgos, no una aprobación, y no vale como pase cruzado.
**Alcance:** `git diff origin/main...origin/cc56-b-costo-bobinas` (25 archivos, commit 339a67f2), leído con `git show` desde la rama remota.
**Fecha:** 2026-10-16

## Resumen

| Sev | Cuántos | Lo esencial                                                                                                                                                                                                                    |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0  | 0       | —                                                                                                                                                                                                                              |
| P1  | 1       | La CI está roja: `prettier --check` falla en `coil-entry-cost.ts`, así que el E2E ni corrió                                                                                                                                    |
| P2  | 3       | `correctCoilEntryCost` deja la ficha mal en bobinas con landed cost o corte imputado y en totales del papel (D-359); acepta hijas de partido y flejes; la comparación al céntimo en la CLI casi nunca cuadra con montos reales |
| P3  | 9       | Detalles de la CLI, la auditoría y la UI (abajo)                                                                                                                                                                               |

No encontré otro camino para cambiar el costo que se salte el motivo. Los dos únicos caminos que cambian el costo de una entrada ya registrada son `PATCH /coils/:id` (CoilOperationsService.update, que pasa por `updateCoilSchema` y además vuelve a comprobar en el servicio) y `received-edit` (comprueba el grupo COST en el servicio). El landed cost y el corte tercerizado (`purchases.service.ts:1120/1260`, `adjustCost`) imputan servicios por documento y no van por la lista, como debe ser.

Los llamadores existentes se actualizaron en todos lados: E2E (`fase2b`, `restaurar-bobina-d375`, `editar-compra-recibida-cc15a/cc15b/d372`), `lock-order.db-spec`, `coil-split-cost.spec`, `coil-split-kerf-cost.db-spec`, `purchase-received-edit.service.spec`. `seed-escenarios.mjs`, `prod-e2e-purge.mjs` y los demás scripts no llaman PATCH /coils con costo ni received-edit con precio.

---

## P1

### P1-1: la CI está roja por formato, y el E2E no corrió

- **Dónde:** `apps/api/src/coils/coil-entry-cost.ts` (archivo entero). Run `38918816804` del PR, job «Lint, typecheck y unit», paso `pnpm format:check`: `[warn] apps/api/src/coils/coil-entry-cost.ts — Code style issues found`.
- **Qué pasa:** el job de lint falla, el E2E queda `skipped` («base: skipped · shards: skipped») y Sonar, el smoke Neon ci y el drift no corren. `main` está protegida por el check de E2E (D-602), así que no se puede mergear. Además, nada del E2E actualizado (los `costReason` nuevos) quedó verificado en CI.
- **Arreglo:** `pnpm exec prettier --write apps/api/src/coils/coil-entry-cost.ts`, empujar y esperar la CI completa en verde (`gh pr checks`).

## P2

### P2-1: `correctCoilEntryCost` vuelve a calcular la ficha como `peso × costo/kg` y pierde el landed cost, el corte imputado y el total del papel

- **Dónde:** `apps/api/src/coils/coil-entry-cost.ts:97-109` (y el cálculo de `target` en :79-81).
- **Escenario:** una bobina a la que se le imputó un flete o el corte con `adjustCost` + `bumpCoilDocumentCost` (`purchases.service.ts:1310-1350`). Su `unitCostPerKg` en la ficha **ya incluye** ese monto por kg, pero en el kardex el monto va en un `ADJUST` aparte, sin `recost_of_id`. La corrección fija la **entrada** en `qty × costo × TC` y escribe ese mismo costo en la ficha:
  - Si el operador pasa el precio del papel (lo que pide «corrección de la compra»), la ficha queda **sin** el landed cost: `unitCostPerKg` y `totalCostPen` quedan por debajo del kardex.
  - Si pasa el costo «de ficha» (precio + landed), la entrada absorbe el landed y el `ADJUST` del flete sigue vivo: el landed se **cuenta dos veces** en el kardex y en la venta.
  - D-359: si la ficha llevaba el total del papel (no `peso × unitario`), `totalCost` se recalcula y el céntimo de reparto se pierde.
- El camino viejo (D-045) no tenía este problema porque bloquea cualquier movimiento posterior al ingreso, el `ADJUST` del landed incluido.
- **Arreglo:** rechazar la corrección si la bobina tiene un `ADJUST` sin `recost_of_id` (landed o corte) o, si se quiere admitir, ajustar la ficha por **delta** (`ficha + add/qty/TC`, igual que `bumpCoilDocumentCost`) en lugar de sobrescribirla. Agregar el test unitario de una bobina con landed.

### P2-2: acepta la entrada de una hija de partido o de un fleje

- **Dónde:** `coil-entry-cost.ts:58-72`. Solo filtra `type: 'IN'`, sin reversa y vivo; no mira `refType` ni la madre.
- **Escenario:** la entrada de una hija (D-608) o de un fleje (D-597) vale su parte del valor de la madre, y esa parte cuadra contra la salida de partido o de corte de la madre. Recostear solo la hija crea o destruye valor sin contrapartida en la madre. Para una hija vendida, la CLI pasa todas sus condiciones: solo hay salidas `SALE`, de un solo ítem y un solo comprobante.
- **Arreglo:** exigir que la entrada sea de compra o de inventario inicial (`refType` en `PURCHASE`/carga inicial) y que la bobina no tenga madre (`parentCoilId` o `cuttingOrderCoil` nulos), con un mensaje que mande a corregir la madre.

### P2-3: «cuadra al céntimo» compara montos de 4 decimales contra un `--delta` de 2 y casi nunca cuadra

- **Dónde:** `apps/api/prisma/fix-coil-entry-cost-cli.ts:288` (`addPen: …toFixed(2)`) frente a `coil-entry-cost-checks.ts:73-77` (`outTotal.eq(want)`, exacto a 4 decimales) y :82-87 (los reportes, exactos).
- **Escenario:** `target = qty × costo × TC` redondeado a 4 decimales. Con pesos y TC reales, `add` casi siempre tiene céntimos fraccionarios (por ejemplo 731.2347). Con `--delta 731.23`: `addPen` (toFixed(2) = 731.23) cuadra, pero `outTotal` (731.2347) no, y la CLI rechaza. Con `--delta 731.2347`: no cuadra `addPen`. La corrida falla cerrada, así que no es un riesgo para los datos, pero el caso del test (4150 × 2.87 = 11910.50 exacto) es el único que pasa.
- **Arreglo:** comparar todo con la misma escala. O `--delta` acepta 4 decimales y `addPen` no se redondea, o las tres comparaciones se hacen a `toDecimalPlaces(2)` con una tolerancia explícita de ±0,005. Agregar un test con un `add` no redondo.

## P3

1. **La ejecución no compara sus argumentos con los de la vista previa** (`fix-coil-entry-cost-cli.ts:169-184`, :319). El `adjusted` comparado cubre la bobina y el monto, pero no `--motivo` ni `--detalle`: se puede ejecutar con otro motivo que el revisado. Arreglo: comparar `coil`, `unitCostPerKg`, `costReason`, `detail` y `expected` con `previous`.
2. **La vista previa no queda marcada como usada** después de `--execute`: se escribe `EJECUCION-*.json`, pero `VISTA-PREVIA-*.json` sigue con `executed: false`. Una segunda ejecución la rechaza igual (porque `add = 0` no coincide con el `adjusted` de la vista previa), pero el candado `previous.executed` de :170 nunca se activa. Arreglo: reescribir la vista previa con `executed: true` al terminar.
3. **`movementCount` cuenta todas las filas IN/OUT de la base** (:212-213), y la transacción puede durar hasta 600 s en producción. Cualquier despacho o recepción concurrente da el falso rechazo «la corrida escribió movimientos con cantidad». Falla cerrada. Arreglo: contar solo las filas del ítem de la bobina o las creadas por el actor dentro de la transacción.
4. **Ventas y margen por mes** (:126-132): `documentMargin` se pisa en cada mes. Si el comprobante tiene despachos en dos meses, se queda con el costo del último y la condición falla cerrada. Arreglo: sumar entre meses.
5. **`fiscalDocument.findFirst({ number })`** (:200) no filtra por tipo ni serie. Con números repetidos entre factura y boleta, toma uno arbitrario. Falla cerrada. Arreglo: exigir serie-número o `docType`.
6. **La entrada se toma con `entry.qty` y la ficha con `coil.weightKg`** (`coil-entry-cost.ts:79` frente a :98-101). Si difieren, `totalCost` y `totalCostPen` quedan en bases distintas. El camino viejo usa `initial.qty` para los dos (`coil-operations.service.ts:1205`). Arreglo: usar `entry.qty`.
7. **Auditoría y visor:** `coils.entry-cost-correction` no está en `AUDIT_ACTION_LABELS` (`packages/shared/src/audit-labels.ts`), así que el «Historial» la humaniza en crudo. `costReason` también se ve como `PURCHASE_CORRECTION` (no hay etiqueta en `audit-values`). El `before` de la corrección no guarda `totalCost`. Arreglo: agregar la etiqueta de la acción y la de los valores de `costReason`.
8. **`received-edit` no usa `costChangeNote` en las notas del kardex.** El motivo de la lista va solo a la auditoría (`purchase-received-edit.service.ts:225`), mientras que en la bobina va también a la nota del movimiento (`coil-operations.service.ts:1229/1247`). Es inconsistente para quien lee el kardex.
9. **UI y API:**
   - En los dos diálogos, «Guardar» queda deshabilitado sin decir que falta el motivo (`canSave`/`canSubmit`). El hint está, pero no se resalta el campo.
   - `updateCoilSchema` exige `costReason` por la sola presencia de los campos de costo, aunque no cambien. La web no los reenvía, pero un cliente de API que reenvíe el mismo costo (el caso de cc46, «costUnchanged») ahora recibe un 400.
   - `export { Decimal };` al final de `coil-entry-cost.ts` es un reexport sin uso aparente.
   - Bypass ya existente y fuera de alcance: anular la compra recibida y volver a cargarla con otro precio no pide motivo. Habría que dejarlo anotado en D-669.

## Comprobado sin hallazgo

- Orden de bloqueos: `lockCoilRows(coil)`, después se lee la entrada (D-474), después `recostEntries` → `recostForward` (bobinas con NOWAIT y después saldos, en orden canónico). Bobinas antes que saldos (regla 17).
- Regla 8: `coil-entry-cost.ts` no escribe `inventory_movements` ni `inventory_balances`. El kardex lo escribe solo `recostEntries`, y la ficha (`coils`) se actualiza aparte.
- Costo efectivo: `effective = totalCost + Σ recosteos (recost_of_id = entrada)`, el mismo cálculo que `recostEntries`. El test cubre un recosteo previo.
- La CLI comprueba las condiciones **dentro** de la transacción, antes del commit (:317-325); si algo no cuadra, lanza y revierte. El wrapper `run-api-cli.mjs` saca `--confirm-production` antes de `assertArgs`. Dry-run por defecto; `--execute` exige vista previa de la misma rama, del mismo sha limpio y de menos de 24 h.
- Los servicios de reportes que usa `measure` no llaman `$transaction`, así que el cast de `tx` a `PrismaService` funciona.
- La web manda `costReason` solo cuando cambia el costo o el precio, y el select se reinicia al abrir el diálogo de la bobina. El diálogo de la compra se monta abierto, con estado nuevo en cada apertura. La clave de idempotencia se arma con el cuerpo, que incluye `costReason`.
- En `received-edit`, solo el precio produce el grupo COST (`purchase-received-edit.ts:497-525`). Moneda, TC e IGV no se editan en esta versión, así que no hay otro cambio de costo sin motivo.
- `correctCoilEntryCost` no se expone por HTTP: solo lo usa la CLI.

## Resolución (cc56, antes del despliegue)

- **P1-1 (autorrevisión), CI en rojo por formato:** `prettier --write` y CI de nuevo.
- **Datos del caso real en el spec (segundo modelo P2-1):** `coil-entry-cost.spec.ts` usa números sintéticos.
- **Bobinas con ajustes de costo propios (P2 en las dos):** `correctCoilEntryCost` rechaza la bobina si tiene un `ADJUST`
  sin `recost_of_id` (landed cost, corte tercerizado): la ficha no los explicaría. Mismo criterio que RF-20.
- **Hijas de partido y flejes (autorrevisión P2-2):** se rechazan (`parentCoilId` o `kind ≠ COIL`).
- **Escala de céntimos (autorrevisión P2-3):** el monto esperado se compara al céntimo; las salidas y los reportes, con lo
  que de verdad subió la entrada, a cuatro decimales.
- **CLI (segundo modelo P2-2, P2-4, P2-5):** cuenta solo las entradas y salidas de la bobina; `--execute` exige los mismos
  argumentos que la vista previa (bobina, costo, motivo, detalle, comprobante y monto); tras ejecutar, la vista previa queda
  marcada como ejecutada; el comprobante se busca entre facturas y boletas.
- **Anotados sin cambio (P3):** db-spec de `correctCoilEntryCost` y su par en `lock-order` (se ejerció entero en el dry-run de
  producción, con la transacción revertida); etiquetas del «Historial» para `coils.entry-cost-correction` y `costReason`;
  la nota del kardex de «Editar compra» sin el motivo (va en la auditoría); el botón sin decir qué falta; reenviar el mismo
  costo pide motivo; E2E negativo del 400.
