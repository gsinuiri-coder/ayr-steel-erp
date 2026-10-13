# cc50 corte A — autorrevisión (subagente nuevo, no aprobación)

Diff `origin/main...cc50-auditoria` (16813963) más los db-spec sin commitear de ese momento. Sin P0 ni P1.

Bien: todos los `audit.write` nuevos usan el `tx` de su operación; ningún valor de negocio, kardex ni
monto cambia (solo la forma del retorno de `applyLandedCost`, que agrega `relatedDocument`). Pago y
reversa después del `FOR UPDATE` y del claim; costo de importación solo con bobinas imputadas;
factura del corte solo al crear (ninguna otra ruta cambia `relatedCuttingOrderId`); anular pedido,
un registro por OP en `idleIds`; cambiar cantidad en los dos caminos, la vista previa deshecha por
rollback; resolver del lote sin consultas; `voidPrevious` con servicios primero.

## Hallazgos

- **P2-1** Registros históricos de pagos (`supplier_payments`) y lotes (`purchases` + id del lote)
  quedan fuera del «Historial» (lote viejo = «Eliminado · …»). No retroactivo por decisión del dueño
  → anotado en D-638, UAT y handoff.
- **P2-2** Anular el servicio revertía el costo de importación sin dejar nada en la compra de
  bobinas → **corregido** (`purchases.landed-cost-reverse`, 710ad9b1). Anular la factura del corte
  no deja nada en la orden de corte → P3 anotado (el dueño pidió solo «vincular»).
- **P2-3** Pruebas de fallo que rechazaban antes de escribir → **corregido**: fallo inyectado después
  de los demás registros en anular pedido, cambiar cantidad, costo de importación, factura del corte
  y lote (710ad9b1).
- **P3-1** `inspect-cc33-cli.ts` dejaba de ver los pagos nuevos → corregido (`after.paymentId`).
- **P3-2** Comentario del resolver del lote inexacto → corregido.
- **P3-3** `amountPen` del registro es el total del servicio aunque una bobina se haya saltado (misma
  semántica que `purchases.receive`) → anotado.
- **P3-4** Registro de la OP aunque los metros no cambien (cambia solo la mezcla de largos) → anotado.
- **P3-5** Etiquetas fuera de orden alfabético en el archivo → anotado (el filtro ordena por rótulo).
- **P3-6** Las etiquetas de campo nuevas también rotulan registros viejos de otras acciones → mejora,
  anotada para el UAT.
