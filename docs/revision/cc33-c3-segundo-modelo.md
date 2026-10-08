# Revisión de segundo modelo — cc33 corte 3

Modelo: Sonnet, contexto limpio. Diff `origin/cc33-c2...origin/cc33-c3` (6 archivos). Revisión
por lectura; no corrió tests.

**Veredicto: sin P0 ni P1.**

- **Orden de bloqueos.** `lockWithAffected` toma [nota, afectado] en una llamada, por id.
  `annulExternal`, `voidDocument` y `createCreditNote` toman solo el afectado. Ningún camino toma
  la nota y después el afectado, así que no hay ciclo.
- **Lectura previa sin lock.** `affectedDocumentId` no cambia nunca.
- **Mostrador.** La NC de la anulación de boleta se crea sobre una boleta ACCEPTED. Una venta no
  tiene afectado.
- **Reimportación.** Un afectado archivado ya no se acredita, a propósito.

## P2

- **P2-1.** En la baja, el chequeo de borradores dentro de la transacción (`lateDraft`) desalinea
  el ERP de SUNAT: el PSE ya dio la baja, el 409 deja la factura ACCEPTED. Sobra, porque con el
  afectado VOIDED un borrador tardío ya no se registra ni se emite. Arreglo: quitarlo. `liveNotes`
  tiene la misma forma, pero es lo que prometía el comentario original y es más improbable: el
  dueño debería saberlo.
- **P2-2.** El chequeo previo de la baja va fuera de transacción. Es un filtro rápido; el cierre
  real es el de dentro.

## P3

- **P3-1.** El par C10 casi no ejercita la carrera: con el borrador ya creado, la anulación siempre
  se rechaza. Solo prueba que no hay deadlock.
- **P3-2.** El chequeo dentro de la transacción de la baja no tiene test.
- **P3-3.** En el mostrador, un reintento con un borrador huérfano de un `send` fallido ahora se
  rechaza con el mensaje del borrador. Es mejor que antes. Revisar en la UAT.
- **P3-4.** Mensajes coherentes: 400 en el chequeo previo y 409 en el tardío.

Tests: prueban lo que dicen. El mock de `annulExternal` depende del orden de las consultas.
