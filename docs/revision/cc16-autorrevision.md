# cc16 — Autorrevisión de D-381 «Traer comprobante anulado»

> **Autorrevisión.** La hizo un subagente nuevo, que no escribió este código ni leyó los handoffs
> de la sesión. **No vale como pase cruzado**: es una lista de riesgos, no una aprobación
> (AGENTS.md §2.2).

- **Alcance:** `git diff origin/main...HEAD` de `cc16/traer-comprobante` (3 commits: `14de3ee`
  API, `1e60620` web, `cbc9c09` E2E), contrastado con el diseño
  `origin/diag/comprobante-a-otro-pedido:docs/analisis/comprobante-a-otro-pedido-2026-10-03.md`.
- **Corridas (medidas):**
  - `pnpm --filter @ayr/api exec jest src/invoicing`: 23 suites, 334 tests, todo verde.
  - `typecheck` de `@ayr/api` y `@ayr/web`: limpio.
  - `eslint` sobre los archivos tocados del API y de la web: limpio.
- **No se corrió:** el E2E, ni se levantaron servidores. Los selectores se verificaron leyendo el
  DOM del diálogo.

## Resultado

| Severidad | Cantidad |
| --------- | -------- |
| P0        | 0        |
| P1        | 0        |
| P2        | 2        |
| P3        | 7        |

No encontré un defecto que deje datos incorrectos. Lo verifiqué así:

- **Emparejado y plan.** Cada fila termina apuntando a una línea del destino: el `update` escribe
  `salesOrderItemId` y el bloqueo por `unpaired` impide filas huérfanas.
- **Kardex y reservas.** El servicio no los toca.
- **Locks.** El orden comprobante → pedidos ordenados por id → borradores es consistente. El borrador
  nuevo (`invoicing.service.ts:497`) y las ediciones (`lockEditable`) bloquean el pedido destino,
  así que quedan serializados.
- **D-378.** Solo cambia de forma aditiva (P3-6).

## P2

### P2-1. El presupuesto de consultas del listado no está verificado por test

**Dónde:**

- `apps/api/src/invoicing/move-to-order.service.ts:87-89`: el comentario dice «Presupuesto
  (llamadas a Prisma, verificado por test)».
- `apps/api/src/invoicing/move-to-order.service.spec.ts:654-735`: el bloque «candidatos» solo
  comprueba el `where`, el `take` y la ausencia de `FOR UPDATE`. Ningún test cuenta llamadas.

**Por qué importa.** AGENTS.md §3.4 y §6, y el diseño §3.6, exigen un presupuesto de consultas
verificado por test.

**Costo real, contado en el código.** Por candidato que pasa todo:

- 4 consultas en `lockAnnulledForReactivation`;
- 10 en `plan`: `count` de notas de crédito, pedidos, 2 de despachos, 2 de líneas, otros vivos,
  borradores, cliente y vendedores.

Son unas **14 consultas secuenciales por candidato**. Con 2 consultas fijas y 20 candidatos,
llegan a **~282 viajes** a Neon desde Cloud Run en un solo `GET`.

**Escenario.** Un cliente frecuente con 20 manuales anulados de pedidos anulados. El diálogo
tarda varios segundos en abrir, y ningún test avisaría si alguien agrega una consulta por
candidato.

**Qué falta.**

- Un test que cuente las llamadas al mock para 1 y para N candidatos y fije la fórmula.
- Corregir el comentario para que no afirme algo que no existe.

### P2-2. Faltan dos piezas de la web que el diseño §3.6 pide

**El aviso del comprobante no existe.** El diseño pide que el detalle del comprobante anulado
(`comprobante-detalle-view.tsx`), cuando su pedido está anulado, muestre «Su pedido está anulado:
para llevarlo a otro pedido, abre el pedido correcto y usa “Traer comprobante anulado”». No está
implementado: `grep "Traer comprobante"` en `apps/web/src` solo encuentra el pedido.

- **Escenario:** el administrador abre `FFA1-00001389`. Ve las dos reactivaciones deshabilitadas
  con el motivo «El pedido PED-000044 está anulado: no se reactiva…», y nada le dice que el camino
  existe ni desde dónde se lanza. Es justo el caso de uso de D-381.

**El botón del pedido no se deshabilita con motivo.** El diseño pide que se deshabilite si el
pedido tiene un comprobante vivo o un borrador, con un motivo que diga cuál eliminar. Hoy
`pedido-detalle-view.tsx:446-455` lo muestra con `show: isAdmin && canOperate` y `disabled: busy`.

- El administrador lo descubre recién al abrir el diálogo, en el motivo de cada candidato, después
  de pagar el listado completo (P2-1).
- Es funcional, pero se aparta del diseño acordado.

Si es un recorte deliberado, conviene registrarlo en la decisión o en el handoff.

## P3

### P3-1. El tercer pase del emparejado toma la primera línea libre, sin mirar cantidad ni importe

**Dónde:** `apps/api/src/invoicing/move-to-order-lines.ts:52`, con `pass(() => true)`.

**Escenario.**

- El destino tiene una línea nueva al principio (L1 `UPVC`) y, además, cambió el producto de una
  fila: P en el comprobante, Q en L5 del destino.
- Después de los pases 1 y 2 quedan libres L1 y L5. La fila P se empareja con **L1** (UPVC), no
  con L5 (Q, que tiene la misma cantidad e importe), y Q entra como fila nueva al final.
- El total coincide, así que el control del papel pasa.
- Pero la fila N del comprobante pasa a describir UPVC cuando en el papel esa fila era P o Q, y la
  numeración del ERP diverge del papel más de lo necesario.

**Impacto.** Las cifras por producto siguen bien, porque cada línea del destino aparece una vez.
El modal muestra «Cambia de producto».

**Mejora posible.** En el pase 3, preferir la línea libre con la misma cantidad y el mismo
importe antes de caer a la primera.

**Nota.** El diseño decía «mismo precio unitario» para el pase 1 y el código usa el total de
línea. Es equivalente o mejor, y está documentado en el código.

### P3-2. Al terminar se refrescan dos consultas que el diálogo ya no necesita

**Dónde:** `apps/web/src/components/invoicing/move-to-order-dialog.tsx:108-119`.

**Qué pasa.**

- `onSuccess` llama a `onOpenChange(false)`, que es un cambio de estado asíncrono, y en el mismo
  turno a `invalidateInvoicing(...)`.
- En ese instante los dos `useQuery` del diálogo siguen con `enabled: true`. La invalidación por
  prefijo `['fiscal-document']` y `['sales-order', order.id]` los refetchea activos:
  - un `GET …/move-to-order/:target/preview` sobre el comprobante ya `ACCEPTED`, que responde 409
    «ya está vigente»;
  - el listado de candidatos completo (P2-1).

**Impacto.** No se ve, porque el diálogo se cierra y hay `router.push`. Son tráfico y un 409 de
ruido en los logs.

**Arreglo posible:**

- llamar a `queryClient.removeQueries` sobre las dos claves del diálogo antes de invalidar; o
- invalidar con `refetchType` acotado; o
- condicionar `enabled` a `!move.isSuccess`.

### P3-3. El toast promete algo que no siempre es cierto

**Dónde:** `move-to-order-dialog.tsx:110`. El texto es «Las líneas quedan pendientes de despacho».

**Escenario.** Un destino `PARTIALLY_FULFILLED` o `FULFILLED`. El diseño §3.3 lo permite, y sus
líneas despachadas conservan su despacho, así que el mensaje es falso para esas líneas.

**Arreglo posible.** Decir «Lo no despachado del pedido queda pendiente de despacho».

### P3-4. Hereda de D-378 el paso libre del tope de D-077

**Dónde:** `move-to-order.service.ts:527-536`.

**Qué pasa.** Si la boleta de origen ya superaba el tope por un override, `!before.gt(cap)` deja
pasar un total mayor en el destino sin un override nuevo. El override se dio para otra venta (el
pedido de origen).

**Escenario.** Es un caso borde: hoy no hay boletas genéricas de manual sobre pedidos anulados.
Conviene que el dueño lo sepa, o bloquear en D-381 cualquier boleta genérica sobre el tope.

### P3-5. Los motivos de los candidatos deshabilitados no se asocian al radio

**Dónde:** `move-to-order-dialog.tsx:168-189`.

**Qué pasa.** El motivo aparece dentro del `<label>`, así que forma parte del nombre accesible del
radio. Eso funciona: un lector de pantalla lo lee completo. Pero:

- no hay `aria-describedby`;
- la lista no es un `radiogroup` ni un `fieldset` con leyenda: es un `section` con `aria-label`.

**Impacto.** Menor, porque el perfil de uso es escritorio y administrador.

### P3-6. D-378 cambió de forma aditiva, no de comportamiento

Revisé tres cambios sobre D-378:

- **`planOrderLines`** marca ahora `productChanged: true` también en D-378
  (`reactivate-order-lines.ts:216`). En consecuencia:
  - el DTO de la vista previa de D-378 puede traer el campo;
  - la auditoría `invoicing.document.reactivate-with-order-lines` lo guarda dentro de
    `after.lines`;
  - el modal de D-378 muestra la insignia «Cambia de producto».
- **La escritura de D-378** incluye `salesOrderItemId` con el mismo valor de antes
  (`fiscal-import.service.ts:513`).
- **El número de línea del «antes»** sale del mismo mapa que antes (`beforeLineNumber` ← `orderLines`
  cuando no hay `move`).

El test `fiscal-import-reactivate-lines.spec.ts` se ajustó solo para esperar `salesOrderItemId`.

**Conclusión.** No hay regresión. Solo conviene mencionarlo en el handoff, porque la UI y la
auditoría de D-378 cambian.

### P3-7. Detalles menores

- **Despachos enlazados.** `move-to-order.service.ts:417` bloquea por cualquier despacho con
  `invoiceId` hacia el comprobante, revertido o no. Coincide con el diseño, pero el mensaje no
  distingue los revertidos de los vigentes. Para el usuario, «tiene despachos enlazados
  (DES-…)» sobre un despacho revertido no dice qué hacer.
- **Anulados obsoletos al reabrir.** El listado se queda en caché mientras el diálogo está montado
  y cerrado: el observer existe, así que `gcTime: 0` no lo descarta. Al reabrir, la
  autoselección (`:79-83`) puede elegir sobre datos viejos antes del refetch. La vista previa y la
  ejecución vuelven a comprobar todo, así que no hay riesgo de datos.
- **Sin control de límite de crédito.** El destino suele tener un total mayor, y el saldo por
  cobrar sube sin pasar por ese control. D-378 hace lo mismo. Lo anoto como herencia, sin
  verificar si el registro manual lo aplica.

## Selectores del E2E contra el DOM (`e2e/tests/traer-comprobante-d381.spec.ts`)

Todos calzan con el DOM:

| Línea | Selector                                                                  | DOM                                                                                                                                                                                                                   | ¿Calza?                                                                             |
| ----- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 191   | `headerAction(page, 'Traer comprobante anulado')`                         | Ítem `move-document` de las acciones de cabecera (`pedido-detalle-view.tsx:446`), dentro de `[data-slot="header-actions"]` (`header-actions.tsx:87`). Botón visible o `menuitem` de «Más acciones», con nombre exacto | Sí                                                                                  |
| 194   | `getByTestId('movable-<número>')` contiene el código del pedido de origen | `<label data-testid="movable-${c.number}">`, con el texto «… · pedido PED-…»                                                                                                                                          | Sí                                                                                  |
| 195   | `move-orders` tiene el texto `X → Y`                                      | `<dd data-testid="move-orders">{source} → {target}</dd>`                                                                                                                                                              | Sí                                                                                  |
| 196   | `move-warnings` contiene «D-374»                                          | El segundo aviso del servicio termina en «se sigue D-374 (…)»                                                                                                                                                         | Sí                                                                                  |
| 197   | `getByRole('region', { name: 'Después' })` contiene «Agregada»            | `Side` renderiza `<section aria-label="Después">` (rol `region`). La línea 2 del destino es `added`                                                                                                                   | Sí                                                                                  |
| 198   | `after-total` contiene `paperTotal`                                       | `data-testid="after-total"` con `formatMoney` → «S/ 708.00» (sin separador de miles por debajo de 1000)                                                                                                               | Sí                                                                                  |
| 200   | `getByRole('button', { name: 'Traer comprobante' })`                      | Botón del pie «Traer comprobante». El nombre no es exacto, pero ningún otro botón del diálogo lo contiene                                                                                                             | Sí                                                                                  |
| 201   | `getByLabel('Motivo')`                                                    | `<Label htmlFor="move-reason">Motivo</Label>`. Ninguna otra etiqueta contiene «motivo»                                                                                                                                | Sí                                                                                  |
| 202   | `getByLabel(/en este pedido, coincide con el papel vigente/).check()`     | `Label htmlFor="move-confirm"` → `Checkbox` de Radix (`button role=checkbox`, que es un elemento etiquetable). JSX une el salto de línea con un espacio                                                               | Sí                                                                                  |
| 206   | `getByLabel('Total del papel vigente (S/)')`                              | `Label htmlFor="move-total"`                                                                                                                                                                                          | Sí                                                                                  |
| 207   | `paper-total-mismatch` contiene `papel S/ <viejo>`                        | «No coincide: papel {formatMoney(typed)} …», y `formatMoney` usa un espacio normal                                                                                                                                    | Sí                                                                                  |
| 194   | Autoselección del candidato                                               | Pide un candidato disponible **y** uno solo en total. El cliente del test es nuevo                                                                                                                                    | Sí. Si el helper reutilizara clientes, el test esperaría una selección que no llega |

El flujo de API del spec también calza con el servicio:

- **Borrador del destino.** El 409 del preview llega por el conteo de borradores, porque el
  borrador no está en `SHARED_LIVE` y el chequeo de vivos no lo detiene antes. El texto esperado,
  «borrador(es) de comprobante: elimínalo(s) primero», coincide con
  `move-to-order.service.ts:507`.
- **Otro cliente.** Responde 409 con «es de otro cliente».
- **Total distinto.** Responde 400 con «no coincide con el de estas líneas (S/ …)».
- **Endpoints usados.** `DELETE documents/:id` con su motivo, `dispatches/at-issue-date/:id` (GET y
  POST con `{}`, `dispatchDate` opcional) y `reports/documents/:id/profitability` existen.

## Lo verificado sin hallazgo

- **Cada fila apunta al destino.** `plan.updates[].salesOrderItemId` es siempre la línea emparejada
  del destino (`reactivate-order-lines.ts:206`), y la escritura lo graba
  (`move-to-order.service.ts:229`). Las filas nuevas llevan su línea del destino. Ninguna fila
  queda sin pareja: el bloqueo `unpaired` está en `:511-516`.
- **El «antes».** Usa el `salesOrderItemId` y el número de línea del pedido de **origen**
  (`sourceOrderLines`), y la auditoría guarda `before.rows[].salesOrderItemId` de origen.
- **Bloqueos del diseño §3.3, todos presentes:**
  - solo manual, FACTURA o BOLETA;
  - estado, archivado, rastro de PSE, cobros y notas de crédito vivas o posteriores
    (`lockAnnulledForReactivation`);
  - cualquier nota de crédito;
  - con detracción;
  - sin pedido o con líneas sin `sales_order_item_id`;
  - el origen no está anulado;
  - el destino es el mismo pedido;
  - el destino está anulado;
  - otro cliente;
  - despachos enlazados;
  - despachos vigentes del origen;
  - otro comprobante vivo o un borrador en el destino;
  - el tope de D-077;
  - menos líneas en el destino.
- **La transición.** Va condicionada a `status = ANNULLED` **y** `sales_order_id = origen`
  (`:206-221`). Un reintento ve `ACCEPTED` y responde 409.
- **Locks.**
  - El orden es comprobante → los dos pedidos `ORDER BY id FOR UPDATE` → borradores del destino.
  - Dos traídas cruzadas al mismo destino no forman ciclo, y la segunda ve el vivo y bloquea.
  - Crear un borrador en el destino toma el lock del pedido (`invoicing.service.ts:497`), igual que
    las ediciones (`lockEditable`).
  - Anular el pedido destino también toma su lock.
- **Sin efectos de inventario.** No hay escrituras de kardex, reservas, cobros ni despachos.
- **Fechas.** `issue_date` es `DATE` y `dayLabel` usa la parte UTC, así que no hay corrimiento de
  día.
- **El listado.** No toma locks (lo verifica el test). El filtro de pedido anulado va antes del
  `take`, y solo es para administrador (`@Roles` + `assertCanReactivate`).
- **Caché de la web.** Se invalidan `['fiscal-document']`, `['fiscal-documents']` —que incluye la
  tarjeta de anulados de los dos pedidos—, `['order-progress']`, `['receivables']`,
  `['sales-order', destino]` y `['sales-order', origen]`.
