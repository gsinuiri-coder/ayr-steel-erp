# cc52 corte A — autorrevisión

**Autorrevisión:** la hizo un subagente que no leyó el handoff de implementación. Es una lista de riesgos, no una
aprobación, y no vale como pase cruzado.

Alcance: `git diff 0a48fc38..cc52-a-menores`, leído por refs de git (D-642, D-643, D-644, D-648, hash de relleno,
`inspect:cc52`).

Resumen: P0 ninguno · P1 1 · P2 4 · P3 varios.

- **P1 — corregido.** La entrega no estaba completa en la rama: faltaba commitear el helper E2E (costo por
  defecto 5), el carrito del mostrador y el E2E nuevo.
- **P2 — anotado (riesgo, D-648).** Una salida atrasada a una fecha en la que el ítem no tenía saldo no pasa por
  la regla (no hay promedio con qué comparar), y D-124 solo avisa del orden. Queda para el recosteo (cc53).
- **P2 — corregido.** Falsos rechazos por redondeo: ahora se avisa solo con más de una diezmilésima por unidad **y**
  al menos un céntimo en la salida.
- **P2 — corregido.** Faltaban pruebas: unitarias de `assertBackdatedCost` (rechazo, 403, aceptación, mismo
  costo) y de la tolerancia.
- **P2 — corregido.** El re-fechado de emisión registraba como «rechazo» la pregunta de costo
  (`onRedateRejected`): se excluye `BACKDATE_COST_MISMATCH`.
- P3 (anotados): la herramienta de D-285 sin la opción (corregido: pasa «Registrar igual» explícito); saldo cero
  hoy da primero el mensaje de costo; un ajuste posterior de una compra anterior cuenta como posterior; el cajero
  ve el costo en el mensaje del piso (como en la cotización, D-163); el PDF de bobinas no imprime el filtro;
  fechas imposibles en la URL del filtro (corregido con `isCalendarDate`).

Sin hallazgos: regla dura 8, Decimal, orden de bloqueos, auditoría en la misma transacción, 403 del vendedor
antes del piso, motivo «A costo» validado.
