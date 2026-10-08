# cc34 corte 1 (B1) — revisión de segundo modelo

- Modelo: Claude Sonnet 5.5, contexto limpio (no leyó handoffs ni `local-data/`).
- Commit revisado: `624ac9ab` contra `d2b21624` (`git diff d2b21624..624ac9ab`, 8 archivos).
- Corrido: `pnpm --filter @ayr/api exec jest src/production/roofing-scrap` → 15/15 verdes. No se corrió nada contra bases de datos ni E2E.
- Alcance: `roofing-scrap.ts` y su spec, el cambio en `closeInTx` de `roofing-production.service.ts`, `reopen`, `close-preview.ts`, el E2E nuevo y `inspect-cc34-cli.ts`.

Resumen: sin P0 ni P1. Hay un P2 de redondeo (puede dejar una asignación que no cierra con el despunte), un P2 de especificación (el desborde entre bobinas del camino «declarado por parte») y varios P3.

## Hallazgos

### P2-1 — `splitProportionally` puede dar una cuota negativa con 3 o más claves y un total chico

`apps/api/src/production/roofing-scrap.ts:96-107`.

Las cuotas de todas las claves menos la última se redondean con `roundTo` (a 3 decimales, mitad hacia arriba), y la última toma `total − asignado`. Si las primeras redondean hacia arriba, la última sale negativa.

Escenario: total escrito que deja 0,002 kg de exceso con 4 bobinas vivas de peso reportado igual. Cada una de las tres primeras da 0,0005, que redondea a 0,001, y suman 0,003. La cuarta queda en −0,001.

Consecuencia en `allocateRoofingScrap`:
1. `targets` suma 0,002 (por tanto `scrapKg` y `declaredKg` salen con 0,002).
2. En el tope por saldo, la cuota negativa no entra a `placed` (`take.gt(0)` es falso) y tampoco suma a `overflow` (`kg − take = 0`).
3. `placed` queda con 0,003 repartido en tres bobinas.
4. El kardex sale 0,003 kg y `scrapKg`, `consumedKg` y el costo de la orden dicen 0,002.

Pasa solo con 3 o más bobinas con peso y un exceso de unos pocos gramos. Es improbable, pero rompe la invariante «la suma de lo repartido es el despunte», que el spec declara probar. El mismo defecto existe en el reparto de `delta` de un parte con 3 o más bobinas.

Propuesta:
- Repartir por acumulado, como `planCoilSplit`: la cuota i es `round(total × acumulado_i / suma) − round(total × acumulado_{i−1} / suma)`. Así nunca queda negativa si el total no lo es.
- O acotar cada cuota a `[0, resto]` (para totales positivos).
- Sumar un test con 4 bobinas y total 0,002.

### P2-2 — Desborde entre bobinas en el camino «declarado por parte» (a confirmar con el dueño)

`roofing-scrap.ts:200-221`, comentario en las líneas 16-18, y test «lo declarado por parte también se topa en el saldo de su bobina y el resto pasa a otra» (`roofing-scrap.spec.ts`).

La especificación B1 dice «exceso por bobina, con tope en su saldo, **sin compensación entre bobinas**». El sobrante a la siguiente bobina con saldo se pidió solo para el total escrito. El código aplica el desborde a los dos caminos. Con B declarando 110 sobre 100 y solo 3 kg de saldo, los 7 kg restantes salen de A, aunque ningún parte de A los declaró. Es una compensación entre bobinas por otra vía.

La alternativa es rechazar con el mensaje de D-089: «La orden tiene X kg montados…», pero por bobina. El comportamiento actual es defendible porque no deja la orden sin poder cerrarse, pero no está en la especificación.

Propuesta: pedir al dueño que confirme. Si no quiere desborde ahí, lanzar `BadRequestException` cuando `kg > room` en el camino por parte. Si lo quiere, dejar escrito en la decisión `D-nnn` (D-539 se cita en el comentario) que el desborde rige para ambos caminos.

### P3-1 — Objetivos sobre bobinas que ya no están vivas

`roofing-scrap.ts:187-193` y `:200-206`.

Si un parte sacó de una bobina que planta bajó antes del cierre (fila con `releasedAt`), su exceso queda en `targets` con capacidad 0. El tope lo manda íntegro a `overflow` y termina en la primera bobina viva. En la rama de una sola bobina viva es el piso global de siempre y es coherente. En la de varias bobinas vivas se carga a la «siguiente con saldo» el despunte de una bobina ajena.

Propuesta: documentarlo en el docblock, o rechazar. No bloquea.

### P3-2 — Un exceso sobre un parte con salida total 0 se pierde en silencio

`roofing-scrap.ts:96-107` (`splitProportionally` devuelve vacío si `weightSum ≤ 0`) y `:193-196`.

Un parte con `declaredKg > 0` y sus salidas en cero, o con fallback de teórico 0, tiene `delta > 0` y ninguna clave con peso. El `for` no suma nada y el exceso desaparece sin error. En la rama del total escrito sí hay un caso de reserva (`shares.size === 0 && excess.gt(0)` va a la primera viva). En la rama por parte no hay equivalente. Es un caso casi imposible: un parte siempre saca kilos.

Propuesta: mandar el delta a la primera bobina viva, como en la otra rama.

### P3-3 — Un parte sin salida de kardex se imputa a la primera bobina viva

`roofing-scrap.ts:113-120`.

Es lo que se declara y es consistente con `reportsOutKg`. Pero en la rama de varias bobinas su teórico y su exceso quedan en la bobina de montaje más antigua, que es justo el sesgo que B1 quería quitar. «No debería pasar», así que no importa en la práctica.

Propuesta: sin cambio; agregar un `Logger.warn` o un test que lo fije no vendría mal.

### P3-4 — Un solo `explicitTotalKg` truthy

`roofing-production.service.ts` (`input.consumedKg ? … : null`).

Un `consumedKg: '0'` o `''` se trata como «no escrito». Es igual que antes (`input.consumedKg ? …`), así que no es regresión. Se anota porque ahora el efecto es otro: antes caía al valor por parte, igual que ahora.

### P3-5 — Cobertura

Faltan:
- Test de 3 o más bobinas (P2-1).
- Un parte con `declaredKg` y bobinas mezcladas con `explicitTotalKg` y bobina no viva (P3-1).
- Una cobertura o accesorio cerrado por la vista previa (`previewPlantClose` ejecuta `closeInTx` y deshace, así que usa el mismo código; no se ve riesgo, pero ningún test lo toca con 2 bobinas).
- Ningún test del servicio ejercita la traducción `coilOuts → outs` (por ejemplo `refId === null` o `itemId` como bobina). Lo cubre solo el E2E.

El E2E agregado es un buen caso (A montada primero, B declara 9,2 de despunte, reabrir y recerrar deja los mismos saldos). No cubre el total escrito con dos bobinas ni el desborde.

### P3-6 — Mensaje de error de tope

`roofing-scrap.ts:170-175`.

El mensaje «La orden tiene X kg montados y se declaran Y kg consumidos» usa `Y = reportedKg + scrapKg`, igual que antes cuando `scrapKg` es lo declarado. Con varias bobinas, `scrapKg` ya es la suma de lo declarado por bobina (sin compensar), así que `Y` puede ser mayor que el total que el usuario escribió o que la suma de los partes. Puede confundir a planta, pero el texto sigue siendo cierto respecto a lo que se descontaría.

## Verificado sin hallazgos

- **Una bobina = comportamiento anterior.** La rama `liveCoils.length <= 1` calcula `max(Σ(declarado ?? salida) − reportado, 0)`, que es el mismo valor que `max(Σ declarado, reportado) − reportado` del código viejo. La cuenta de que `declaredKg = reportado + despunte` coincide. El rechazo `declared < reported` y el tope contra lo montado conservan los mismos mensajes.
- **`roofingCloseScrap`** ahora recibe `remainingKg: 0`. Ese campo no se usa en el cálculo (solo `declaredKg − reportedKg` y el cociente), así que el ratio sale igual.
- **Decimal.** Todo el cálculo usa `Decimal`/`roundTo(…, 'KG')`; no hay `number`. Las salidas se leen con `toDecimal(m.qty.toString())`.
- **Orden de bloqueos (regla 17).** El plan se calcula con lecturas hechas después de `lockOrder`; las filas y las salidas son las mismas de antes. `lockCloseSet(allocations)`, la reserva (`consumeReservationQty` tras `lockDocuments`) y el orden `pedido → OP → reserva → bobinas → saldos` no cambian. El cálculo es puro y no toma ningún candado nuevo.
- **Reserva.** Se descuenta `scrapKg` total como antes, antes de las salidas. `scrapKg` es la suma de `targets` y es igual a la suma de las asignaciones, salvo en el caso de P2-1.
- **`reopen`.** Revierte por movimiento `SCRAP` (no recalcula), devuelve a cada fila lo que su bobina recibió y deja `consumedKg` consistente. El recierre vuelve a calcular el mismo reparto desde los partes (el E2E lo comprueba con 9,2 en B).
- **Vista previa (`close-preview.ts`).** Ejecuta `closeInTx` completo en una transacción que se deshace, así que muestra el reparto nuevo sin código duplicado. El comentario de cabecera sigue citando `allocateStripKg` (cosmético, ver abajo).
- **CLI `inspect-cc34-cli.ts`.** Solo lectura: `SET TRANSACTION READ ONLY` como primera sentencia de la transacción, ninguna escritura (solo `findMany`), rechaza argumentos, pasa por `assertExecuteAllowed(false)` y `assertExternalOutputsOff`, sin modo `--execute`. Sigue el mismo patrón que `inspect-cc33-cli.ts`, está en `tsconfig.cli.json` y se invoca por `runApiCli`. No imprime credenciales. Las inferencias (total escrito frente a por parte, saldo reconstruido) están declaradas en el encabezado.
- **`package.json` y `scripts/inspect-cc34.mjs`:** coherentes con los otros `inspect:*`.

## Notas menores (no son hallazgos)

- El comentario de `close-preview.ts:19` cita `allocateStripKg` para el cierre de coberturas; ahora es `allocateRoofingScrap`.
- La importación de `allocateStripKg` en el servicio sigue en uso (línea ~1284, el reporte). `reportsOutKg` queda solo en `roofing-math.ts` y su spec; ya no lo usa el servicio. Conviene confirmar que nadie más lo use antes de dejarlo.

## Qué se hizo con cada hallazgo

| Hallazgo | Resolución |
| -------- | ---------- |
| P2 redondeo | Corregido (mismo que P2-1 de la autorrevisión): cuotas truncadas, resto a la de más peso, red Σ = despunte; test con 4 bobinas y mutación. |
| P2 desborde por parte | Se mantiene y se registra como D-539 provisional: lo que una bobina declaró y no entra en su saldo sale de las otras vivas en orden de montaje, igual que el total escrito. Es lo que menos cambia: hasta hoy ese exceso también salía de otras bobinas, y descartarlo haría perder kilos declarados sin aviso. |
| P3 bobina no viva / parte sin salidas / sin salida de kardex / `consumedKg: '0'` | Sin cambio: no se dan en el producto (montar rechaza duplicados, bajar una bobina con consumo está prohibido, todo parte deja su salida) o es igual que antes. |
| P3 tests | Agregados: 4 bobinas y total escrito sin reportado en vivas. |
| P3 mensaje | Sin cambio. |
| Menores | Comentario de `close-preview.ts` corregido; `reportsOutKg` sigue en uso por su spec y `mounted-kg.spec.ts`. |
