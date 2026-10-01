# Revisión de segundo modelo — cc08 / D-375 (restaurar bobina anulada de compra)

- **Modelo:** Sonnet 5.5, con contexto limpio y sin leer el handoff de implementación. Es un
  modelo, no una persona (AGENTS.md §2 regla 2.2).
- **Fecha:** 2026-10-01.
- **Rama:** `cc08/desanular-bobina`.
- **Commits revisados:** `4a656a3`, `912c153`, `51843e3`, `264254e`.
- **Método:** lectura de código. No ejecutó la suite.

Resumen del informe. Cada hallazgo lleva lo que se hizo con él.

## P0

Ninguno.

## P1

- **P1-1. `EN_SU_FECHA` duplica el stock entre la fecha de la compra y la de la anulación.**
  - Escenario: el kardex queda con el IN original, la salida de la anulación (fecha de la
    anulación) y el IN nuevo en la fecha original. Entre las dos fechas la bobina muestra el
    doble, y cambian meses ya reportados.
  - **Corregido por decisión del dueño:** la entrada va en la **fecha de la salida de
    anulación**.
  - Test que proyecta el saldo por día con la AZUL de producción: 4150 continuos, nunca 8300.
  - Plan de producción a las 15:08 UTC: AZUL **EN_SU_FECHA 28/09**.
- **P1-2. Se pierde el landed cost.** La anulación de compra revierte también los `ADJUST`, y la
  restauración solo repite el IN.
  - **Corregido:** bloquea con ajustes de costo y lo nombra como motivo.
  - Ninguna de las 9 bobinas de producción tiene ajustes (foto de las 14:22 UTC).

## P2

- **P2-1. El mensaje del guard habla de «producción» para toda salida.**
  - **Corregido:** «Una salida de esta bobina no puede tener fecha anterior a…».
  - El alcance global queda por decisión del dueño.
  - `reverse` no pasa por el guard, a propósito.
- **P2-2. El undo no miraba el estado actual.**
  - **Corregido:** exige `OPEN`, sin reservas activas y sin flejes montados en una OP.
  - La reversa del undo va en la misma fecha que la restauración: con el P1-1 resuelto, el neto
    y la historia vuelven exactos al estado anulado.
- **P2-3. CLI: plan vacío y comparación parcial.**
  - **Corregido:** compara modo, fecha, fecha original, cantidad y costo, y rechaza un plan
    vacío.
- **P2-4. Stock vivo sobre una compra anulada.** Es la decisión del dueño («restaurar igual»).
  - El modal y el dry-run muestran «(anulada)».
  - E2E: la compra queda `CANCELLED`.

## P3

- **P3-1. Sin `idempotencyKey`:** es una transición de estado (D-182). El segundo intento da 409.
- **P3-2. Caché del plan en el modal:** **corregido**, se vuelve a pedir al abrir.
- **P3-3. `plan()` sin transacción:** es solo informativo; la escritura reclasifica con la fila
  bloqueada.
- **P3-4. Texto del modal para `A_HOY`:** se muestran los motivos junto al aviso.
- **P3-5. Orden de locks (bobina y después saldo):** correcto. No requiere cambio.

## Veredicto del revisor

«No apto hasta resolver P1-1 y P1-2». Los dos están resueltos en esta entrega.
