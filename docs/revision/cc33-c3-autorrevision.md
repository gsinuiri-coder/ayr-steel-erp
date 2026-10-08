# Autorrevisión cc33 corte 3

> **Autorrevisión**: lista de riesgos, no aprobación. La hizo un subagente que no implementó el
> cambio ni leyó su handoff. Diff: `origin/cc33-c2...origin/cc33-c3` (6 archivos).

Las partes (a) y (b) están bien hechas y respetan la regla 17. No hay ningún camino que deje una NC
viva sobre un afectado muerto, salvo la carrera de la baja ante el PSE.

## P1

- **P1-1.** Un borrador tardío aborta el registro de una baja que SUNAT ya aceptó (`lateDraft`
  dentro de la transacción de `voidDocument`). El ERP queda ACCEPTED mientras SUNAT dio de baja,
  y el ticket se pierde. Sobra, porque la parte (b) ya vuelve inofensivo ese borrador. Arreglo:
  quitarlo.

## P2

- **P2-1.** Una NC viva que entra durante la llamada al PSE deja al ERP y a SUNAT distintos, y el
  mensaje no dice que la baja ya se comunicó. Arreglo mínimo: el mensaje. El arreglo de fondo
  (reclamar la factura antes del PSE) es decisión del dueño.
- **P2-2.** El par C10 no ejercita la parte (b), y `alwaysRejected=[1]` apunta a operaciones
  distintas cuando las iteraciones invierten el orden. Arreglo: no invertir, y sumar un caso
  secuencial contra la base que pruebe el 409.

## P3

- **P3-1.** «elimina primero» contra el botón «Descartar borrador».
- **P3-2.** El borrador se nombra por `createdAt` y no por su fecha de emisión.
- **P3-3.** Un comentario dice que la condición es la misma que la de `createCreditNote`, que no
  mira `archivedAt`.
- **P3-4.** Faltan unitarios del chequeo dentro de la transacción de la baja, de VOID_PENDING y
  del afectado archivado por `assignInTx`/`registerManual`.
- **P3-5.** El E2E redondea con `Number`.
- **P3-6.** Serie y correlativo al azar en el E2E: riesgo bajo de choque.
- **P3-7.** Falta saber si hay datos de producción afectados.

## Verificado sin hallazgo

- **Caminos:** `registerManual`, `assignInTx`, `send`, el mostrador, `correctInner`,
  `sendPending`, `retry` y `createCreditNote`.
- **Reactivar:** D-373/D-378 ya rechazan las notas posteriores.
- **Estados:** VOID_PENDING.
- **Mostrador:** la boleta no tiene afectado y la NC sale sobre una boleta ACCEPTED.
- **Bloqueos:** lectura previa de un campo inmutable; una sola sentencia ordenada; comprobante →
  pedido.
- **Mensajes:** 400 en el chequeo previo y 409 dentro de la transacción.

## Qué se hizo con cada hallazgo (ambas revisiones)

| Hallazgo                            | Resolución                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 (esta) / P2-1 (segundo modelo) | Corregido: se quitó el chequeo de borradores dentro de la transacción de la baja. Un unitario prueba que un borrador tardío no impide registrar la baja.                                                                                                                                                    |
| P2-1 (esta)                         | Mensaje corregido: dice que la baja ya se comunicó y que hay que consultar al PSE. El chequeo de notas vivas dentro de la transacción se queda (lo pide el brief). La carrera ERP/SUNAT queda como riesgo conocido en D-536; el arreglo de fondo (reclamar la factura antes del PSE) es decisión del dueño. |
| P2-2 (esta) / P3-1 (segundo modelo) | Corregido: C10 sin invertir el orden; nuevo C10b contra la base (factura anulada con borrador → registrar da 409, la nota sigue en borrador).                                                                                                                                                               |
| P3-1                                | Corregido: «descarta primero».                                                                                                                                                                                                                                                                              |
| P3-2                                | Corregido: el borrador se nombra por su fecha de emisión.                                                                                                                                                                                                                                                   |
| P3-3                                | Corregido: comentario.                                                                                                                                                                                                                                                                                      |
| P3-4                                | Corregido en parte: unitarios de la transacción de la baja (nota viva → 409; borrador tardío → baja registrada). VOID_PENDING y archivado: cubiertos por la función suelta.                                                                                                                                 |
| P3-5                                | Corregido: `toDecimal`.                                                                                                                                                                                                                                                                                     |
| P3-6                                | Sin cambio (mismo patrón que `comprobante-manual`).                                                                                                                                                                                                                                                         |
| P3-7                                | Medido: diagnóstico de producción del 2026-10-08, 0 NC vivas o en borrador sobre facturas muertas.                                                                                                                                                                                                          |
| P3-3 (segundo modelo, mostrador)    | Queda en la UAT.                                                                                                                                                                                                                                                                                            |
