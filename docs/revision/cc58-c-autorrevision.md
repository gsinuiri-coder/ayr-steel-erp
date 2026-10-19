# cc58-c — AUTORREVISIÓN (lista de riesgos, no aprobación)

> **Autorrevisión.** Subagente nuevo, sin leer el handoff de implementación. No vale como pase
> cruzado (AGENTS.md §2, punto 2.1): es una lista de riesgos para el autor, el segundo modelo y el
> dueño. Solo lectura; se corrieron los unitarios del corte (4 suites, 31 pruebas en verde), sin
> db-spec ni E2E.

- **Qué se revisó:** `git diff cc58-b...cc58-c` (commits `a469425a`, `002c109e` y los merges):
  `purchases/landed-cost-recost.ts`, `purchases.service.ts` (`applyLandedCost`, `cancel`,
  `reverseLandedCost`, `assertNoLiveLandedCost`), el centinela de topes, el E2E de `fase2b` y las
  pruebas nuevas. También los lectores del costo de servicio de antes (D-043) en el resto del código.
- **Ojo:** al cierre de la revisión el worktree tenía **cambios sin commitear** sobre estos mismos
  archivos (nota con el id de la compra, `hasLandedRecost`, `leftWithReversal`) y un
  `docs/revision/cc58-c-segundo-modelo.md` sin trackear. Los hallazgos se escribieron contra lo
  **commiteado**; donde el árbol de trabajo ya parece atenderlos se anota «WIP», sin darlos por
  cerrados. Hay dos riesgos nuevos que trae ese WIP (P1-4 y P2-5).

---

## P0

Ninguno.

## P1

### P1-1 — La nota como llave: re-registrar el mismo comprobante, o dos proveedores con el mismo número, restan dos veces

`apps/api/src/purchases/landed-cost-recost.ts:42-47` (`landedCostNote`), `:61-66` (`landedCostShares`).

La anulación busca lo que el servicio sumó por `notes = '<Tipo> <serie>-<número> (D-686)'`. Esa
cadena **no es única**:

- **Re-registro tras anular** (el caso más común): el flete F001-123 se recibe (+A), se anula (las
  filas de la anulación llevan la nota `Anulación: …`, así que las de +A **siguen** con la nota
  original) y se vuelve a registrar el mismo F001-123 con el monto correcto (+B). Al anular el
  segundo, `landedCostShares` suma +A+B y resta las dos: la entrada queda en −A respecto de su costo
  real, y la cascada lo lleva a despachos y márgenes. `assertNoLiveDocumentClash` lo permite
  porque compara solo contra compras **vivas**.
- **Dos proveedores** (dos transportistas) con el mismo `F001-123` y el mismo tipo sobre la misma
  compra de bobinas: la unicidad es por proveedor (`purchase-document-clash.ts:24-31`), así que
  anular uno resta los dos.

WIP: la nota ya suma `compra <id>`, lo que cierra los dos casos, **pero ver P1-2**.

### P1-2 — Cambiar la serie o el número del servicio deja el flete huérfano, sin aviso

`apps/api/src/purchases/purchases.service.ts:388-427` (`updateDocument`) y
`purchase-received-edit.service.ts:1390-1415` (`applyHeader`) permiten corregir serie y número de una
compra **recibida**. Después, `landedCostNote(service)` ya no coincide con la nota grabada:
`reverseLandedCost` (`:1001-1030`) no encuentra nada, devuelve 0 y la compra del servicio queda
anulada **con el flete todavía sumado** a las entradas, a las salidas y a la ficha de la bobina.
`assertNoLiveLandedCost` (`:1034-1055`) tampoco lo ve. Con el WIP (la nota sigue llevando serie y
número delante del id) **sigue pasando**. Recomendación: buscar por la parte estable
(`compra <id>`, p. ej. `notes: { endsWith: … }`) o por una marca que no dependa del documento.

### P1-3 — El tope del recosteo (500 filas) hace imposible recibir un flete tardío, y no hay otro camino

`purchases.service.ts:1172-1194`. Antes la recepción **nunca** se abortaba por el kardex (D-030: la
deuda con el transportista tiene que llegar a la CxP). Ahora, si el plan pasa de `RECOST_MAX_ROWS`,
se rechaza con «avísale al administrador», y no queda nada registrado que `recosteo:historico`
pueda corregir después. El conteo de `planRecost` (`inventory/inventory-recost.ts:293`) suma, por
cada ítem en cascada, **todas** las filas desde la posición recosteada hasta hoy, y vuelve a sumar si
el ítem se re-encola. Una plancha o un SKU de drywall popular, fabricado con bobinas de muchas
compras, acumula cientos de filas en pocas semanas: un flete de una compra de 5–10 bobinas que llega
20–40 días después puede pasar el tope con facilidad. El escenario no está medido. Recomendación:
medir con la foto de producción cuántas filas reproduce un flete real de hace un mes, y decidir con el
dueño si se recibe igual y queda «recosteo pendiente» (como el resto de `recostForward`) en vez de
rechazar.

### P1-4 (WIP) — Con `leftWithReversal`, la compra de bobinas se puede anular con el flete vivo

Árbol de trabajo, `landed-cost-recost.ts` (`leftWithReversal`) junto con el orden de `cancel`
(`purchases.service.ts:850-901`): `assertNoLiveLandedCost` corre **después** de que el bucle ya
revirtió los `IN` de la compra (y la reversa se lleva el costo efectivo, flete incluido). Con el WIP,
cada entrada revertida a su costo efectivo se salta (`continue`), así que el chequeo nunca encuentra
nada y la compra de bobinas se anula con el servicio todavía `RECEIVED` vinculado a una compra
anulada. Es lo contrario de lo que dice el comentario de `:897-900`. En lo commiteado el efecto es
otro (P2-4). Recomendación: hacer el chequeo **antes** del bucle de reversas.

## P2

### P2-1 — Anular la bobina (RF-21) ya no se frena por el flete y deja el servicio sin poder anularse (lo commiteado)

`apps/api/src/coils/coil-operations.service.ts:1352-1374` y `initialMovement` (`:1399-1416`)
filtran `recostOfId: null`. Antes el `ADJUST` de D-043 era un movimiento posterior y frenaba RF-21.
Ahora una bobina intacta con flete se anula (la reversa sale al costo efectivo, flete incluido) y
después `landedCostShares` (`landed-cost-recost.ts:86-94`) encuentra la entrada revertida y lanza
**siempre**: el servicio no se anula nunca, y la compra de bobinas tampoco (`assertNoLiveLandedCost`
llama a la misma función). Si después se restaura la bobina (D-375, `coil-restore.ts:351-367`), el
reingreso entra al costo **grabado** y el flete de esa bobina desaparece del inventario con el servicio
vigente. WIP: `leftWithReversal` destraba la anulación del servicio; falta decidir si RF-21 debería
frenarse, como antes.

### P2-2 — La corrección del costo de entrada (CLI `fix-coil-entry-cost`, D-669) pisa el flete (lo commiteado)

`apps/api/src/coils/coil-entry-cost.ts:80-90`: el freno «ajustes de costo propios» cuenta
`recostOfId: null`, así que no ve el flete nuevo. La corrección fija la entrada en
`peso × costo/kg × TC` (sin flete) y reescribe `totalCostPen`. Si después se anula el servicio, se
resta otra vez: la entrada queda por debajo del costo real. Además, el mensaje de RF-20
(`coil-operations.service.ts:1246-1251`) manda justo a esa corrección. WIP: `hasLandedRecost` lo
frena. Ver P2-5.

### P2-3 — «Editar compra recibida» ya no ve el flete (lo commiteado)

`purchase-received-edit.service.ts:455` detecta el landed cost por un `ADJUST` de otra compra entre
movimientos con `recostOfId: null`; el flete nuevo es un recosteo con `refId` de la **misma**
compra. Hay dos caminos:

- **Bobina intacta:** el plan sale en verde y el commit revienta en `replaceEntry`
  (`inventory.service.ts:1076-1094`) con «movimiento posterior (ADJUST PURCHASE)», un mensaje que
  no explica nada.
- **Bobina con consumo:** pasa por el ajuste proporcional (`:838-855`, `adjustCost` sobre lo que
  queda), y la ficha de la bobina se reescribe al precio del papel (`:1002-1007`), **perdiendo el
  flete** en `unitCostPerKg`/`totalCostPen`. Anular el flete después la deja por debajo del papel
  (`bumpCoilDocumentCost` con el signo negativo).

WIP: `landedCost` suma `hasLandedRecost`. Ver P2-5.

### P2-4 — Anular la compra de bobinas con el flete vivo: rechaza, pero con un mensaje equivocado (lo commiteado)

`purchases.service.ts:901` corre después de las reversas de `:858-882`. Con una bobina intacta,
`landedCostShares` ve la entrada recién revertida (dentro de la transacción) y lanza «La entrada de
la bobina X se reemplazó o se anuló después de este costo…» en lugar de «tiene un costo de flete
vivo … anúlalo primero». El rollback deja todo bien, pero el usuario no sabe qué hacer. La db-spec
nueva (`purchase-audit.db-spec.ts`, «La compra de bobinas no se anula por debajo del flete») no lo
cubre: ahí lo frena antes la venta de 400 kg (`assertNothingMovedAfter`), no este chequeo. Mismo
arreglo que P1-4: el chequeo, antes de las reversas.

### P2-5 (WIP) — `hasLandedRecost` sigue en `true` después de anular el flete

WIP, `landed-cost-recost.ts` (`hasLandedRecost`): busca `notes contains '(D-686, compra '`. Las
filas de la anulación llevan `Anulación: <la misma nota>` y también coinciden, y las del alta no
desaparecen. Una bobina cuyo flete ya se anuló queda **para siempre** bloqueada para «Editar compra
recibida» y para la corrección del costo de entrada. Recomendación: decidir por la suma neta de los
recosteos con la marca (≠ 0), o excluir la anulación.

### P2-6 — `recostForward` en línea toma los saldos de la cadena con `NOWAIT`

`inventory.service.ts:551-565`: fuera del histórico, bobinas y saldos de la cascada se piden con
`NOWAIT` y salen con 409. La recepción y la anulación del flete no tienen ningún saldo en mano, pero
recorren productos que se venden todo el día: con ventas concurrentes, el 409 va a ser frecuente.
Es la red de D-475 usada como camino. Al menos el mensaje debería invitar a reintentar.

## P3

### P3-1 — Meses pasados cambian sin aviso al usuario

Los `ADJUST` caen en la fecha de cada fila (ventas, OP, partidos). «Ventas y margen», la
rentabilidad por documento, el valorizado a fin de mes y el PEPS de un mes ya reportado cambian el
día que se recibe el flete. Lo dice el comentario («sin cierre de mes todavía») y es decisión del
dueño; conviene que el guion de UAT lo muestre con un mes anterior y que la recepción le diga al
usuario cuántas filas o documentos tocó (`rowsReplayed`, `adjusted`).

### P3-2 — Residuos de redondeo al recibir y anular

`recost-engine.ts:19` (`RECOST_MIN_DELTA` de 0,01) y `isRoundingNoise` en las filas `AVERAGE`: un
delta chico por fila puede escribirse al recibir y no al anular (o al revés), y dejar céntimos en
salidas o saldos. Con fletes chicos repartidos en muchas salidas puede sumar. Sin prueba de ida y
vuelta con prorrateo no exacto (3 bobinas, montos con tercios).

### P3-3 — `bumpCoilDocumentCost` redondea a 4 decimales en cada paso

`purchases.service.ts:1371-1413`: recibir y anular un flete en USD (`deltaPerKg / TC`) puede no
devolver la ficha exactamente a `unitCostPerKg` original. No es nuevo de cc58, pero ahora el reparto
es por los kilos **recibidos** (`entry.qty`) y no por el saldo. Si `weightKg ≠ entry.qty`, la ficha y
el kardex difieren.

### P3-4 — Reparto entre bobinas de la compra: solo las que tienen el `IN` de compra vivo

`landed-cost-recost.ts:13-36`: una bobina de la compra cuyo ingreso vivo no es `PURCHASE/refId` de
esta compra no recibe su parte y las demás la absorben. Hoy no se encontró un camino que lo produzca:
la restauración D-375 reingresa con `PURCHASE/purchaseId`, RF-20 y `replaceEntry` conservan el ref,
y el inventario inicial no tiene `purchaseId`. Queda como supuesto a fijar con una prueba.

### P3-5 — Sin prueba de los escenarios caros

No hay unitaria ni db-spec para: dos fletes sobre la misma compra (anular el segundo), flete en USD,
bobina partida o cortada (que la cascada a hijas y flejes no se reste dos veces), devolución por NC
(`RETURN` sigue a la salida recosteada), la OP cerrada con despunte (`SCRAP` → `ADJUST` de cierre),
y anular la compra de bobinas **sin** consumo con el flete vivo (P2-4/P1-4).

### P3-6 — Lectores del `ADJUST` de antes (D-043)

Revisados: `purchase-cancel.ts` (`laterMovementsWhere` excluye recosteos, bien), el detalle de compra
(`landedCostServices` sale de la relación, no del kardex), el PEPS (`kardex-peps.service.ts:110-130`
pliega los recosteos de la entrada), «Ventas y margen» y la rentabilidad (leen `recost_of_id`), y el
E2E `fase2b` (actualizado). Los fletes viejos con nota `(D-043)` siguen anulándose por el bucle de
`own` (`purchases.service.ts:858-882`), y la nota nueva no choca con la vieja. No apareció otro lector
que dependa de `refType PURCHASE / refId = servicio`. `scripts/seed-escenarios.mjs:905-912` recibe
un flete sobre H1 con un corte de por medio: hay que correrlo una vez contra una base descartable para
confirmar que el tope y `assertStripsNotAssigned` no lo frenan.

## Respuesta del autor (cc58)

- **P1-1 y P1-2:** corregidos: la llave es `compra <id>`, no la nota con serie y número.
- **P1-3 (tope de 500 filas):** aceptado como riesgo y avisado al dueño (D-650 es suyo).
- **P1-4:** corregido: `assertNoLiveLandedCost` corre antes de las reversas. Prueba de base «sin
  consumo, la compra de bobinas tampoco se anula con el flete vivo».
- **P2-1 (anular la bobina, restaurarla):** anular la bobina se lleva el flete con la reversa y el
  servicio después se anula sin restar; restaurar una bobina anulada (D-375) no recupera el flete:
  queda anotado.
- **P2-2, P2-3:** corregidos. **P2-4:** corregido con P1-4. **P2-5:** corregido: se mira el neto.
- **P2-6 (`NOWAIT` en la cascada):** es el criterio de D-475 para todo recosteo en línea; un 409 se
  reintenta. Queda anotado.
- **P3:** las pruebas que faltan (dos fletes, USD, partido, NC, OP) quedan como deuda en el handoff.
