# Autorrevisión — D-364

**Revisor:** agente independiente, solo lectura.  
**Alcance:** diff de `feat/fecha-despacho-editable` contra `origin/main`.

## Hallazgos y resolución

1. **Alto, resuelto:** una fecha elegida llevaba la misma nota que el despacho automático y D-288 podía revertirla/recreararla al corregir la emisión. D-364 ahora guarda `userChosenDate`; `isAtIssueDateDispatch` reconoce solo las tres notas automáticas, por lo que D-288 deja intacta la fecha elegida.
2. **Alto, resuelto:** el schema inicial admitía un día inexistente que `Date` normalizaba después de planificar. `invoiceDispatchDateSchema` usa ahora `operationDateSchema`, que exige un día calendario exacto antes del preview o la ejecución.
3. **Medio, resuelto:** al elegir fecha, la pantalla dejaba de mostrar el default D-285 original. La UI conserva los defaults recibidos sin fecha elegida y los muestra por línea.

4. **P1, resuelto en el pase de verificación:** el grupo `BEFORE_OPENING` también conservaba la nota automática cuando la fecha había sido elegida. Ahora usa `userChosenDate` en ese caso, por lo que D-288 tampoco lo re-fecha.\n\nNo quedan hallazgos P0/P1 tras el pase final.
