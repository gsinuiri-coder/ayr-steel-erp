# Revisión de segundo modelo — cc38 / D-573..D-579 (la OP se cierra solo con el plan completo)

- **Modelo:** Sonnet 5.5, con contexto limpio y sin leer el handoff de implementación. Es un
  modelo, no una persona (AGENTS.md §2 regla 2.2).
- **Fecha:** 2026-10-09.
- **Rama:** `feat/cc38-cierre-plan-completo`.
- **Diff revisado:** `552b430f..2d524990`.
- **Método:** lectura de código del API, el web y el shared; `tsc --noEmit` limpio en `apps/api` y
  `apps/web`; pruebas unitarias en verde (`roofing-close-plan`, `roofing-drafts`,
  `roofing-accessory-report` en jest; `plan-progress` y `format` en vitest). No corrió E2E.

## P0

Ninguno. La regla de cierre D-573 no tiene ningún camino que la esquive en el API (ver
«Verificado»).

## P1

- **P1-1. «Ajustar el plan» de una plancha de catálogo esquiva D-573, D-574 y D-577.**
  - Dónde: `RoofingProductionService.updatePlan`, `apps/api/src/production/roofing-production.service.ts`
    (llamada a `checkRoofingPlanAdjustment` con `exactMeters: detailsLengths(planned)`), y
    `checkRoofingPlanAdjustment` en `packages/shared/src/schemas/roofing.ts` (~l. 532). Sin cambios
    en este diff.
  - Escenario: plancha de catálogo (unidad no MTR, `detailsLengths` falso), pedido de 100
    planchas, 40 registradas. El supervisor baja el plan a 40 (el piso es lo reportado), registra
    nada más y cierra: `assertPlanComplete` compara contra el plan **vigente**, y pasa. Es el cierre
    corto que D-577 dice que no existe. A la inversa: sube el plan a 120, registra 120 y cierra:
    es la sobreproducción que D-574 y la ESPEC §«ajustar el plan» dicen que queda fuera («sigue
    exigiendo el mismo total de metros»).
  - Contexto: D-545 dejó la cantidad libre en catálogo a propósito («producir de más queda solo
    en planchas de catálogo») y D-574 dice «cierra D-545 por ahora», pero el código de D-545 no se
    tocó. La regla de cierre compara contra el plan, no contra el pedido, así que un plan editable
    la vuelve vacía en ese subtipo.
  - Propuesta: decisión del dueño (regla 16). Recomendación: en catálogo, `updatePlan` solo admite
    el mismo total de unidades que el plan vigente (aquí el plan es de una sola fila y «ajustar»
    no tiene efecto útil, así que en la práctica se bloquea), o `assertPlanComplete` compara contra
    la cantidad de la línea del pedido. Si el dueño quiere dejarlo, que quede escrito como D-nnn
    explícito, porque hoy D-574 dice lo contrario.

## P2

- **P2-1. Reabrir una OP cerrada incompleta la deja sin salida (D-578).** `reopen` no mira el plan
  y el re-cierre sí: una orden cerrada antes de cc38 con plan incompleto, al reabrirla, queda
  `IN_PROGRESS` sin poder cerrarse (falta registrar X m) ni anularse mientras tenga reportes
  vigentes. El diagnóstico dice que no hay abiertas, pero sí puede haber cerradas incompletas.
  Propuesta: avisar en la reapertura de una orden cuyo plan está incompleto («al reabrir no podrás
  cerrar sin completar el plan»), o dejar que la reapertura la rechace.
- **P2-2. Accesorio: el tope de D-574 solo corre si la orden tiene reserva.** En `reportInTx` el
  rechazo de exceso queda dentro de `if (accessory && order.reservationId)`; `assertPlanComplete`
  rechaza el cierre de un accesorio sin reserva ('no tiene plan'). Una orden de accesorio sin
  reserva admite reportes y nunca cierra. Probablemente no existe en datos reales; propuesta: el
  reporte también lo rechaza con el mismo texto del cierre.
- **P2-3. Accesorio: el «plan» es la cantidad de la línea al momento de leer.** Si el pedido
  baja la cantidad de la línea después de haber registrado metros, `excess > 0` y la orden no
  cierra ni se puede corregir desde planta (el cierre dice «Excede el plan…» y no hay forma de
  quitar metros salvo la reversa del último reporte). Propuesta: nota en el handoff; es un caso
  raro.
- **P2-4. «Volver» en «Qué va a pasar» no deshace la confirmación del bloque llenado solo.**
  En `produce-blocks.tsx` (`confirmAutoAndPreview`) el bloque pasa al borrador al marcar la
  casilla, antes de calcular. Si el supervisor luego pulsa «Volver» (`onBack`), el bloque queda
  confirmado y un «Registrar producción» posterior lo registra. Es coherente con D-575 («al
  marcarla el bloque pasa al borrador»), pero «Volver» suena a cancelar. Propuesta: aclararlo en el
  texto de la casilla («al marcarla queda en el borrador») o devolver el bloque a «llenado solo»
  en `onBack` (quitar la fila del borrador si la confirmación vino de ahí).
- **P2-5. Tolerancia de kilos del bloque recién confirmado.** `confirmAutoAndPreview` llama a
  `run.attempt()` con el `body` del render anterior: `excessBlocks` no incluye el bloque que acaba
  de confirmarse, así que si ese bloque pasa el 1 % de kilos, el API rechaza con
  `TOLERANCE_OVERRIDE_REQUIRED` y la casilla de tolerancia aparece recién después. No se registra
  nada de más (el API manda), es solo fricción. Propuesta: calcular `excessBlocks` incluyendo
  `autoBlock` en ese camino, o dejar que el rechazo lleve al bloque como hoy.

## P3

- **P3-1. Dos redondeos para los metros.** `reportInTx` y `checkDraftRows` miden con
  `piecesMeters` sobre todos los largos juntos; `assertPlanComplete` suma `metersM` por reporte
  (una cobertura en MTR, cada una redondeada a 3 decimales). Con largos en milímetros enteros
  coinciden siempre; con milímetros fraccionarios podría diferir en 0,001 m. Sin impacto real hoy.
- **P3-2. `registeredByCoil` y la bobina montada dos veces.** Agrega por `coilId`; si una bobina
  tuviera dos consumos vivos en la misma orden (no lo permite el montaje hoy), se mostraría el
  total en las dos. Un parte sin salida de kardex (kg efectivos 0, D-246) no se atribuye a ninguna
  bobina; el total de la orden sí lo cuenta. Las reversas están bien tratadas por `liveMovements`
  (la salida revertida y su inversa se descartan, y el reporte revertido ya no es `ACTIVE`).
- **P3-3. `accessory` en `produce-accessory.tsx`:** `keyFor` reescribe `edits` desde el render que
  lo creó; funciona porque las opciones de `useMutation` se leen frescas al llamar `mutateAsync`.
  Si algún día `closePath` se captura en una clausura vieja, se podrían resucitar bloques ya
  enviados. Sin acción.
- **P3-4. D-579 limpio.** `unitSymbol`/`formatUnits` y `common/unit-symbol.ts` solo se usan para
  mostrar (Excel, hoja de kardex, PDF de planta del pedido, pantallas). Nada de lo que viaja al API,
  al PSE o al XML pasa por ellos; el web que manda cuerpos usa los códigos. `'u'` ya no se compara
  en ningún lado.

## Verificado (sin hallazgo)

1. **D-573, todos los caminos de cierre de coberturas pasan por `assertPlanComplete`.** El único
   `status: CLOSED` de una OP ROOFING está en `closeInTx` (`roofing-production.service.ts`).
   `close`, `previewClose`, `reportAndClose`, `previewReportAndClose`, `commit`/`previewCommit`
   (con `close=true`) llaman a `closeInTx`, que corre la comprobación después de los reportes de
   la misma transacción, con la orden bloqueada. El cierre de `production.service.ts` es de
   drywall y rechaza cualquier otra clase (`lockOrder` → `assertKind(DRYWALL)`). No hay cierres
   automáticos, importadores ni CLI de `apps/api/prisma` que pongan una OP en `CLOSED`
   (`backfill-film`, `go-live-inventory` solo leen o tocan bobinas). La anulación de pedido
   anula, no cierra. `reopen` devuelve a `IN_PROGRESS`.
2. **Comparación con 3 decimales:** `roofingPlanGap` redondea ambos lados a escala `KG` (3 dec,
   `ROUND_HALF_UP`); `missing` y `excess` nunca son los dos positivos. Plancha de catálogo:
   metros = largo fijo × unidades, mismo cálculo que el plan. Accesorio: `sumReportedMeters` (suma
   de `metersM`) contra `salesOrderItem.qty` de la reserva. Para una cobertura vendida por metro
   `metersM` se guarda junto con el detalle de largos; `sumReportedMeters` no los cuenta dos
   veces.
3. **D-574, exceso:** `reportInTx` (plan por largos y accesorio), `checkDraftRows` (al agregar,
   editar y en el commit con 'all', acumulando el borrador) y `commitInTx` (que revalida y luego
   llama a `reportInTx` fila por fila). Editar una fila re-valida todo el borrador en orden.
   Reversa + nuevo reporte libera el plan y el tope vuelve a aplicar. `updatePlan` en una
   cobertura a medida exige los mismos metros y no baja de lo reportado (excepción: P1-1).
   Un accesorio no se puede ajustar de plan.
4. **D-575 en la web (coberturas):** el bloque llenado solo (`derived`, último bloque, sin edición
   ni borrador guardado) no está en `registrable`, no entra a `persistAll`, `useBlockDrafts` solo
   guarda `edits` (que solo recibe escritura del supervisor o `confirmAuto`), y el flush de
   desmontaje/cambio de bobina solo toca esos `edits`. «Registrar producción» no lo manda; «Registrar
   y cerrar» pide la casilla antes de la vista previa. Accesorio: el bloque derivado no está en
   `registrable`, `closePath` solo lo manda tras `confirmAuto`, y `start(true)` con bloque sin
   confirmar siempre pasa por `askingAuto`.
5. **Barra de tres tramos (`planProgress`):** tramos recortados a 100 % en suma; el bloque llenado
   solo cuenta para `canClose`/`toClose` pero no para `missing`/`draft`/barra, como dice D-576.
   `missingDetail` solo se muestra si cuadra con los metros y sin negativos.
6. **DTO de batch:** una consulta extra para todo el lote (`refType PRODUCTION`, `itemType COIL`,
   `OUT`), sin N+1; `reportedMeters` y `reportedPieces` por bobina consistentes con el total de la
   orden.
7. **CLI `inspect-cc38`:** transacción `READ ONLY`, sin modo execute, lee `AYR_CLI_BRANCH` por
   entorno.

## Respuesta de la sesión (commit `432bf1fc`)

Junta este informe y la autorrevisión (subagente nuevo, que no leyó el handoff; es una lista de
riesgos, no un pase).

- **P1-1 (plancha de catálogo: ajustar el plan libre).** Corregido. La especificación dice que
  «Ajustar el plan» sigue exigiendo el mismo total de metros y que D-574 cierra D-545, así que
  `updatePlan` pasa `exactMeters: true` para toda orden con plan. En la web,
  `planNeedsExactMeters` es verdadero salvo en el accesorio. Bajar el plan de una plancha ya no
  sirve para cerrar corto (D-577), ni subirlo para producir de más. Va registrado en D-574.
- **P2-1 (reabrir una OP cerrada antes de cc38).** Sin cambios: D-578 dice que las cerradas no se
  tocan. Una así, si se reabre, no vuelve a cerrar sin el plan completo. Queda anotado para el
  dueño en el handoff.
- **P2-2 (accesorio sin reserva).** Sin cambios. Un accesorio no se produce a stock (solo lo hace
  la plancha con largo, D-140/D-171). Si existiera uno sin reserva, `assertPlanComplete` rechaza
  su cierre.
- **P2-3 (el pedido baja la cantidad del accesorio después de registrar).** Es el caso de D-577
  (cierre corto), fuera de alcance. Anotado en el handoff.
- **P2-4 (Volver deja confirmado el bloque).** Es intencional: marcar «Confirmo que salieron»
  confirma el bloque (D-575). Anotado en el guion UAT.
- **P2-5 / P3-6 de la autorrevisión (tolerancia del bloque llenado solo).** Corregido. Si el bloque
  pasa lo montado más del 1 %, «Registrar y cerrar» pide confirmarlo en el bloque con «Sí, salió
  así», donde está la casilla de tolerancia, antes de abrir «Qué va a pasar».
- **Autorrevisión P2-4 (exceso con más de 3 decimales).** Corregido. `roofingPlanOverrun` compara
  a 3 decimales con `roofingPlanGap`, la misma escala del cierre.
- **Autorrevisión P2-5 («NIU» en el piso de precio).** Corregido. `priceUnitLabel` pasa por
  `unitSymbol` y dice «por und».
- **Autorrevisión P1-2 (E2E con el texto viejo).** Corregido, junto con la E2E de D-154: rolar de
  más ya no es posible, así que la prueba ahora comprueba el rechazo. También se ajustó la de la
  plancha que ampliaba el plan y la fixture de `lock-order.db-spec` (d) × completar reserva (el
  cierre no podía ganar nunca).
- **P3 (doble consumo de una bobina, consultas extra del cierre, redondeo del diagnóstico).** Sin
  cambios: son bordes que hoy el montaje no permite, o costos menores.
