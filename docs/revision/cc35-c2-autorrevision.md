# Autorrevisión (no es un pase cruzado)

Entrega: cc35, corte 2 — `origin/cc35-producir...origin/cc35-c2` (HEAD `04fadc01`, PR #149 contra
`cc35-producir`). Revisor: subagente nuevo que no leyó el handoff de implementación. Es una lista de
riesgos, no una aprobación. No corrí unitarios ni E2E (el worktree está en otro commit y no se hizo
checkout); todo lo de abajo sale de leer el código de la rama.

Nota de CI: el PR #149 apunta a `cc35-producir` y solo muestra los checks de Vercel; la CI de
GitHub (lint, unitarios, E2E) no corrió sobre este diff.

---

## P1

### P1-1. `planta-avisos-materia-prima.spec.ts` queda en rojo: amplía el plan de un producto a medida

- `e2e/tests/planta-avisos-materia-prima.spec.ts:270` hace `PUT /production/roofing/:id/plan`
  con `pieces([5, 20])` (100 ML) sobre una orden cuyo plan vigente es `pieces([5, 2])` (10 ML). El
  producto sale de `setupRoofingScenario` sin `pieceLengthMm` ⇒ `unit: 'MTR'`, `A_MEDIDA`
  (`e2e/helpers/roofing.ts:252`), así que `detailsLengths` es `true` y la regla de D-545 lo
  rechaza con 400 («sobran 90.000 m»). `putJson` lanza y el test cae antes de llegar al aviso de
  D-154.
- No es solo un test que actualizar: ese spec documenta el único camino «realista» que quedaba para
  que una orden consuma más material del prometido («el techo se midió más grande: planta amplía el
  plan»). Con D-545 ese camino desaparece para la cobertura a medida, y el comentario de D-146 en
  `roofing-production.service.ts:1155-1158` («cambiar lo que hay que producir es `updatePlan`, no
  reportar de más») queda falso para a medida.
- Arreglo: (a) reescribir el escenario del spec con una **plancha de catálogo** (`pieceLengthMm`),
  donde la cantidad sigue libre, o con otro mecanismo que deje el pool corto; (b) actualizar el
  comentario de D-146 y mencionar en D-545 que a medida ya no hay forma de producir más de lo que
  el plan vigente dice (consecuencia que el dueño debe ver explícitamente al ratificar).

---

## P2

### P2-1. La selección escondida por el filtro se descarta en silencio al montar

- `apps/web/src/app/(app)/planta/coil-picker.tsx:122,153,494`: `visibleSelected` solo cuenta lo
  marcado que el filtro deja a la vista, y «Montar» manda solo eso. La regla ya existía, pero antes
  cada fila tenía su botón «Montar»; ahora la casilla + búsqueda es el único camino, y el flujo
  natural del modal pedido por el dueño («búsqueda … casillas para marcar varias») es exactamente
  el que pierde: marcar A, buscar B, marcar B, pulsar «Montar la bobina» ⇒ se monta solo B. El pie
  dice «1 elegida», pero nada avisa que hay otra marcada fuera de la vista.
- El E2E `multi-montar-f8s3.spec.ts:255-262` comenta «la selección sobrevive a la búsqueda» pero
  limpia el filtro antes de montar, así que no prueba el caso que confunde.
- Arreglo (elegir uno y registrarlo): montar todo `selected` y mostrar en el pie «N elegidas (M
  fuera de la búsqueda)», o mantener la regla pero avisar en el pie «hay M marcadas que la búsqueda
  esconde: no se montan». Sumar el caso al E2E.

### P2-2. Las reglas de D-546 en pantalla no tienen E2E

- `e2e/tests/planta-plan-cc35.spec.ts` es solo API. En la UI no se prueba «no menos de N», el
  «no se puede quitar», el largo deshabilitado de una fila con reportadas ni la franja «Sobran».
  `planta-espacio-produccion-ui.spec.ts:545-556` cubre «Faltan» y «Cuadra ✓» sin reportes.
- Tampoco hay caso API de «no se puede quitar» (solo unitario) ni de «plancha de catálogo con
  cantidad libre» por API (solo la UI de `planta-espacio-produccion-ui.spec.ts:679-689`).
- Arreglo: sumar al spec de cc35 un tramo UI con un reporte previo (3 × 4 m) que compruebe el
  texto «no menos de 3», el largo deshabilitado, la falta de «Quitar» y el rechazo al bajar a 2.

### P2-3. Plan vigente vacío: la franja dice «Cuadra ✓» con «X de 0.000 m»

- `plan-adjust-dialog.tsx:310-336` + `checkRoofingPlanAdjustment` (`roofing.ts`, rama
  `input.current.length > 0`): en una orden vieja sin plan, `exact` es `true` y el check da `ok`,
  así que la franja verde dice «Metros del plan 40.000 de 0.000 m del original · Cuadra ✓». Es
  falso y contradice la regla que el propio diálogo describe arriba.
- Además el diálogo abre con cero filas (`order.planItems.map` sobre `[]`), donde antes el editor
  traía una fila vacía (`EMPTY_PIECE_ROW`); hay que descubrir «+ Agregar largo».
- Arreglo: con `order.planItems.length === 0`, no mostrar «de 0.000 m»/«Cuadra», decir «sin plan
  previo: el total es libre» y abrir con una fila vacía.

---

## P3

1. **Orden de validaciones en `updatePlan`** (`roofing-production.service.ts:510-549`): con
   borrador cargado, un plan a medida que suma menos metros cae primero en el mensaje de D-191
   («quita o corrige filas del borrador») en vez del «faltan X m» de D-545. No es incorrecto (el
   400 se da igual y `borrador-reportes-f8s3.spec.ts:166-171` depende de este orden), pero el
   mensaje del API no nombra la regla nueva. Además se leen los reportes activos dos veces en la
   misma transacción (`reported` dentro del `if (drafts.length > 0)` y `reportedNow`); se puede
   leer una vez antes de las dos comprobaciones. Concurrencia: ambas lecturas van después de
   `lockOrder`, y `reportInTx`/`reverseReport` toman la misma OP, así que no veo carrera.
2. **Comparación por metros redondeados a 3 decimales.** `piecesMeters` redondea `Σ mm / 1000` a
   escala KG; dos planes cuyas sumas en mm difieren en menos de 0.5 mm se dan por iguales. Con la
   UI (metros con 3 decimales ⇒ mm enteros) no pasa, pero el API acepta mm con 2 decimales. Si se
   quiere «ni más ni menos» literal, comparar `Σ lengthMm × qty` sin dividir.
3. **Claves mm↔m.** Todas las claves salen de `toDecimal(lengthMm).toFixed(2)` y la UI pasa por
   `metersToMm` (2 decimales en mm): coinciden. Riesgo residual solo con un plan que tenga mm no
   enteros (p. ej. `2437.50`): `mmToMeters` lo muestra `2.438`, el diálogo lo reenvía como
   `2438.00`, y el piso de D-546 lo trata como largo quitado («no se puede quitar») sin que el
   usuario pueda corregirlo, porque en esa fila `done` es 0 y la de 2437.50 ya no existe. Tampoco
   lo hay en planes de catálogo cuyo `lengthMm` no coincida con el del SKU (el diálogo siempre usa
   el largo del SKU). Arreglo barato: sembrar las filas con la clave original y no reconvertirla si
   el usuario no tocó el largo.
4. **Texto de D-545 vs código.** El doc dice «a medida» pero la regla es `detailsLengths`
   (`MTR` y no accesorio), que también alcanza a un SKU legado en `MTR` sin subtipo. Y «cada ajuste
   conserva los metros, así que es el del pedido» no vale para órdenes cuyo plan se amplió antes de
   cc35. Decirlo así en la fila.
5. **Accesibilidad del diálogo del plan.** La franja `role="status"` se re-anuncia en cada tecla;
   «no menos de N» no está ligado al input por `aria-describedby`; `aria-invalid` solo marca el
   piso, no la fila que descuadra. Label-in-name está bien en «Ajustar el plan de corte de …»,
   «Quitar el largo N del plan» y los botones «Montar …» (el texto visible es prefijo del nombre).
6. **Gramática.** «ya tiene 1 planchas reportadas» (`roofing.ts`, mensaje de D-546) y «Ver las 1
   bobinas terminadas» (`coil-picker.tsx:384`) con N = 1.
7. **Comentario obsoleto** en `coil-picker.tsx:42-43`: «Cada fila conserva su botón «Montar»» ya
   no es cierto.
8. **«≈ kg» del encabezado del modal** (`coil-picker.tsx:158-162`) usa el kg/m de la primera
   bobina con rinde; con anchos o acabados (densidad) distintos entre bobinas la cifra se mueve. Es
   un «≈», pero conviene tomarlo de la spec del producto o de una bobina del acabado exacto.
9. **«kg consumido» = `weightKg − availableKg`** (`coil-picker.tsx:182`): incluye ajustes de
   cierre y cualquier salida de kardex, no solo lo rolado. Aceptable si el dueño lo lee como «lo
   que ya no está»; anotarlo en el UAT.
10. **La búsqueda no filtra la lista de terminadas** (`closedOptions`), solo las libres; el enlace
    «Ver las N…» cuenta todas. Coherente con «se ven a pedido», pero distinto de lo que espera
    quien buscó un código de una terminada.
11. **Archivo suelto** `e2e/lal.mjs` sin trackear en el worktree `ayr-steel-erp-cc35` (no está en
    la rama); borrarlo o confirmar que no es de esta entrega.

---

## Lo que revisé y está bien

- `checkRoofingPlanAdjustment`: Decimal de punta a punta, el piso usa `reportedPlanPieces`
  (topado por línea, coherente con `remainingPlanPieces`), un largo reportado fuera del plan no
  pone piso, duplicados imposibles (`roofingPiecesSchema` y `parsePieceRows` los rechazan).
- La UI calcula «ya reportadas» con `planItems − remainingPieces`, y `remainingPieces` sale de
  reportes `ACTIVE` sin borrador (`batchOrders`), igual que el API: pantalla y API dan lo mismo.
- `updatePlan` sigue siendo el único escritor de `production_order_items` además de la
  re-sincronización de `sales-order-edits.service.ts:843`, que no pasa por esta regla (correcto:
  la edición del pedido cambia los metros a propósito).
- «Guardar el plan» no se apaga salvo con `pending`; sin cuadrar, se queda y muestra el motivo.
- Modal de bobinas: sellado (paso de film) y reabrir no cambiaron de regla; tope
  `MAX_ORDER_STRIPS` sigue en el botón y en «Reabrir y montar».

## Qué se hizo con los hallazgos (autor, cc35)

- **P1 `planta-avisos-materia-prima.spec.ts`**: con D-545 una cobertura a medida ya no amplía su plan. El caso de «rolar de más» (aviso de D-154) se reescribió con una plancha de catálogo de 5 m: mismas cuentas en kg, el producto entra en 20 planchas. La consecuencia queda escrita en D-545 para el dueño.
- **P1 largo bloqueado mientras se escribe**: el bloqueo es por origen de la fila (vino del plan con planchas reportadas), no por el texto.
- **P2 marcadas fuera de la búsqueda**: el pie avisa cuántas marcadas quedan fuera y que no se montan (se mantiene «no se monta lo que nadie está mirando»).
- **P2 plan vigente vacío**: el diálogo abre con una fila vacía y la franja no dice «de 0.000 m».
- **P2 mensaje de D-146**: «Si lo que salió no es lo del plan, ajusta primero el plan de corte»; comentario del servicio actualizado.
- **P2 sin E2E de D-546 en pantalla**: queda cubierto por el unitario y el E2E de API; el E2E de pantalla prueba franja roja, «Guardar» que se queda y franja verde. Se anota como P3.
- **P3**: plurales («1 plancha reportada»); largos con dos decimales en el diálogo; teórico en «Qué va a pasar». Sin cambio: la franja con `role=status`, el «≈ kg» del encabezado y «kg consumido» con ajustes de cierre (se informan).
