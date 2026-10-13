# cc50 corte A — revisión del segundo modelo (Sonnet, contexto limpio)

Alcance: `git diff origin/main...cc50-auditoria` (11 archivos), solo lectura.

Resumen: P0 ninguno · P1 ninguno · P2 3 · P3 6.

- Transacción: todas las auditorías nuevas usan `tx` dentro de la transacción de su operación, salvo
  la excepción documentada (resumen del deshacer del lote).
- Datos de negocio y bloqueos: sin cambios; `AuditService.write` solo inserta y va después de los
  bloqueos existentes (regla 17 intacta).
- Por camino (pago y reversa, costo de importación, factura de corte, lote, anular pedido, cantidad
  de línea): un registro por operación, sin duplicados; la vista previa se deshace por rollback; la
  OP nueva por diferencia ya tiene su `production.create`.
- Datos sensibles: ninguno nuevo (ids, documento, montos, moneda; `reference` del pago no se copia).

## P2

1. La prueba «si la anulación falla» rechaza antes de escribir: no prueba atomicidad. Inyectar el
   fallo después de las auditorías (spy sobre `audit.write` en `sales.order.cancel`).
2. Las pruebas de fallo del costo de importación y del lote tampoco ejercitan el rollback (fallan
   antes del `write`). Forzar el fallo después del `write`.
3. Registros anteriores de pagos (`supplier_payments`) y de lotes (`purchases` con id de lote)
   quedan fuera del «Historial»; un lote viejo se ve como «Eliminado · …». No retroactivo por
   decisión del dueño: dejarlo en handoff/UAT.

## P3

1. `inspect-cc33-cli.ts:373` filtra pagos por `entity: 'supplier_payments'`: los nuevos no entran.
2. Valores sin traducir (`FREIGHT`, `TRANSFER`, `PEN`) en el detalle.
3. Orden alfabético de algunas etiquetas en el archivo.
4. El resumen `imports.purchases.undo` en su propia transacción: que el dueño lo acepte.
5. El resolver de lotes nunca marca «eliminado» y el lote no es buscable en el buscar.
6. Falta una aserción de que `resizeStarted` con OP nueva por diferencia no duplica el registro.

## Seed H1 y `voidPrevious`

Servicios primero: el flete recibido se anula antes y la compra de bobinas ya no queda bloqueada. Sin
el reordenamiento la segunda corrida fallaría. F996/F997 en borrador; pago ya revertido. Riesgo
residual bajo.

Conclusión: sin bloqueantes; reforzar P2-1 y P2-2 antes del deploy y registrar P2-3 y P3-4.

## Qué se hizo

- P2-1 y P2-2: **corregidos** en `710ad9b1`: el registro se fuerza a fallar después de los demás en
  anular pedido, cambiar cantidad, costo de importación, factura del corte y lote, y la operación
  entera se deshace (25 de 25 db-spec).
- P2-3 y P3-4: anotados en D-638, el UAT y el handoff (no retroactivo; excepción del deshacer).
- P3-1: **corregido** (`inspect-cc33` lee `after.paymentId`).
- P3-2, P3-3, P3-5, P3-6: anotados.
