# cc30, corte 1: revisión de un segundo modelo

Rama `cc30-bloqueos-documentos`, diff `origin/main...HEAD` (12 archivos, 6 commits). Revisor: segundo
modelo (Sonnet), contexto limpio, sin haber leído el handoff de implementación. Es una lista de
riesgos, no una aprobación: la única revisión que cierra la entrega es la del dueño (AGENTS.md §2).

Alcance leído: `document-locks.ts` y su spec, `row-locks.ts`, `production-shared.ts`,
`production.service.ts`, `roofing-production.service.ts`, `sales-order-edits.service.ts`,
`lock-order-parent.spec.ts`, el diff de `lock-order.db-spec.ts`, D-470..D-476, la matriz y
`.claude/settings.json`. Corrí los tres specs unitarios que tocan la puerta
(`document-locks`, `lock-order-parent`, `row-locks.sentinel`): 18 pruebas verdes. **No corrí
`lock-order.db-spec.ts`** (necesita la base de pruebas), así que no afirmo nada sobre su resultado.

Veredicto de corrección: no encontré un deadlock nuevo, ni un `NOWAIT` que pueda salir en un camino
normal sin contención, ni un cambio de resultado, estado o mensaje. Los hallazgos son de
documentación contradictoria, un centinela prometido que no existe, un cambio de contención no
declarado y huecos menores de relectura. Ningún P0 ni P1.

## Recorrido de los llamadores de `lockOrder`

Para cada uno: ¿la transacción ya tenía inventario o reservas tomadas antes de llamarlo (que lo
volvería `NOWAIT`)?

| Llamador                                                                                                 | Antes de `lockOrder`                                                                                          | Resultado                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Drywall: `consume`, `release`, `closeInTx`, `reopen`, `cancel`                                           | solo la clave de idempotencia (o nada)                                                                        | en orden, espera normal                                                                                                                                |
| Drywall `report`, `reverseReport` (`own`)                                                                | idem                                                                                                          | en orden; la reserva propia entra en la misma pasada                                                                                                   |
| Coberturas: `updatePlan`, `mountCoil`, `releaseCoil`, `setPriority`, `reverseReport`, `reopen`, `cancel` | nada                                                                                                          | en orden                                                                                                                                               |
| Coberturas `reportInTx`                                                                                  | solo la clave de idempotencia                                                                                 | pedido y OP en `lockOrder`; las dos reservas, juntas, antes de cualquier saldo                                                                         |
| Coberturas `closeInTx` (`own`)                                                                           | nada; o, en «reportar y cerrar» y en «ejecutar borrador y cerrar», ya traía la reserva propia de `reportInTx` | no hay filas nuevas, no pide nada                                                                                                                      |
| Borradores: `loadState`, `remove`                                                                        | nada                                                                                                          | en orden                                                                                                                                               |
| `close-preview.ts:97`                                                                                    | nada; luego la acción vuelve a llamar                                                                         | segunda llamada: filas ya tomadas, no pide nada                                                                                                        |
| Fila 2 en adelante de un borrador                                                                        | todo tomado por la fila 1                                                                                     | no pide nada; la reserva de producto creada por la fila 1 se pide con `NOWAIT`, pero es una fila de esta misma transacción, así que no se puede ocupar |

Conclusión: ningún llamador entra a `lockOrder` con inventario ya en mano en un camino normal.

## Hallazgos

### P0

Ninguno.

### P1

Ninguno.

### P2

**P2-1. `docs/ARQUITECTURA.md` §3.3.1 (línea 573) sigue diciendo «la OP antes que el pedido» y contradice D-470.**
El diff agrega las filas D-470..D-476 y no edita §3.3.1, que es el texto que D-470 dice reemplazar.
Un agente futuro que lea §3.3.1 (AGENTS.md remite a ese apartado en la regla dura 17) recibe el
orden contrario al que el código implementa, y D-386 también lo repite en su fila. La regla 17 de
AGENTS.md («un documento se bloquea antes que sus filas hijas») queda coherente en el principio, pero
no lista el orden nuevo. Propuesta: reescribir el punto 1 de §3.3.1 con el orden de D-470/D-471
y añadir la referencia a `lockDocuments` en la regla 17.

**P2-2. El centinela de la puerta de documentos está declarado y no existe.**
`document-locks.ts:11-12` («Lo vigila `document-locks.sentinel.spec.ts`»), D-473 («Centinela
`document-locks.sentinel.spec.ts`: falla si aparece un `FOR UPDATE` … fuera de la puerta») y el
encabezado del archivo («el único `FOR UPDATE` sobre las tablas de documentos») afirman algo que el
repo no cumple a esta altura: `git ls-files` no tiene ese centinela, y un `rg "FOR UPDATE"` sobre
`apps/api/src` encuentra decenas de sentencias directas sobre `sales_orders`, `quotations`,
`reservations` y `production_orders` fuera de la puerta
(p. ej. `invoicing/dispatches.service.ts:193`, `sales/sales-orders.service.ts:391,2376,2706,4235`,
`sales/sales-order-edits.service.ts:404,898`, `production/production.service.ts:289`,
`production/roofing-production.service.ts:268`). Si el corte 2 las migra, el texto debe decir
«pendiente»; mientras tanto, la decisión figura como hecha. Propuesta: o se agrega el centinela con
una lista de excepciones nombradas y fechadas (como el de kardex, regla 8) o se corrige D-473 y el
comentario para decir que la migración y el centinela son del corte 2. Mientras haya sitios que
bloquean sin pasar por la puerta, su estado no queda en `state.documents` y la red de `NOWAIT` no los
ve: p. ej. `updateItemQty` toma el pedido con `lockEditable` (SQL directo) y después pide las OP por
la puerta; funciona porque el orden coincide, pero la puerta no lo sabe.

**P2-3. Toda operación de planta con `lockOrder` pasa a tomar el pedido: contención nueva, no declarada.**
`production-shared.ts:57-96`. Antes `lockOrder` bloqueaba solo la OP. Ahora toma pedido y OP para
**todos** los llamadores, también los que no escriben nada del pedido: `setPriority`,
`updatePlan`, `mountCoil`, `releaseCoil`, `remove` y `loadState` de borradores, y la vista previa de
cierre (que corre una transacción de hasta `COMMIT_PREVIEW_TIMEOUT_MS`). Consecuencias medibles:
(1) dos OP del mismo pedido ya no se operan en paralelo (reportar OP1 y OP2, transacciones de hasta
30 s y 120 s en el commit de borradores, se serializan por el pedido); (2) planta espera detrás de
cualquier transacción comercial que tenga el pedido (confirmar, `updateItemQty` hasta 60 s,
despachos, comprobantes). No es un deadlock y respeta D-470, pero la regla del encargo es que la pieza
cambia **cuándo** se toman bloqueos y no la concurrencia observable; esto sí la cambia para los
llamadores que no necesitaban el pedido. Propuesta: o se registra en una D-nnn como costo aceptado
(el dueño decide), o se acota: tomar el pedido solo en los llamadores que después escriben
reserva/pedido (`own`, reportar, cerrar, revertir, anular) y dejar `setPriority`, `updatePlan`,
`remove` y la vista previa sin el pedido. Esto último rompe el «un solo orden para todo» de D-470 solo
en apariencia: tomar solo la OP es un prefijo válido del orden.

**P2-4. Pruebas de concurrencia sin evidencia de que fallan con el código anterior.**
`lock-order.db-spec.ts` (nuevos describes `cc30 — grupo C…`). D-386 documentó su mutación («con
`lockInOrder` sin ordenar fallan los 6 pares…»); D-470..D-476 no dicen nada equivalente. Además, en
(b), (d) con anular y (a) con anular, la segunda operación **siempre** se rechaza
(`alwaysRejected: [1]`): el par solo prueba que anular toma sus bloqueos y se rechaza sin ciclo; es
válido para el cruce, pero la ausencia de 40P01 depende por completo de que la pausa de
`lockDocuments` abra la ventana. Propuesta: registrar en el informe de cierre la mutación (revertir
`ec93fb65` y mostrar que (a), (b) y (c) fallan con 40P01) y confirmar que los dos pares con
`alwaysRejected` fallan sin el fix; sin eso, no se sabe si prueban algo. Además el
`jest.spyOn(documentLocks, 'lockDocuments')` del `beforeAll` no se restaura (no hay `afterAll` con
`mockRestore`), así que queda activo para el resto del archivo y mete una pausa en cada llamada,
incluidas las que no toman nada.

### P3

**P3-1. `updateItemQty` decide el conjunto a bloquear antes de bloquear.**
`sales-order-edits.service.ts:665-678`. D-474 pide «los ids … se leen antes, sin bloqueo, y lo que
decide se relee bajo el bloqueo»; aquí se relee (`reservations`), pero el segundo `findMany` puede
traer una OP o reserva que no estaba en el primero (p. ej. una OP creada por
`createFromReservationInTx`, que toma la reserva con SQL directo y no el pedido) y esa fila no queda
bloqueada por la puerta: se escribe al final (`productionOrder.update`) con los saldos en mano, el
mismo patrón que el cruce (c) venía a cerrar. Hoy el pedido, bloqueado por `lockEditable`, serializa a
casi todos los que crean filas de esa línea, así que es una ventana estrecha. Propuesta: tras releer,
comparar los ids y, si hay alguno nuevo, volver a llamar a `lockDocuments` con ellos (queda `NOWAIT`
por orden, que es la red prevista en D-475).

**P3-2. `reportInTx` toma las dos reservas antes de validar el estado de la OP.**
`roofing-production.service.ts:1002-1018` ocurre antes de `order.status !== IN_PROGRESS` (línea 1019).
Una OP cerrada o en borrador toma reservas para luego rechazar con el mismo mensaje de siempre. No
cambia resultado ni mensaje, solo cuándo se bloquea; es contención gratuita. Lo mismo vale para
`closeInTx` y las reversas con `own`. Propuesta: aceptable según D-474; basta con anotarlo.

**P3-3. `createFromReservationInTx` seguido de `reportInTx` en la misma transacción toma las reservas fuera de orden.**
Si un llamador futuro encadena crear+reportar, la reserva se toma con SQL directo (`:268`), no queda
en `state.documents`, y `lockDocuments` después pide pedido (clase anterior) con espera en lugar de
`NOWAIT`: reserva → pedido, el orden inverso del canónico. Hoy ningún llamador lo hace
(verificado con `rg "reportInTx"` en `apps`), y la matriz lo anota como C6 para el corte 2. Se deja
constancia.

**P3-4. Parámetro `reservations.extra` de `lockOrder` sin ningún llamador.**
`production-shared.ts:62`. Código muerto; la clase `quotationReservations` de `DOCUMENT_LOCK_ORDER`
tampoco tiene llamador en este corte. Propuesta: quitar `extra` o dejar el comentario de que es para
el corte 2.

**P3-5. Consultas extra por reporte.**
`reportInTx` pasa de 0 a 3 lecturas más por llamada (el padre en `lockOrder`, la reserva y la reserva
de producto), repetidas por fila en un commit de borradores de hasta N filas. No encontré un test de
presupuesto de consultas sobre ese camino, pero AGENTS.md exige «medir antes de afirmar»: el handoff
debería traer el conteo medido antes y después.

**P3-6. `.claude/settings.json`.**
Los tres `deny` nuevos (`git push origin main*`, `git push * main`, `AYR_OWNER_PUSH=1 git push*`)
cumplen D-476, pero AGENTS.md §3.1 y §3.2 siguen describiendo que el agente solo tiene prohibidos los
`deny` anteriores y que `AYR_OWNER_PUSH=1` queda «para el dueño» sin listar la regla nueva; también
`git push origin main*` bloquea, de paso, una rama llamada `main-algo`. Propuesta: una línea en
AGENTS.md §3.1 y confirmar que la regla de rama con ese prefijo es aceptable.

## Coherencia con las decisiones

- D-470, D-472, D-474, D-475: implementadas como dicen en los cuatro cruces (a, b, c, d); el pedido
  se lee sin bloqueo y se vuelve a leer bajo el de la OP, y la reserva propia se vuelve a pedir si
  cambió.
- D-471: no tiene código en este corte (comprobante y despacho siguen con SQL directo); consistente
  con «provisional».
- D-473: ver P2-2 (puerta sí, centinela no).
- Sin migraciones: correcto, el diff no toca `prisma/`.
- Regla 8 / `kardex-writers.sentinel`: sin cambios. Regla 17 / `row-locks.sentinel`: pasa; la
  puerta reutiliza `lockStateOf` en lugar de duplicar estado, bien.

## Calidad de las pruebas

- `document-locks.spec.ts`: prueba de verdad el orden por clase, la deduplicación, el `NOWAIT` por
  clase anterior, por id menor, por inventario en mano y la traducción a `LockOrderConflict`. Es el
  mejor del conjunto. No cubre la clase `quotationReservations` ni una toma con id inexistente.
- `lock-order-parent.spec.ts`: prueba el contrato (qué se pide a la puerta y en qué pasada), pero con
  `lockDocuments` simulado: no demuestra orden real contra la base.
- `lock-order.db-spec.ts`: ver P2-4.

## Resumen

| Severidad | Cantidad        |
| --------- | --------------- |
| P0        | 0               |
| P1        | 0               |
| P2        | 4 (P2-1 a P2-4) |
| P3        | 6 (P3-1 a P3-6) |

P0 y P1 no hay, así que nada bloquea el deploy por esta revisión; P2-1 y P2-2 conviene corregirlos
antes de cerrar (son texto), y P2-3 necesita decisión del dueño.
