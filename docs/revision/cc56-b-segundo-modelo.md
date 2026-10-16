# cc56 corte B — revisión de segundo modelo

Modelo: Sonnet (contexto limpio). Diff revisado: `origin/main...origin/cc56-b-costo-bobinas` (25 archivos). Solo lectura; no se corrió nada (ni tests ni CLI).

## Resumen

Sin P0. El motivo `costReason` queda cubierto en los dos caminos de la API (`updateCoilSchema` + guarda en `CoilOperationsService.update`; guarda en `ReceivedPurchaseEditService.commit` sobre el grupo `COST`). Los llamadores de E2E/db-spec/spec con `unitCostPerKg` o `unitPrice` se actualizaron. Los hallazgos están en la CLI y en datos reales en el repo.

## P1

Ninguno estricto. El de datos reales (P2-1) pasa a P1 si el dueño considera el número de comprobante y los importes como datos sensibles (el repo es público).

## P2

1. **Datos reales en el repo.** `apps/api/src/coils/coil-entry-cost.spec.ts` (fixtures) y `coil-entry-cost-checks`'s spec usan el comprobante real `F-1448`, delta `731.23`, peso `4150`, costo `2.6938`/`2.87`, total `11179.27`: son los números del caso C2 de producción. Regla §3.3: datos reales viven en `local-data/`. Arreglo: reemplazar por valores sintéticos (`F001-1`, 100 kg, etc.) conservando la aritmética.
2. **`qtyChangingRows` cuenta todo el kardex, no la bobina** (`fix-coil-entry-cost-cli.ts:212-213`: `tx.inventoryMovement.count({type in IN,OUT})` sin filtro de ítem). En READ COMMITTED, cualquier venta/ingreso concurrente de otro usuario entre `rowsBefore` y `rowsAfter` hace `qtyChangingRows>0` y la corrida se rechaza (falla segura, pero en producción con tráfico el dry-run y el execute fallarían de forma intermitente y confusa). Arreglo: filtrar por `itemType:'COIL', itemId: coil.id` (y `recostOfId: null`), o comparar solo ids de las filas escritas por la corrida.
3. **Costos ajenos a la entrada (landed cost / servicios) no se consideran** (`coil-entry-cost.ts:77-83`). `effective` suma solo la entrada y sus `recost_of_id`; las `ADJUST` de landed cost/flete/servicio imputadas a la bobina (`purchases.service.ts:1120,1260`, `adjustCost`) no entran. El objetivo es `qty × costo/kg × TC` y la ficha `totalCostPen` se fija en `target`, así que en una bobina con landed cost la ficha queda distinta del kardex (y el `entryCostViolations` solo compara contra el delta esperado, no contra la ficha). El camino RF-20 los bloquea (`blockedBy`: landed cost). Arreglo: rechazar si la bobina tiene `ADJUST` sin `recostOfId` (o incluirlas en la ficha), con test.
4. **La vista previa no queda atada a los argumentos** (`fix-coil-entry-cost-cli.ts:169-184,319`). `--execute` solo exige misma rama, mismo commit, <24 h y que la lista `adjusted` coincida. `--motivo`, `--detalle` y `--costo-kg` no se comparan (el costo sí se refleja indirectamente en los deltas; motivo/detalle no), de modo que se puede ejecutar con un motivo distinto al revisado. Arreglo: guardar en la vista previa `coil, unitCostPerKg, costReason, detail, document, deltaPen` y exigir igualdad exacta al ejecutar.
5. **El archivo de vista previa se puede reejecutar** (`executed:false` se conserva tras ejecutar; la ejecución escribe otro archivo). Una segunda ejecución da `add=0`, `outcome=null` y la violación "la entrada no quedó ajustada una sola vez", así que no duplica, pero depende de ese accidente. Arreglo: marcar/borrar la vista previa al ejecutar con éxito.

## P3

1. `costChangeNote` hace `.slice(0,240)` (`cost-change.ts`): el detalle (hasta 240 por `reasonSchema`) más el prefijo del motivo (~25-30 caracteres) se trunca en silencio en la nota del kardex y en `audit.reason`. Arreglo: limitar el detalle a `240 - prefijo` en el schema o no truncar.
2. `coil-entry-cost.ts:98-101`: `totalCost = weightKg × unitCostPerKg` usa `coil.weightKg` mientras el objetivo usa `entry.qty`. Para una bobina partida/reducida pueden diferir; alinear con la misma cantidad.
3. `measure()` castea `tx as unknown as PrismaService` (CLI líneas 117-122): si algún servicio de reporte llama `this.prisma.$transaction` fallaría solo en la CLI. No hay prueba que la ejecute contra una base (solo specs con fakes). Falta un db-spec de `correctCoilEntryCost`/CLI y su par en `lock-order.db-spec.ts` (el orden es coil → saldos vía `recostEntries`; los comprobantes no se bloquean, coherente con la regla 17, pero sin prueba concurrente).
4. UI de compra recibida: la guarda de la API usa el grupo `COST` del plan, la web usa `priceChanged` (algún `unitPrice` en `itemEdits`). Hoy coinciden (solo el precio genera grupo COST). Si un cambio futuro añade otro cambio de grupo COST, el botón quedaría habilitado y la API respondería 400. Mejor derivar `needsCostReason` del `currentPlan.changes`.
5. Los E2E agregaron `costReason` a ediciones que no cambian precio (cabecera, producto, cantidad, acabado); inocuo, pero oculta que no se exige ahí. Un E2E negativo (PATCH sin `costReason` → 400) en API real falta; solo hay unitarios del schema.
6. Falta la decisión D-669 en `docs/ARQUITECTURA.md` §0.2 y en PROGRESO/handoff (no aparece en el diff; presumiblemente va en el cierre).

## Revisado sin hallazgo

- Decimal/dinero: sin `number` en `correctCoilEntryCost` ni en los checks; redondeo `MONEY`.
- Costo efectivo con recosteos previos: `rowCostOfRecost('IN', Σ recost)` igual al de `recostEntries` (que además lo recalcula por su cuenta); TC aplicado como `exchangeRate` de la ficha.
- Entradas múltiples: exige exactamente una entrada viva (sin reversa y que no sea reversa); rechaza si no.
- Regla 8: la corrección solo pasa por `recostEntries`; `tx.coil.update` no es escritura de kardex. Auditoría: `coils.entry-cost-correction` con before/after, motivo e ids ajustados dentro de la misma transacción.
- Regla 17: `lockCoilRows` por su puerta antes de leer; saldos los toma `recostForward`.
- Candado de la CLI: dry-run en transacción revertida; `--execute` exige vista previa de la misma rama, mismo commit sin cambios sucios, <24 h, sin violaciones, y revalida condiciones y ajustes dentro de la transacción (se revierte si difieren); `assertExecuteAllowed` + `assertExternalOutputsOff`; sin credenciales en argv.
- Web: select con `SelectItem` desde `COST_CHANGE_REASONS`, botón deshabilitado hasta elegir motivo, payload condicionado; el rótulo "Motivo" pasó a "Detalle del recosteo"/`getByLabel('Motivo', {exact:true})` en el E2E actualizado.

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
