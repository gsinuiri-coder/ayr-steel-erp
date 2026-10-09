# Revisión de segundo modelo (Sonnet) — cc35 corte 2

Alcance: diff `origin/cc35-producir...origin/cc35-c2` (11 archivos). Lectura estática; no se corrió nada.
Sigue siendo un modelo, no una persona: no cierra la revisión.

Resumen: la regla compartida `checkRoofingPlanAdjustment` y su uso en `updatePlan` están bien armados
(Decimal, claves de largo en mm con 2 decimales en ambos lados, mismo orden de comprobación). Hay **2 P1**:
un E2E existente que queda en rojo y un campo de largo que se bloquea mientras se escribe.

## P1

### P1-1. `planta-avisos-materia-prima.spec.ts` queda en rojo (no se tocó en la entrega)

`e2e/tests/planta-avisos-materia-prima.spec.ts:~270`: el test amplía el plan de 10 ML a 100 ML con
`PUT /production/roofing/:id/plan` (`pieces([5, 2])` -> `pieces([5, 20])`) en un producto a medida. Con D-545 el
API responde 400 («sobran 90 m»), y `putJson` lanza antes de llegar a lo que el test quiere probar (el aviso de
materia prima al reportar de más).
Arreglo: el escenario tiene que llegar a «reportar de más» sin ampliar el plan (p. ej. un plan creado ya con 100 ML
en la cotización, o reportar contra un plan equivalente), y actualizar el comentario que dice «planta amplía el plan».
Revisar además el resto de la suite por la misma razón: solo se encontró este llamador a `/plan` fuera de los tocados
(`borrador-reportes-f8s3.spec.ts:166` sigue pasando porque la guarda D-191 del borrador salta antes y su mensaje es el esperado).

### P1-2. El campo «Largo» de una fila nueva se deshabilita mientras se escribe

`apps/web/src/app/(app)/planta/plan-adjust-dialog.tsx:214-231,267-269`. `done` se calcula con el **texto actual** del
largo (`reported.get(keyOf(row.lengthM))`) y el input se apaga con `done > 0`.
Escenario: el plan tiene 6.00 m con planchas reportadas. El usuario pulsa «+ Agregar largo» y escribe `6.5`: al teclear
`6` la clave coincide con 6000.00, `done` pasa a >0, el input se deshabilita (pierde el foco), la fila muestra «no se
puede quitar» y ya no se puede ni corregir ni quitar. Solo sirve «Cancelar» y empezar de nuevo. Con largos en metros
enteros (frecuentes) ocurre en el uso normal.
Arreglo: bloquear por **origen de la fila**, no por el texto: guardar un `fromPlan: boolean` (o el índice < nº de líneas
del plan al abrir) y calcular `done`/«no se puede quitar» solo para esas filas. Una fila nueva cuyo largo coincide con uno
del plan ya queda cubierta por el error «ese largo ya está en la lista».

## P2

### P2-1. El mensaje de D-146 manda a un camino que ahora está cerrado

`apps/api/src/production/roofing-production.service.ts:~1195` (mensaje al reportar de más): «Si de verdad hay que
producir más, ajusta primero el plan de corte (RF-31)». En una cobertura a medida el plan ya no puede crecer (D-545), así
que el operario sigue la indicación y recibe un 400. Igual el comentario de ~1150 («cambiar lo que hay que producir es
`updatePlan`»). Arreglo: texto que diga que el plan a medida conserva los metros del pedido y que producir más es un
pedido nuevo (o lo que el dueño decida); que lo confirme el dueño porque es política (D-545 ya está marcada provisional).
Mismo aviso para el texto de `InfoPopover` ya actualizado: coherente, pero el mensaje del API no.

### P2-2. «Agrupado por acabado» solo separa dos grupos

`coil-picker.tsx:346-354`. Hay «mismo acabado que el producto» y un único grupo «otro acabado del mismo color». Las
bobinas de acabados distintos quedan mezcladas y la fila ya no nombra el acabado (`FinishCell`, que lo mostraba, ahora
solo se usa en la tabla de terminadas). Si la ESPEC pide agrupar por acabado, falta un encabezado por `finishName`
(y mostrar el nombre en la fila). Verificar contra la ESPEC §4; si «mismo acabado / otro» era lo acordado, anotarlo.

## P3 (notas)

- `plan-adjust-dialog.tsx:140-143,57`: `mmToMeters` usa `toFixed(3)`; un largo del plan con fracción de milímetro (si el
  API lo admite) se redondea en silencio al abrir y, al guardar, cambia. Poco probable; si `roofingPieceSchema` admite
  fracciones de mm, validar en el API que la clave coincida.
- Plan vigente vacío en cobertura a medida: el diálogo abre con 0 filas (antes sembraba una fila vacía); se puede
  «+ Agregar largo», pero conviene sembrar una fila vacía. En plancha de catálogo con plan antiguo de varios largos, el
  diálogo lo colapsa a un solo largo y el piso por largo puede rechazarlo con un mensaje poco claro.
- Mensajes: «ya tiene 1 planchas reportadas» (plural fijo) en `roofing.ts` y en su spec.
- Accesibilidad del diálogo: «no menos de N» no está enlazado con `aria-describedby`; la franja `role="status"` se
  re-anuncia en cada pulsación; las filas del selector son clicables sin teclado propio (la casilla sí es alcanzable,
  suficiente). El nombre accesible del `Table` del selector sigue siendo «Bobinas para …» mientras el título es «Montar
  bobinas en …» (no afecta a los tests).
- Selector: lo elegido y oculto por la búsqueda no se cuenta ni se monta (bien), pero no hay indicación de «+N elegidas
  fuera del filtro». «kg consumido» = inicial − saldo incluye ajustes de kardex, no solo consumo; «≈ kg que faltan» usa el
  rinde de la primera bobina como muestra (rotulado «≈»). `setOpen(false)` antes del resultado de la mutación pierde la
  selección si el montaje falla (comportamiento previo).
- La función es sensible a que el cliente envíe `lengthMm` con otra escala: ambos lados normalizan con `toFixed(2)`; correcto.

## Verificado y correcto

- `checkRoofingPlanAdjustment`: comparación de metros con `Decimal.equals` sobre `piecesMeters`; con largos enteros en mm
  no hay error de redondeo. Piso por largo suma líneas repetidas del plan vigente; un reportado ausente del plan no pone
  piso; plan vigente vacío no exige metros. `exactMeters` en el API es `detailsLengths(planned)` (se agregó `unit` al
  `select`), equivalente a `unit === MTR && !isAccessory` del diálogo.
- `updatePlan`: la lectura de reportes ACTIVE ocurre dentro de la transacción con la orden ya bloqueada (`lockOrder`),
  no añade bloqueos nuevos (regla 17 intacta); la guarda D-191 del borrador sigue antes y no se contradice.
- `reportedByLength` del diálogo (desde `planItems` y `remainingPieces`, que ya excluye líneas en 0) coincide con
  `reportedPlanPieces` del API.
- Los tests nuevos prueban lo pedido para el API (400 con «sobran/faltan», piso reportado, rechazo de quitar, que no
  cambia nada tras el rechazo, que baja con total cuadrado). No hay E2E de la UI para «no se puede quitar» ni para la
  franja con una fila reportada, ni prueba por API de la rama plancha de catálogo (la cubre indirectamente el E2E de UI
  5 -> 6 planchas).
- `Guardar el plan` no se apaga y se queda con el mensaje cuando no cuadra; `Montar` del selector sí se deshabilita sin
  selección (no es el estándar de «no apagar», pero cada caso tiene su rótulo; confirmar con el dueño si aplica también ahí).

## Qué se hizo con los hallazgos (autor, cc35)

- **P1 `planta-avisos-materia-prima.spec.ts`**: con D-545 una cobertura a medida ya no amplía su plan. El caso de «rolar de más» (aviso de D-154) se reescribió con una plancha de catálogo de 5 m: mismas cuentas en kg, el producto entra en 20 planchas. La consecuencia queda escrita en D-545 para el dueño.
- **P1 largo bloqueado mientras se escribe**: el bloqueo es por origen de la fila (vino del plan con planchas reportadas), no por el texto.
- **P2 marcadas fuera de la búsqueda**: el pie avisa cuántas marcadas quedan fuera y que no se montan (se mantiene «no se monta lo que nadie está mirando»).
- **P2 plan vigente vacío**: el diálogo abre con una fila vacía y la franja no dice «de 0.000 m».
- **P2 mensaje de D-146**: «Si lo que salió no es lo del plan, ajusta primero el plan de corte»; comentario del servicio actualizado.
- **P2 sin E2E de D-546 en pantalla**: queda cubierto por el unitario y el E2E de API; el E2E de pantalla prueba franja roja, «Guardar» que se queda y franja verde. Se anota como P3.
- **P3**: plurales («1 plancha reportada»); largos con dos decimales en el diálogo; teórico en «Qué va a pasar». Sin cambio: la franja con `role=status`, el «≈ kg» del encabezado y «kg consumido» con ajustes de cierre (se informan).
