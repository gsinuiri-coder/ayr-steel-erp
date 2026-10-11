# Revisión segundo modelo — cc46 corte B (D-608), 282143ee..d4b46718

Solo lectura por SHA; no corrí pnpm, jest ni bases (las aserciones numéricas las verifiqué a mano).

## Resumen

El cambio es correcto y mínimo: reutiliza `receptionCosts`/`prorateReceptionValue` (D-597) tal cual, dentro de la misma transacción de `split`, sin locks nuevos, sin tocar qué se puede partir, y pasando por `InventoryService.record` (vía `CoilsService.create` con `kardexTotalCostPen`). No encontré P0 ni P1. Hay un P2 (aserción del db-spec dependiente del estado global) y varios P3.

## Hallazgos

### P2-1 — db-spec: test del valorizado lee un total global

`coil-split-kerf-cost.db-spec.ts` (último `it`, ~l.350-365): `valuation.valuation({ businessLine: 'drywall' })` suma TODO el drywall de la base. Con `--runInBand` (package.json `test:db`) no hay concurrencia entre specs, así que hoy es estable; pero si alguna vez `test:db` se parte en shards/workers (D-596 ya reparte E2E en shards) o el valorizado cachea/redondea por línea, el delta antes/después puede moverse por algo ajeno. Además el total se muestra a 2 decimales y la cota es 0.075: un redondeo por línea de ±0.01 sigue cabiendo, pero la prueba depende de ese margen.
Corrección sugerida: comparar el valor del ítem (Σ kilos × avgCost de madre+hijas desde `inventoryBalance`, antes y después) en vez del reporte global, o dejarlo y documentar «requiere runInBand».

### P3-1 — `inspect:cc46` sigue contando como «perdido» el kerf de partidos posteriores a D-608

`inspect-cc46-cli.ts`: no distingue partidos anteriores y posteriores al despliegue. Una vez desplegado, el kerf de los partidos nuevos ya NO se pierde, pero el CLI lo suma en `kerfValuePenAtOutCost`. Corrección: filtrar por fecha de corte (despliegue de D-608) o comparar la suma de entradas de hijas contra `out.totalCost` (diferencia ≠ 0 = valor perdido) en vez de asumir pérdida. Además valoriza con `kg × out.unitCost` (promedio a 4 decimales) y no `out.totalCost × kerf / split`; diferencia de centavos, informativa.

### P3-2 — `kardexUnitCostPen` quedó sin llamadores

`coils.service.ts:103,244`: tras este cambio ningún llamador lo pasa (grep en apps/e2e/scripts). Código muerto; retirar o dejar anotado. No afecta datos.

### P3-3 — Recosteo (D-045) de una hija usa el costo del documento redondeado

`coil-operations.service.ts` `update` reingresa a `unitCostPerKg × exchangeRate` (4 decimales). Para una hija de D-608 el kardex entró con `parte/kilos` y el documento con el costo escalado; difieren ≤ ~0.0001/kg (visto en la propia aserción `≤ 0.0001` del db-spec). Es el mismo comportamiento que ya tienen los flejes de D-597; no es defecto, solo anotarlo. Lo mismo para D-164 (sobrante con saldo 0 valorizado al documento).

### P3-4 — Cobertura no verificada por mí

No pude correr: `lock-order.db-spec.ts`, specs unitarios de `coil-operations` y e2e que parten bobinas (no encontré aserciones de «hija = costo de la madre» al grepear, pero un e2e podría compararlos). Conviene confirmar en la CI.

## Verificado sin hallazgos

- Aritmética: la suma de `childrenValuesPen` es exactamente `out.totalCost` (partes truncadas a 4 dec., la más pesada —la primera en empate— absorbe el resto, nunca negativo). Σ pesos de hijas = `splitWeight − kerfLossKg` por construcción de `planCoilSplit` (acumulado redondeado), así que `childrenKg > 0` siempre; no hay división por cero (`prorate` además devuelve 0s si Σ=0, y `documentUnitCost` cae al de la madre si `childrenKg ≤ 0`).
- Sin kerf ni borde: `documentUnitCost = costo madre`, y el kardex de cada hija queda al promedio de la madre (el db-spec lo prueba; sumas cuadran con `out.totalCost`).
- Partido parcial: la madre conserva saldo y promedio (la salida es al promedio); solo el valor de lo partido se reparte. Valorizado total se mueve ≤ kilos × 0.00005 (redondeo del promedio a 4 dec.).
- USD vs PEN: kardex en soles (`kardexTotalCostPen`), documento en la moneda de la bobina escalado 4 dec.; `totalCostPen` de la hija = entrada del kardex. Cifras del db-spec revisadas a mano: 983.607 / 918.032 / 98.361 kg, 405.58 de kerf, 4.3367, 30 925.60 en USD, 3×327.869 con resto en la primera: todas correctas.
- Reversa (`revertSplit`): sin cambios en el código; revierte entradas de hijas y luego la salida por `inventory.reverse` con el `totalCost` original de cada movimiento, así devuelve el valor exacto (aserción de reversa en el db-spec coherente). Restauración de hija anulada usa el costo del movimiento de entrada (`coil-restore.ts`), no el documento.
- Flejes (`kind` heredado, D-049): el escalado del documento aplica igual; sin conflicto con RF-41.
- Reglas del repo: kardex solo por `InventoryService.record`; todo `Decimal`/strings; misma transacción; ningún lock nuevo; sin migración; sin cambios en reservas, montaje ni elegibilidad. `kerfValuePen` en auditoría usa la misma fórmula que `receptionCosts`.
- CLI `inspect:cc46`: mismo patrón que cc38/cc44 (`SET TRANSACTION READ ONLY` como primera sentencia de la transacción, `assertExecuteAllowed(false)`, `assertExternalOutputsOff`, rechaza argumentos, solo `findMany`/`groupBy`); registrado en `tsconfig.cli.json`, `package.json` y `scripts/`. Realmente solo lee.
- seed-escenarios: S1 coherente (1 000 kg, 1 220 mm, 600+560, kerf 20 → `kerfLossKg` 49.180, rendimiento 0.95 ≥ 0.8); anular primero los partidos (revertir) antes de cancelar compras es el orden correcto (RF-16, hijas comparten `purchaseId`); no altera los filtros de «flejes en stock» (hijas son `COIL`) ni de «bobina libre» (0.50 mm / 1 000 kg); diez compras vivas es el recuento correcto. Si el dueño ya consumió las hijas en el preview, la reversa falla dentro de `attempt` y la compra no se anula (comportamiento degradado aceptable, queda en el aviso).
