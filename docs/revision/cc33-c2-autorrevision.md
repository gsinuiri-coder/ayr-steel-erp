# Autorrevisión cc33 corte 2

> **Autorrevisión**: lista de riesgos, no aprobación. La hizo un subagente que no escribió el
> cambio ni leyó su handoff. Diff: `origin/cc33-correcciones...origin/cc33-c2`.

## Veredicto

Sin P0, P1 ni P2. N2 y N4 hacen lo que dicen. Quedan cuatro P3.

## Comprobaciones sin hallazgo

1. **La clave de idempotencia** se escribe en el mismo `tx`: el rechazo la revierte. Una
   repetición con la misma clave sale antes, pero `findOne(id, actor)` aplica el alcance. El
   mostrador no manda clave y usa una sola transacción.
2. **Flujos legítimos:**
   - el mostrador fija `sellerId: actor.id` y usa el mismo cliente;
   - las notas de crédito salen por su rama;
   - editar el cliente de un pedido (D-187) se rechaza si hay un comprobante en pie, borrador
     incluido (`lockEditable`);
   - mover un comprobante a otro pedido exige el mismo cliente;
   - reactivar (D-373/D-378) y traer comprobante (D-381) no pasan por estos caminos;
   - `correct()` copia pedido y cliente;
   - la guía de remisión sale antes.
3. **Los dos que llaman** a `assertStillAvailable` cargan la fila completa.
4. **Orden de bloqueos:** no se agrega ningún `FOR UPDATE`.
5. **Las pruebas fallan con el bug:** el E2E de N2 tiene tres aserciones independientes y el de N4
   recibía 201.
6. **Mensajes** coherentes con los existentes: 400 al crear y 409 en la reválida.

## Hallazgos

- **P3-1.** `salesOrderId?` y `customerId?` son opcionales en el tipo. Un llamador futuro con
  `select` podría apagar la comprobación o dar un falso «otro cliente». Arreglo: hacerlos
  obligatorios.
- **P3-2.** Un VENDEDOR sobre un pedido con `sellerId` nulo antes pasaba por el respaldo
  `createdById` de `findOne`; ahora recibe 404, igual que el detalle del pedido. El riesgo es bajo.
- **P3-3.** La comparación de cliente al emitir alcanza también a los borradores con líneas de
  pedido. Arreglo: contar antes del despliegue.
- **P3-4.** El E2E no cubre registrar o emitir un borrador ya creado. Lo cubre el unitario.

## Qué se hizo con cada hallazgo (ambas revisiones)

| Hallazgo                          | Resolución                                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P2 (segundo modelo) / P3-1 (esta) | Corregido: `salesOrderId` y `customerId` son obligatorios en el tipo de `assertStillAvailable`; el compilador detecta un `select` que los omita.       |
| P3-2                              | Sin cambio: es la regla del pedido (RF-S3c). Se registra en D-535.                                                                                     |
| P3-3                              | Medido: el diagnóstico de producción del 2026-10-08 da 0 comprobantes vivos o en borrador con pedido anulado o de otro cliente (1 anulado, ya muerto). |
| P3-4 y P3 del segundo modelo      | Sin cambio: cubierto por unitarios; la creación, por E2E con mutación.                                                                                 |
