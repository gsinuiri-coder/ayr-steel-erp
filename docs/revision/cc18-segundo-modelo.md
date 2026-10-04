# Revisión de segundo modelo (Sonnet, contexto limpio) — cc18, D-386: orden único de bloqueos

Fecha: 2026-10-04. Rama `cc18/orden-bloqueos`, commit revisado `5baeee0`.

Fue de solo lectura: no se corrió nada contra bases de datos ni se ejecutaron tests. Todo sale de
leer el código de la rama y `git diff origin/main...HEAD`.

## Veredicto

- **P0: ninguno. P1: ninguno.** No hay un ciclo nuevo introducido por el cambio. Los caminos que el
  cambio reordenó toman documento → reservas → bobinas (una sola sentencia) → saldos de forma
  consistente entre sí:
  - despacho y su reversa;
  - anulación de compra y «Editar compra»;
  - confirmar pedido;
  - producción de coberturas y de drywall;
  - partido y restauración.
- **Grupo C:** se confirma como lo describe el mapa y el cambio no lo empeora. La revisión agrega
  dos cruces que el mapa no nombraba (P2-3).
- Quedan **4 P2 y 6 P3**. Ninguno bloquea el deploy.
- El mapa tenía un dato inexacto. Antes de cc18, `cutting.cancel` no tomaba la bobina por fila: por
  cada fila hacía el UPDATE de `cutting_order_coils` y después tomaba la bobina.

## Hallazgos

### P2-1. `cutting.cancel` toma las bobinas antes que las filas de `cutting_order_coils`

`cutting.service.ts`.

- **`receive` y `reverse`:** fila de `cutting_order_coils` → bobina (y su agregado) → saldos → al
  final, `cutting_orders` (UPDATE en `recomputeOrderStatus`).
- **`cancel`:** `cutting_orders` → bobinas → UPDATE de las filas.

El ciclo con recibir la misma bobina ya existía antes, por la arista `cutting_orders` ↔ fila de
corte. Es una ventana estrecha y termina en un 409 con rollback.

Propuesta:

- en `cancel`, tomar las filas pendientes por id antes de las bobinas;
- para cerrar también la arista que queda, `receive` y `reverse` deberían tomar `cutting_orders`
  antes que la fila.

### P2-2. `purchases.receive` de producto terminado toma los saldos en el orden de las líneas

`purchases.service.ts`, dentro de `receive`. Cada línea hace `record(IN)`, y una compra (b, a)
cruza con un despacho (a, b). El `NOWAIT` no ayuda, porque son saldos de producto. Propuesta:
`lockInOrder` con los productos de las líneas antes del bucle.

### P2-3. Grupo C, confirmado, con dos cruces no nombrados

Los tres cruces que ya describía el mapa:

- la reversa de reporte de drywall escribe reserva → pedido después de los saldos;
- `updateItemQty` va pedido → reservas → bobinas y saldos → OP;
- el cierre de coberturas sin despunte libera la reserva después de los saldos.

Los dos cruces nuevos:

1. **Reversa de reporte de drywall × despacho del mismo pedido.** El despacho va
   reserva → saldo; la reversa va saldo → reserva. El cruce ya existía antes del cambio.
2. **Reversa de reporte de coberturas.** `restoreReservationQty` de la reserva de materia prima
   queda al final. Cruza con anular el pedido cuando `id(R_op) < id(R_p)`.

Cada uno exige dos operaciones manuales raras sobre el mismo pedido en el mismo segundo. No hay
corrupción. Hoy sale 409 en vez de 500.

### P2-4. Cierre y anulación de OP de drywall terminan flejes con un UPDATE implícito fuera de la puerta

- En `close`, `lockInOrder` solo recibe los flejes con remanente. Los consumidos enteros los
  termina después `autoTerminateEmptyCoils` (con `coil.updateMany`), con saldos en mano.
- En `cancel` pasa lo mismo, sin ninguna toma previa.

Propuesta: pasar todas las filas como `coilIds`.

### P3-1. El re-fechado de despachos encadena varias puertas en una transacción

`invoice-dispatch.service.ts`: varias reversas y `executeInTx` en la misma transacción. Es solo
para administrador y ya estaba así antes. Propuesta: tomar la unión una sola vez.

### P3-2. Crear un borrador de comprobante con despacho va pedido → despacho

`invoicing.service.ts`. `reverseInTx` va despacho → pedido. Está fuera del diff y no toca kardex.

### P3-3. `isLockConflict` mira el texto del mensaje

Un «40001» dentro del mensaje de otro error (por ejemplo, un correlativo) lo haría pasar por
conflicto de bloqueo. Propuesta: leer `meta.code`, y del texto solo «deadlock detected» y «could
not serialize access».

### P3-4. Conviven dos criterios de orden

`reserveLines` y `purchase-received-edit.service.ts` ordenan con `localeCompare`. Hoy dan lo mismo
que `compareLockKeys`, pero son dos fuentes de verdad.

### P3-5. Costo de `lockCoil`

Hace varias consultas más por llamada, y algunas llamadas están dentro de bucles. No se midió.

### P3-6. Cobertura de pruebas de contención

Faltan pruebas para:

- producción × despacho o pedido;
- corte: anular × recibir;
- `purchases.receive` de producto;
- `NOWAIT` en una operación real.

## NOWAIT de `row-locks.ts`

**Lo que cubre.** Cierra la ventana de P3-2 para las filas de `coils`. No encontró 409 espurios en
caminos comunes: el conjunto tomado de antemano cubre lo que las guardas piden después.

**Dónde puede saltar el 409 con contención real:**

- editar una bobina cambiándole color o espesor;
- el re-fechado (P3-1);
- una promesa nueva confirmada a mitad de una operación.

**Lo que no cubre:**

- saldos de producto (P2-2, P3-1);
- reservas y documentos (grupo C);
- UPDATE implícitos sobre bobinas que no se tomaron antes (P2-4).

## `LockConflictFilter`

- **Lo que mapea a 409**, con el mensaje en español:
  - P2034;
  - P2010 con `meta.code` 40P01 o 40001;
  - el texto de Postgres;
  - `LockOrderConflict`.
- **Lo demás** sigue por el filtro de siempre.
- El mensaje habla de «inventario» aunque el ciclo sea de documentos. Es aceptable: el log `warn`
  los distingue.

## Tabla: par de operaciones → ¿puede cruzarse?

| Par | ¿Puede cruzarse? | Por qué |
| --- | --- | --- |
| Despacho × despacho (otros pedidos, mismos ítems) | no | Pedido propio; reservas por id; bobinas en una sentencia; saldos por clave. |
| Despacho × anulación de compra | no | Compra → bobinas+agregado → saldos. Cubierto por el db-spec. |
| Despacho × confirmar pedido | no | Ambos: bobinas con agregado → saldos por clave. Cubierto. |
| Despacho × «Editar compra» / `replaceEntry` | no | Compra → bobinas → saldos ordenados. Cubierto. |
| Despacho × reversa de despacho (otro pedido) | no | Mismo orden. |
| Despacho × reportar (mismo pedido) | no | Reportar toma el pedido; el despacho espera ahí. |
| Despacho × reportar (otro pedido) | no | Bobinas → saldos en ambos. |
| Despacho × reversa de reporte de coberturas | no | La reversa toma primero la reserva del producto. |
| Despacho × reversa de reporte de drywall (mismo pedido) | solo grupo C | Reserva → saldo contra saldo → reserva; ya existía. |
| Anulación × anulación / «Editar compra» (misma compra) | no | Las serializa la fila de la compra. |
| Anulación de compra × reportar, cerrar, montar, corte | no | Bobinas antes que saldos en todos. |
| Anulación de compra × cierre/anulación de OP de drywall | solo en teoría (P2-4) | UPDATE implícito fuera de la puerta. |
| Confirmar × partido, merma, cerrar bobina | no | Bobinas con agregado → saldos. |
| `updateItemQty` × montar en la OP de la línea | solo grupo C | Bobinas y saldos → OP, contra OP → bobinas. |
| Montar × reportar × cerrar (misma OP) | no | Las serializa la fila de la OP. |
| Reversa de reporte de coberturas × anular pedido | solo grupo C | Reserva de materia prima al final. |
| Reversa de reporte de drywall × anular pedido | solo grupo C | Reserva → pedido después de los saldos. |
| Una bobina (cerrar, partir, mermar, editar) × despacho, confirmar, producción | no | `lockCoil` con agregado; la edición con cambio de agregado da 409 por `NOWAIT` con contención. |
| Corte: recibir × anular (misma bobina) | sí (P2-1) | Ya existía antes. |
| `purchases.receive` de producto × despacho, confirmar | sí (P2-2) | Saldos en el orden de las líneas. |
| Re-fechado de despachos × otros | sí (P3-1) | Conjuntos sucesivos. |
| Borrador de comprobante × reversa de despacho | sí (P3-2) | Pedido → despacho contra despacho → pedido. |
| Restaurar bobina, deshacer lote × demás | no | En el orden canónico. |

## Resolución (autor, 2026-10-04)

Se completa al cerrar la sesión.
