# PR #58 — revisión de Sonar (segundo modelo)

Fecha: 2026-09-29. Alcance: pruebas nuevas de la inspección y hallazgo S2871 en `purchase-received-date-fix.ts`.

El segundo modelo señaló un riesgo P1: sustituir `Array.sort()` por `localeCompare` en las claves de bloqueo cambiaría el orden de adquisición. `reserved-ledger.ts` define `byCodeUnit` y documenta expresamente ese invariante para evitar interbloqueos. Se revirtió el cambio propuesto y se marcó el hallazgo de Sonar como **Won't Fix**, con esa justificación. No se modificó el comportamiento del tool de fechas.

La autorrevisión señaló dos debilidades P2 en la prueba de inspección: la simulación no dependía realmente de la fecha movida y la aserción de la consulta era demasiado amplia. Ambas se corrigieron: el plan simulado pasa a `DISPATCH` solo con la fecha esperada, y se verifica el filtro de líneas y despachos emitidos.

La revisión del dueño sigue siendo el cierre de la entrega, conforme a `AGENTS.md` §2.
