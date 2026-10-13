# cc51 corte A — autorrevisión (subagente nuevo, sin el handoff)

Alcance: `git diff origin/main...cc51-a-auditoria` (commit 60eecf75, 13 archivos), solo lectura. Es
una lista de riesgos, no una aprobación.

Resumen: P0 ninguno · P1 ninguno · P2 ninguno · P3 6.

- D-639: el registro va con el `tx` de `cancel`, después de las reversas y antes de `purchases.cancel`;
  solo se movió la declaración de `landedReversed`. `relatedPurchaseId` y `relatedCuttingOrderId` no
  conviven (schema y alta). El monto es exactamente lo revertido (`liveMovements`); si un fleje ya se
  movió, `assertNothingMovedAfter` corta la anulación y no queda registro.
- D-640: los prefijos de `status`, `reason`, `kind` y `docType` eligen el enum correcto contra las
  acciones reales; el motivo libre no se toca; sin importación circular; la pantalla delega en la
  misma función que el Excel.

P3:

1. Búsqueda en objetos literales: una clave o un valor `constructor`/`toString` devolvía una función.
   **Corregido** con `Object.hasOwn`, con prueba.
2. El inventario de la prueba comprueba que haya traducción, no cuál. Anotado (hay pruebas de rótulo
   exacto en los choques).
3. La prueba negativa no podía fallar. **Corregida** con un flete recibido y anulado.
4. Forma distinta a `purchases.landed-cost-reverse` (monto en `after` contra `before`). Anotado.
5. Monto cero no distingue borrador de «sin flejes con saldo». **Comentario corregido**; anotado.
6. `type` y `kind` comparten el rótulo «Tipo». Anotado.
