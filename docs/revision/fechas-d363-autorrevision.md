# Autorrevisión — D-363 y regresión de `--undo` (PR #58)

2026-09-29. Subagente nuevo, solo lectura, sin el handoff de implementación. No sustituye la revisión del dueño.

## Hallazgos

- **P1, corregido:** el fixture del `--undo` declaraba el reemplazo como movimiento 3, pero devolvía el movimiento 1 al consultarlo. La prueba ahora devuelve el 3, exige ese ID y comprueba el umbral `id > 3`.
- **P2, corregido:** el fixture del movimiento ajeno posterior solo contenía su ID. Ahora lo representa expresamente como `OUT`/`SALE`, distinto de la reversa propia `OUT`/`PURCHASE`.

Sin otros P0/P1 en el filtro de anulados, el aviso visual ni la documentación. Después de corregir ambos fixtures, el unitario focalizado pasó.
