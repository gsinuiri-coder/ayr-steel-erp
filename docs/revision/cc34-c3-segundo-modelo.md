# cc34-c3 — Revisión de segundo modelo

- Modelo: Claude Sonnet 5.5 (contexto limpio, sin haber leído el handoff de implementación).
- Commit revisado: `0cee9839` (padre `4f74343b`), «la baja ante SUNAT queda en trámite antes de llamar al PSE».
- Alcance: `invoicing.service.ts` (`voidDocument`, `createCreditNote`), `credit-note-guards.ts`, specs nuevos/ajustados, y los lectores de `VOID_PENDING` en el resto del API y el web.
- Corrida: `pnpm --filter @ayr/api exec jest src/invoicing` → 29 suites, 383 tests, todo verde. No se tocó ninguna base ni E2E.
- Esto es una revisión de un modelo, no una aprobación: la revisión que cierra es la del dueño.

## Hallazgos

### P0

Ninguno.

### P1

**P1-1. Un `ERROR` ambiguo (timeout/transporte) libera la marca y reabre la ventana que el cambio quería cerrar.**
`invoicing.service.ts:2738-2742` (`release('ERROR')`) con `nubefact.provider.ts:~204-216`.
`ERROR` mezcla dos cosas distintas: un 5xx definitivo y un `TIMEOUT`/`TRANSPORT`, donde «no sabemos qué pasó del otro lado» (el propio proveedor lo dice). Escenario: Nubefact recibe la baja, SUNAT la acepta, la respuesta se pierde a los 60 s → `release` devuelve la factura a `ACCEPTED` → en ese momento el usuario puede crear y emitir una NC sobre una factura que SUNAT ya anuló. Es justo lo que D-536 pretende evitar, en el caso más probable de falla. El mensaje dice «usa Consultar al PSE si sospechas…», pero el estado ya no avisa nada y `ACCEPTED` no bloquea NC.
Propuesta: liberar solo cuando el fallo es inequívocamente «no salió» (REJECTED 4xx con mensaje; `PROVIDER_UNAVAILABLE`/no configurado; `PSE_ENABLED=false`). Con `TIMEOUT`, `TRANSPORT` o 5xx dejar `VOID_PENDING` y mandar al usuario a «Consultar al PSE» (que ya resuelve ambos desenlaces). Al menos, decidirlo y registrarlo como D-nnn; hoy el comportamiento es el contrario al de «ante la duda, en trámite».

**P1-2. `VOID_PENDING` sin ticket queda sin salida si el proceso muere o si la transacción final falla.**
`invoicing.service.ts:2656-2700` (marca) y `2750-2782` (cierre).
Casos que dejan `VOID_PENDING` sin `providerTicket`: (a) el proceso muere (deploy, Cloud Run reciclando instancia, OOM) entre la transacción 1 y la respuesta; ahora que la ventana de deploy está suspendida (D-533) los deploys a media jornada son reales; (b) la transacción final lanza 409 por cobro tardío o NC viva tardía (líneas 2756-2781). No hay job que barra `VOID_PENDING` (`sendPending` solo recorre `RETRYABLE`), `voidDocument` exige `ACCEPTED` (línea ~2616) así que no se puede reintentar, y la única salida es «Consultar al PSE» manual. Esa consulta (`refreshStatus`, 2490) solo cierra si el PSE contesta `ACCEPTED` o `REJECTED`; si para una baja nunca enviada el PSE contesta sin veredicto (`PENDING`), la factura queda bloqueada para NC y para nueva baja indefinidamente, y sigue sumando como venta/CxC. Antes del cambio, en el caso (a) la factura quedaba `ACCEPTED` y reintentable.
Propuesta: permitir que `voidDocument` reintente cuando `status=VOID_PENDING`, `providerTicket IS NULL` y `voidRequestedAt` tiene más de N minutos (mayor al timeout del PSE), o un barrido de `VOID_PENDING` sin ticket que consulte y, si el PSE responde «no existe baja», libere. Como mínimo, test y nota en handoff de qué responde Nubefact en `consultar_anulacion` para una baja jamás enviada; si es `PENDING`, es un callejón sin salida real.

### P2

**P2-1. «Consultar al PSE» durante la propia llamada puede pisar la marca y dejar la baja comunicada y no registrada.**
`invoicing.service.ts:2490-2530` contra `2785`.
Mientras corre la llamada (hasta 60 s) la UI ya muestra «Consultar al PSE» (`comprobante-detalle-view.tsx:551`). Si otro usuario consulta y el PSE contesta `REJECTED` (p. ej. 4xx «no existe baja» porque la baja aún no se procesó), `refreshStatus` pone `ACCEPTED` y `voidRequestedAt: null`; después la llamada original vuelve `ACCEPTED`, el `updateMany` con `voidRequestedAt: requestedAt` da `count 0` y se lanza «cambió de estado mientras se daba de baja», pero SUNAT ya anuló: la factura queda `ACCEPTED` en el ERP con NC permitida. Es la misma familia que P1-1 (se recupera con una segunda consulta, la rama `ACCEPTED` de `refreshStatus`).
Propuesta: que `refreshStatus` no libere (rama `REJECTED`) una baja sin `providerTicket` y con `voidRequestedAt` reciente; o que la tx final, ante `count 0`, deje un mensaje que mande a «Consultar al PSE».

**P2-2. El cobro durante la llamada sigue permitido, y sobre `VOID_PENDING` en general.**
`receivables.service.ts:133` (`LIVE_STATUSES` incluye `VOID_PENDING`); web lo oculta (`comprobante-detalle-view.tsx:~915`), el API no.
Escenario del propio commit: un cobro registrado tras la marca hace fallar la tx final (2756) con la baja ya aceptada por el PSE → queda `VOID_PENDING` sin ticket (ver P1-2) y hay que revertir el cobro a mano. Es más fácil prevenirlo que repararlo: rechazar cobros nuevos mientras el comprobante esté `VOID_PENDING` con el mismo texto «baja en trámite» (una baja pendiente de SUNAT puede durar horas, hay tiempo de sobra para cobrar tras rechazo). Si se prefiere no tocar `receivables` en este corte, registrarlo como deuda.

**P2-3. Segunda baja concurrente da un mensaje con el enum crudo.**
`invoicing.service.ts:~2611-2615`. Quien aprieta «dar de baja» mientras otro ya la marcó recibe «Solo se da de baja un comprobante aceptado; este está VOID_PENDING». Es seguro (no hay doble llamada: la tx 1 revalida `ACCEPTED` bajo `lockDocuments` y `updateMany` filtra por estado) pero el mensaje no dice «ya tiene la baja en trámite». Mismo texto para `createCreditNote`/guards ya existe (`VOID_IN_PROGRESS`); reutilizarlo.

### P3

- **P3-1. Texto del web impreciso.** `comprobante-detalle-view.tsx:916`: «La baja está comunicada y SUNAT todavía no la confirmó» ya no es cierto para una marca previa al PSE o dejada por un fallo (P1-2). Texto sugerido: «La baja está en trámite…; si no avanza, Consultar al PSE».
- **P3-2. `release` puede enmascarar el error del PSE.** `2705-2727`: si la tx de liberación falla (BD), el 500 reemplaza el mensaje del PSE y la factura queda `VOID_PENDING`. Envolver en try/catch, loguear y relanzar el mensaje original con aviso de «Consultar al PSE».
- **P3-3. Sin auditoría de las fallas de cierre.** Cuando la tx final lanza 409 (cobro/NC tardíos o `count 0`) no queda registro de que la baja sí se comunicó (solo `void-requested`). Un `audit` fuera de la tx que falló, con el ticket, ayudaría al soporte.
- **P3-4. POS.** `pos.service.ts:410-411,496-506`: `VOID_PENDING` cuenta como «ya deshecho». Con una baja manual en vuelo, una anulación de mostrador salta el paso 2 y, si una consulta devolvió `ACCEPTED` por `release`/`refresh` (P2-1), seguiría a revertir el despacho con la factura vigente. Ventana muy angosta; solo anotarlo.
- **P3-5. Códigos HTTP asimétricos.** `createCreditNote` responde 400 y registrar/emitir 409 para la misma causa. Está en la especificación y los mensajes son claros; solo se señala.

## Verificado sin hallazgos

- **Orden de bloqueos (D-471).** Tx 1, `release` y tx final toman solo el comprobante por `lockDocuments`; no hay bloqueo sostenido durante la llamada al PSE; los demás caminos de NC (`createCreditNote`, `send`/`assignInTx` y `registerManual` vía `lockWithAffected`) bloquean el afectado antes que la nota.
- **Doble baja.** Dos bajas simultáneas: la segunda lee `VOID_PENDING` fuera de tx (rechazada) o dentro de tx 1 (`status !== ACCEPTED` → 409), y `updateMany` está condicionado al estado; no hay doble llamada al PSE.
- **NC justo antes de la marca.** Una NC viva se detecta en tx 1 (`count` de vivas) y un borrador con `draftCreditNoteBlock`, ambos bajo el bloqueo del comprobante; una NC que entra después encuentra `VOID_PENDING` en `createCreditNote` y en `assertAffectedStillCreditable` (llamado desde `send` y `registerManual`, 1252 y 1870).
- **`release` filtrado por `voidRequestedAt`.** `Timestamptz(3)` y `Date` JS tienen la misma precisión (ms), así que la igualdad exacta funciona; una liberación no pisa un estado escrito por otro camino (`refreshStatus`) ni la marca de otra baja; restaura `voidRequestedAt`/`voidedById` previos.
- **Salida PENDING/ACCEPTED.** La tx final filtra por `VOID_PENDING` + `voidRequestedAt`; `PENDING` mantiene el estado y guarda ticket; no se pierde `voidedById`.
- **Lectores de `VOID_PENDING`.** `LIVE_DOCUMENT_STATUSES` ya lo incluye (ventas, margen, CxC, despachos, importador, guards), por lo que la marca previa no cambia reportes ni saldos; `sendPending` no lo recorre (no hay reintento automático que choque); `refreshStatus` consulta con la correlación de serie/número, no con el ticket, así que sirve para una marca sin ticket.
- **Auditoría.** `void-requested` y `void-released` se escriben dentro de su transacción con `AuditService.write`; la baja final conserva `invoicing.document.void`.
- **Sin migración.** Usa columnas y estado existentes.
- **Tests.** Cubren la marca antes de la llamada, `ACCEPTED`/`PENDING`, liberación en `ERROR` y `REJECTED` (con filtro `VOID_PENDING`), rechazo de crear NC con mensaje exacto y del guard; el spec de cc33 N3 se ajustó coherentemente. Faltan: la liberación no pisa un estado ajeno (`count 0`), la tx final con cobro/NC tardíos dejando `VOID_PENDING`, `ERROR` por timeout (P1-1), y una segunda baja sobre `VOID_PENDING`.

## Qué se hizo con cada hallazgo

| Hallazgo                         | Resolución                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 liberar en TIMEOUT/5xx      | Sin cambio: es la regla del dueño («si la llamada falla, la marca se quita») y lo que pasaba antes; el mensaje avisa que la baja pudo llegar y «Consultar al PSE» la reconcilia. Riesgo aceptado en D-542. |
| P1-2 `VOID_PENDING` sin salida   | Corregido: marca huérfana detectada por la auditoría de bajas; reintento permitido pasados 5 min. Tests y mutación.                                                                                        |
| P2-1 consulta durante la llamada | Corregido: «Consultar al PSE» no consulta mientras la baja se está comunicando.                                                                                                                            |
| P2-2 cobros sobre `VOID_PENDING` | Sin cambio de regla (no decidida en el brief); el conflicto conserva ticket y respuesta y la baja queda en trámite. Para el dueño en D-542.                                                                |
| P2-3 enum crudo                  | Corregido.                                                                                                                                                                                                 |
| P3                               | Auditoría de conflictos agregada (`void-conflict`); `release` ya no enmascara el estado; aviso del web sin cambio (pieza de API); códigos 400/409 sin cambio.                                              |
