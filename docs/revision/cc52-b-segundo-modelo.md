# cc52 corte B — revisión del segundo modelo (Sonnet, contexto limpio)

Alcance: `git diff cc52-a-menores..c92d3107`, solo lectura.

Resumen: P0 ninguno · P1 2 · P2 5 · P3 5.

- **P1 — corregido.** Revertir el despacho después de una devolución reingresaba dos veces (mismo hallazgo que el
  P0 de la autorrevisión): 409 con devolución vigente.
- **P1 — corregido.** El pedido se podía refacturar sin mercadería: lo devuelto cuenta como consumido en el tope de
  facturación y en el avance.
- **P2 — corregido.** NC de devolución sobre un comprobante electrónico quedaba atascada (no va al PSE ni se registra
  a mano): se rechaza al crearla.
- **P2 — corregido.** El reparto no miraba qué comprobante declara cada despacho: ahora los suyos primero.
- **P2 — corregido.** Los despachos se leían antes de bloquearlos: el plan no puede salir de uno no bloqueado.
- **P2 — anotado.** Al anular, cualquier 400 de la reversa se informa como «ya no está en el almacén»; el mensaje
  incluye el original.
- **P2 — corregido.** Ventas y margen: una NC 06/07 solo «declara su costo» si tiene devolución vigente (antes,
  por el motivo).
- P3 (anotados): redondeo de partes; NC con fecha anterior al despacho (corregido: no se devuelve un despacho
  posterior a la NC); el vendedor leía cualquier devolución (corregido: alcance por vendedor); CHECKs extra en la
  migración sin consecuencia funcional.

Verificado: `operationDate` de la NC pasa por `assertIssueDate`; dos NC concurrentes se serializan en los despachos;
auditoría en la misma transacción; el UNION ALL del margen imputa a la NC y el periodo original no cambia;
la validación de fecha del diálogo refleja la del API.
