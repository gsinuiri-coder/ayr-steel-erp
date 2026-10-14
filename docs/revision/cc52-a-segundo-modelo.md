# cc52 corte A — revisión del segundo modelo (Sonnet, contexto limpio)

Alcance: `git diff 0a48fc38..cc52-a-menores`, solo lectura.

Resumen: P0 ninguno · P1 1 · P2 3 · P3 4.

- **P1 — corregido.** La herramienta de D-285 (`opening-date-move.service.ts`) llamaba a `addMissingMovementInTx`
  y `executeInTx` sin la opción: una salida con costo distinto habría cortado el plan a medias. Ahora pasa
  «Registrar igual» explícito (herramienta de un solo uso, solo ADMINISTRADOR; el kardex lo audita).
- **P2 — corregido.** Deriva de redondeo en la comparación a 4 decimales (tolerancia de una diezmilésima y un
  céntimo en la salida).
- **P2 — corregido.** Quien no es ADMINISTRADOR veía «Registrar igual» y recibía un 403: el diálogo ya no lo
  ofrece y dice «Pídele a un administrador».
- **P2 — anotado.** `laterCount` cuenta también las reversas IN (de un OUT) posteriores; el mensaje puede inflar
  el número. Es informativo.
- P3 (anotados): fechas imposibles en el filtro de bobinas (corregido); faltan casos de prueba (ADJUST posterior,
  reversa posterior, límite inclusivo); no hay un `verify` real contra el hash de relleno (la prueba comprueba
  los parámetros); el piso del carrito compara por unidad de venta (coincide con la del panel en los productos
  que vende el mostrador).

Verificado: el SQL del saldo a la fecha replica la cuenta del kardex; el rol se lee contra el usuario del
movimiento; la auditoría va en la misma transacción; todos los `record` de salida con fecha reciben la opción;
el 403 del «A costo» va antes del piso.
