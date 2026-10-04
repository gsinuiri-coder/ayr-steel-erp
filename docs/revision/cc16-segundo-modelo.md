# Revisión de segundo modelo — cc16 (D-381, traer comprobante anulado a otro pedido)

Revisor: Sonnet, contexto limpio. Alcance: `git diff origin/main...HEAD` de `cc16/traer-comprobante`
(16 archivos). Es un modelo, no una persona: no cierra la revisión (AGENTS.md §2.2).

Corrido por el revisor: jest de `src/invoicing/move-to-order*`, `reactivate-order-lines` y
`fiscal-import*` (6 suites, 108 pruebas, verdes) y `tsc --noEmit` de `apps/api` (sin errores).
`eslint` por ruta suelta devolvió solo «File ignored» (la config de lint se corre desde el
workspace; no es una señal). No se corrió E2E ni se levantó ningún servidor.

## Resultado

**0 P0, 0 P1, 2 P2, 5 P3.** Nada bloquea el deploy.

Verificado sin hallazgo:

- **Emparejado.** `pairRowsToOrder` (`move-to-order-lines.ts:27-55`) respeta orden de línea y
  consume cada línea libre una sola vez. El caso 1389 (seis filas contra las líneas 2 a 7, la 1
  libre) está probado.
- **`updates` escribe `salesOrderItemId` del destino.** `planOrderLines` lo pone en `updates`
  (`reactivate-order-lines.ts:201-208`) y las dos escrituras lo persisten
  (`move-to-order.service.ts:229`, `fiscal-import.service.ts:515`). En D-378 el valor es la misma
  línea de antes (`targetOf` devuelve `d.salesOrderItemId`, `o = orderById.get(...)`), sin regresión.
- **El «antes» conserva la línea de origen** (`beforeLineNumber` sale de `sourceOrderLines`;
  `before.rows` se arma de `document.items` sin remapear).
- **Cabecera D-377 y total del papel.** La cabecera sale de `sumLineTotals`
  (`plan.after`), y `paperTotalDifference` corre antes de cualquier escritura.
- **Carreras.** El `updateMany` condicionado a `status = ANNULLED` y `salesOrderId = origen`
  sigue a locks en el orden de D-378 (comprobante, dos pedidos por id, borradores). Dos traídas del
  mismo comprobante se serializan por el lock de la fila; dos comprobantes al mismo destino se
  serializan por el lock del pedido, y el segundo ve al primero como «otro vivo» porque la
  consulta corre después del lock (READ COMMITTED). No hay ciclo nuevo: ningún camino toma pedido
  antes que comprobante.
- **Bloqueos.** Cobros, notas de crédito (cualquiera), detracción, despachos enlazados (incluso
  `REVERSED`), despachos `ISSUED` del origen, otro vivo, borrador, cliente, D-077, origen no
  anulado, destino anulado, destino igual al origen y filas sin pareja están en el código y
  probados partiendo de un caso `happy`.
- **Efectos colaterales.** No hay llamadas a `InventoryService`, reservas ni pagos. La web
  invalida `fiscal-document*`, `receivables`, `order-progress` y, vía `invalidateSales`, los dos
  pedidos.
- **Selectores del E2E contra el DOM.** `movable-<número>`, `move-orders`, `move-warnings`,
  `paper-total-mismatch`, `after-total`, la región `Después` y los `Label` de motivo, total y
  casilla existen en `move-to-order-dialog.tsx` y `Side`.

## P2

### P2-1. El presupuesto de consultas de `candidates` está afirmado y no verificado

`apps/api/src/invoicing/move-to-order.service.ts:87-90` dice «Presupuesto (llamadas a Prisma,
verificado por test)», y el diseño y AGENTS.md §3.4 lo exigen. El único test de candidatos
(`move-to-order.service.spec.ts:692-725`) comprueba el `where`, el `take` y la ausencia de
`FOR UPDATE`, **no cuenta llamadas**. Escenario: alguien agrega una consulta a `plan()` y cada
candidato cuesta una más (×20) sin que ningún test lo note. Acción: un test que cuente las llamadas
al `tx` con 1 y con `MOVABLE_CANDIDATES_LIMIT` candidatos y las fije, o quitar «verificado por
test» del comentario.

### P2-2. `candidates` repite el plan completo por candidato, en serie

`move-to-order.service.ts:131-144`: cada candidato corre `plan()` (lock común, pedidos, despachos,
líneas del destino, otros vivos, borradores, cliente, vendedores...). Las lecturas del pedido
destino, sus líneas, los otros vivos y los borradores **no dependen del candidato** y se leen hasta
20 veces; son del orden de 15 a 17 consultas por candidato, es decir unas 300 idas a Neon en
serie al abrir el diálogo (no medido: estimado por conteo en el código). Con el cliente de un
anulado real son pocas filas y se tolera, pero el diálogo se queda en «Buscando…» mientras tanto.
Acción sugerida (no bloqueante): leer una vez lo del destino y pasarlo a `plan` (como ya se hace
con `common`), o medir en demo antes del deploy y registrar la cifra.

## P3

1. **Parámetro muerto.** `plan(..., common?)` (`move-to-order.service.ts:338`) nunca lo recibe:
   `candidates` no precalcula `common`. Quitarlo o usarlo (ver P2-2).
2. **Emparejado de la pasada 3.** `move-to-order-lines.ts:52` toma «cualquier línea libre» y puede
   quedarse con una línea genuinamente nueva del destino (la `UPVC6MT` del caso real) para una fila
   cuyo producto desapareció, y dejar la verdadera «nueva» como `Agregada`. Lo contiene el total del
   papel y la insignia «Cambia de producto», así que es aviso, no defecto. Vale una frase en el
   modal o en el handoff.
3. **Cobertura E2E acotada.** Los dos E2E cubren el camino feliz, el 409 por borrador, otro cliente
   y total distinto. No hay E2E (solo unitarios) de: origen vivo, despacho enlazado o vivo en
   origen, otro vivo en destino, vendedor distinto en el modal, aviso de fecha. Aceptable porque
   los unitarios los cubren; anotarlo en el guion UAT.
4. **Lista de candidatos en caché al reabrir.** `move-to-order-dialog.tsx:68-83`: el componente
   queda montado y la consulta conserva datos al cerrar. Al reabrir, el efecto de auto-selección
   puede elegir un candidato de la lectura anterior antes de que termine el refetch; si ya no está
   disponible, la vista previa muestra el 409 y el usuario ve el motivo. Sin pérdida de datos.
5. **Documentación del cierre.** El diff no trae la fila D-381 en `docs/ARQUITECTURA.md` §0.2,
   `docs/PROGRESO.md`, handoff ni guion UAT. Se supone que llegan en `ayr-cierre`; confirmar antes
   del merge. Tampoco hay aún `docs/revision/cc16-autorrevision.md` en el diff.

## Notas de calidad de tests

- Unitarios: buenos. Cada bloqueo parte de `happy()`, así que un verde identifica el bloqueo
  correcto; el test de «cambió entre el plan y la escritura» comprueba que no se toca ninguna línea.
- E2E (`e2e/tests/traer-comprobante-d381.spec.ts`): la aserción
  `before.totalPen toBe invoice.totalPen` (línea 260) compara cadenas con la escala de 4 decimales
  de las dos fuentes; si el DTO del comprobante cambiara de escala se rompería sin que el producto
  falle. Riesgo bajo; no se pudo ejecutar.
