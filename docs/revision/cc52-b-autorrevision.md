# cc52 corte B — autorrevisión

**Autorrevisión:** la hizo un subagente que no leyó el handoff de implementación. Es una lista de riesgos, no una
aprobación, y no vale como pase cruzado.

Alcance: `git diff cc52-a-menores..c92d3107` (NC con fecha y devolución, D-645..D-647, migración
`20261014_sales_returns`), leído por refs de git.

Resumen: P0 1 · P1 2 · P2 4 · P3 4.

- **P0 — corregido.** Revertir un despacho después de una NC de devolución reingresaba la mercadería dos veces
  (la NC acredita la línea y deja de bloquear la reversa). Ahora `reverseInTx` da 409 si el despacho tiene una
  devolución vigente: primero se anula la NC. Prueba en `sales-returns.db-spec.ts`.
- **P1 — corregido.** Refacturar lo devuelto y devolverlo otra vez creaba stock: lo devuelto ya no vuelve a quedar
  pendiente de facturar (`withReturnedQty` en el tope y en el avance del pedido; la anulación del pedido no
  cambia). Prueba en el db-spec.
- **P1 — corregido.** El reparto ignoraba el comprobante y la fecha: ahora sale primero de los despachos que
  declara el comprobante acreditado y nunca de uno posterior a la fecha de la NC.
- **P2 — corregido.** Un VENDEDOR podía registrar más tarde una NC fechada otro día: registrar una NC de devolución
  revalida la fecha (`assertIssueDate`).
- **P2 — anotado.** Falta el par concurrente en `lock-order.db-spec.ts`. El orden es comprobante → despachos →
  pedido → `lockInOrder` y el plan se calcula con todo bloqueado; además, el plan ya no puede salir de un despacho
  que no se bloqueó (409 «vuelve a intentarlo»).
- **P2 — corregido.** Re-fechar el comprobante con una devolución vigente desalineaba el despacho: se bloquea.
- **P2 — anotado.** En Ventas y margen, las NC 03 y 13 pasan a «descuento» con costo cero (decisión del dueño). Las
  06/07 declaran su costo solo si tienen devolución vigente (corregido).
- P3 (anotados): el redondeo de las partes puede dejar el último costo ≤ 0 en un caso raro; el cierre de la bobina
  al revertir lee la auditoría; la anulación no toma los despachos (la reversa del despacho ya no compite: se
  bloquea con devolución vigente); no hay CHECK `total_cost >= 0`.

Sin hallazgos: regla dura 8 (`record` y `reverse`), Decimal, auditoría en los 4 destinos en la misma transacción,
409 al anular si ya se revendió, NC de devolución no va al PSE, costo oculto a otros roles, PEPS código 24.
