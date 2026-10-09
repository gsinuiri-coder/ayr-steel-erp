# Autorrevisión (no es un pase cruzado)

**Entrega:** cc35, corte 3 — «Producir una OP» con el modelo M (bloque por bobina).
**Rama revisada:** `origin/cc35-c3` @ `be5c080d`, diff contra `origin/main`.
**Alcance:** `production-blocks.ts`, `use-block-drafts.ts`, `produce-blocks.tsx`,
`roofing-order-panel.tsx`, `planta-view.tsx`, `coil-picker.tsx`, `close-preview.ts`,
`schemas/production.ts`, `e2e/tests/planta-modelo-m-cc35.spec.ts`.

Esto es una lista de riesgos de un subagente que no leyó el handoff de implementación. No es una
aprobación y no vale como revisión independiente.

Unitarios corridos (2026-10-09): `production-blocks.spec.ts` 14/14 en verde;
`close-preview.spec.ts` 2/2 en verde. No corrí E2E ni servidores.

---

## P0

Ninguno confirmado. El candidato más serio (cerrar con la última bobina corta) lo dejo como P1
porque lo que hay que decidir es política.

## P1

### P1-1. Cada guardado automático deshabilita todos los campos y se pierde el foco y lo que se escribe

- `produce-blocks.tsx:374` → `busy = commit.isPending || previewClose.isPending || refreshing || releasing`.
- `roofing-order-panel.tsx:319` pasa `refreshing={refreshing || mount.isPending}`, y `refreshing`
  viene de `planta-view.tsx:191` (`roofing.isFetching || draftOrders.isFetching || inProgress.isFetching`).
- `use-block-drafts.ts:152` llama a `onSaved()` → `invalidateProduction` (`production-queries.ts`),
  que invalida `['roofing-batch']` y `['production-orders']`, o sea justo las tres consultas de
  `refreshing`.
- Todos los `select`/`Input` del bloque llevan `disabled={busy}` (`produce-blocks.tsx:793, 814, 879`).

**Escenario:** el supervisor escribe «1» en planchas, se detiene 700 ms (`SAVE_DELAY_MS`), se
guarda, se refrescan las listas y durante ese viaje todos los campos de la pantalla quedan
deshabilitados. El campo que tenía el foco lo pierde (un input deshabilitado suelta el foco) y lo
que se escriba mientras tanto no entra. Esto se repite con cada pausa. El E2E no lo ve porque
`fill()` espera a que el campo vuelva a estar habilitado.

**Arreglo:** que los guardados del borrador no disparen `refreshing`. (a) No deshabilitar los
campos del bloque por `refreshing`: solo por `commit/previewClose/releasing`. (b) Tras el
guardado, escribir en la caché la lista que devuelve el API (`setQueryData` sobre
`['roofing-batch', …]`, cambiando solo `drafts` de esa orden) en vez de `invalidateProduction`.
Un borrador no toca kardex, así que no hace falta invalidar inventario, bobinas, ventas ni la cola
(ver P2-1).

### P1-2. Después de guardar, el bloque vuelve a leer `order.drafts` viejo hasta el refetch: parpadea y puede revertir lo escrito

- `use-block-drafts.ts:146-150`: al terminar el guardado sin ediciones nuevas, se borra la edición
  local (`setEdits(... filter id !== coilId)`).
- `produce-blocks.tsx:158-171`: `contentOf` cae a `order.drafts` (los datos de la consulta), **no**
  a `latest.current`, que es lo único actualizado con la respuesta del guardado.

**Escenario A (parpadeo):** primera vez que se guarda la bobina 1 (POST). `order.drafts` todavía
no tiene esa fila: el bloque se ve vacío y el último bloque se vuelve a llenar con todo lo que
falta, hasta que llega el refetch.

**Escenario B (pérdida):** el refetch falla o tarda (red de planta). La edición local ya se borró
y la pantalla muestra lo de antes. Si el supervisor toca el bloque, `editBlock` arma `next` sobre
el contenido viejo más la tecla nueva, y el PUT siguiente pisa en el servidor lo que se había
guardado bien.

**Arreglo:** no soltar la edición hasta que `order.drafts` refleje lo guardado (comparar contra la
lista devuelta), o (mejor, junto con P1-1) actualizar la caché con la lista devuelta, de modo que
`order.drafts` ya sea la nueva en el mismo render en que se borra la edición.

### P1-3. Una edición después de «Qué va a pasar» no entra en el cierre, y la vista previa queda vieja

- `produce-blocks.tsx:563-565`: `onConfirm={() => commit.mutate(true)}`, sin `persistAll()`/`flush`.
- Mientras se ve la vista previa, los bloques siguen editables (`busy` no lo cuenta) y
  `editBlock` (`:211`) no limpia `preview`.

**Escenario:** se pulsa «Registrar y cerrar», aparece «Qué va a pasar», el supervisor corrige los
kg de una bobina y pulsa «Confirmar» antes de 700 ms. El commit cierra la orden con el borrador
**anterior**. Después vence el temporizador: `saveNow` hace PUT sobre una fila que el commit ya
borró (404) o POST sobre una orden cerrada; el bloque muestra un error y la corrección se pierde.
Aunque se espere el guardado, lo confirmado ya no es lo que mostró la vista previa.

**Arreglo:** con la vista previa abierta, deshabilitar la edición de los bloques (o hacer que
`editBlock` haga `setPreview(null)`), y que «Confirmar» haga antes `await drafts.flush(...)`.

### P1-4. El último bloque no se puede vaciar: «Registrar y cerrar» registra lo que falta aunque no se haya producido (hay que decidir política)

- `produce-blocks.tsx:184-186`: si el último bloque no tiene edición ni fila guardada, es
  `derived` y se llena con `fillFromRemaining`.
- `use-block-drafts.ts:111-114, 146-150`: si el bloque se deja vacío (se quitan todos los cortes
  con ✕), se guarda como «vacío», no queda fila, la edición se borra… y el bloque vuelve a ser
  `derived` y se llena otra vez.
- `produce-blocks.tsx:258-264`: `persistAll` guarda el bloque derivado antes del commit.
- Para coberturas ya no existe «Cerrar sin reportar más»: `roofing-order-panel.tsx` solo lo deja
  en el camino del accesorio (`:432`).
- «Qué va a pasar» (`ClosePreviewBlock`, `:946`) muestra despunte y bobinas, pero **no** las
  planchas que se van a registrar.

**Escenario:** la bobina 2 se acabó antes del plan (o no salió nada de ella) y se quiere cerrar
la OP corta. El supervisor quita los cortes del bloque 2, pero se rellenan solos. «Registrar y
cerrar» graba en el borrador y registra todas las planchas que faltaban: salida de kardex de la
bobina y entrada de producto terminado que no existe. La vista previa no lo deja ver. La única
salida es «Ajustar el plan».

**Recomendación (para decisión `D-nnn`, D-230):** que un último bloque vaciado a mano siga vacío
(marca local de «tocado» por bobina, o una fila de borrador explícita de «nada de esta bobina»), y
que «Qué va a pasar» liste las planchas por bobina que se van a registrar.

### P1-5. Corregir un bloque anterior reescribe el último aunque el supervisor lo haya escrito a mano

- `produce-blocks.tsx:225-240`: si el último bloque está guardado o tocado, cualquier edición en
  otro bloque pone en el último `rows: fillFromRemaining(remaining, others)` y conserva solo sus kg.

**Escenario:** la bobina 2 (la última) hizo 3 de las 6 planchas que faltaban y el supervisor lo
escribió así. Después corrige los kg o un largo de la bobina 1 y el bloque 2 vuelve a «6», sin
aviso, y se guarda solo. La OP registra 3 planchas de más.

**Arreglo:** recalcular el último bloque solo mientras siga `derived` o mientras lo que tiene
coincida con el relleno anterior. Si el supervisor lo escribió, no tocarlo y dejar que la franja
de cuadre muestre la diferencia. Es la misma decisión de política que P1-4.

## P2

### P2-1. Cada guardado invalida ~17 familias de consultas

`use-block-drafts.ts:152` → `invalidate` (`produce-blocks.tsx:130-132`) → `invalidateProduction`:
inventario, bobinas, ventas, cotizaciones, cola, stock, etc. Un borrador no mueve kardex. En
planta se vuelven a pedir todas las consultas montadas con cada pausa al escribir, y eso alarga
la ventana de P1-1. **Arreglo:** invalidar o actualizar solo `['roofing-batch']` (o la orden)
después de un guardado de borrador. `invalidateProduction` queda para el commit.

### P2-2. Doble envío de «Registrar» mientras corre `persistAll`

`start` (`:348-372`) es async y espera a `persistAll()` antes de `run.attempt()`. Durante ese
tiempo `commit.isPending` es falso y el botón no está `pending` (`:584`), así que un segundo clic
vuelve a correr `start`: dos `persistAll` (el último bloque derivado se manda dos veces, POST y
después PUT) y dos commits con la misma clave. El API lo absorbe con `claimIdempotencyKey`, pero
salen dos toasts y dos refetch. **Arreglo:** un `useRef` `submitting` (o un estado
`persisting`) que forme parte de `busy` y de `pending` desde el primer clic.

### P2-3. La clave de idempotencia del commit no depende del contenido (D-182)

`produce-blocks.tsx:283`: `submitKey.current(close ? 'close' : 'commit')`. La huella no incluye el
borrador, la fecha, el motivo ni las casillas. **Escenario:** el commit vuelve con 502 aunque el
API ya lo había grabado, así que la clave se conserva. El supervisor escribe un bloque nuevo, que
queda como fila nueva del borrador, y pulsa «Registrar». El API repite la respuesta del primero:
toast de éxito, pero la fila nueva sigue en el borrador sin registrar. **Arreglo:** usar como
huella los ids y el contenido de `latestDrafts()` más `operationDate`, `closeReason` y
`toleranceOverrides`.

### P2-4. «Confirmar: registrar y cerrar» queda muerto si falla el commit

`ClosePreviewBlock` (`:959, 1007-1009`): `fired.current = true` no se repone nunca, y `onError`
(`:288-302`) no limpia `preview`. Si el commit da un 5xx o un 409, la vista previa sigue en
pantalla, vieja, y el botón no responde. Hay que pulsar «Volver» y empezar de nuevo. **Arreglo:**
`setPreview(null)` en `onError` del commit, o reponer `fired` cuando `pending` pasa a falso.

### P2-5. Errores de guardado con «Fila N» en el bloque equivocado, y errores de commit sin prueba E2E

- Al guardar, el API antepone «Fila N:» cuando la que falla es **otra** fila
  (`roofing-drafts.service.ts`, `validate`). `saveNow` (`use-block-drafts.ts:155-158`) lo pone
  tal cual en el bloque que se estaba guardando: el supervisor ve «Fila 1: …» en la bobina 2, y
  en pantalla no hay filas numeradas. Habría que pasar también este mensaje por
  `coilOfRowError`/`withoutRowPrefix`.
- El E2E «un error del registro se muestra en el bloque de su bobina»
  (`planta-modelo-m-cc35.spec.ts:188-209`) en realidad prueba el **guardado** del último bloque
  derivado en `persistAll`: el `order.remainingPieces` de la pantalla está viejo y el POST choca
  con el tope del plan. No llega al commit, así que el camino «Fila N» del commit →
  `coilOfRowError` → bloque no tiene prueba E2E (solo unitaria con un mensaje armado a mano).

### P2-6. El orden de los guardados en `flush` no sigue la regla de «primero lo que baja»

`editMeters` (comentario «para decidir el orden de los guardados») solo se usa dentro de
`editBlock` (`:233`). `flush` (`use-block-drafts.ts:213-226`) guarda en el orden de los bloques.
Si el supervisor baja el último bloque a mano y sube uno anterior, y los dos esperan su
temporizador, `flush` manda primero el que sube. El tope del plan (D-146), que se mide sobre todo
el borrador, lo rechaza: «Registrar» falla en silencio (`start` vuelve sin toast, `:370`) y hay
que pulsar otra vez. **Arreglo:** en `flush`, mandar primero los bloques cuyos metros bajan
respecto de lo guardado, y avisar con un toast y un desplazamiento al bloque si `persistAll`
falla.

### P2-7. Motivo y retro-fecha: el motivo se borra y se vuelve a pedir

`onError` (`:296`) pone `reason.current = null` ante cualquier error que no sea el de motivo,
incluido `BACKDATE_OUT_OF_ORDER`. **Escenario:** el cierre pide motivo, el supervisor lo escribe,
el reintento choca con la retro-fecha, el motivo se borra, confirma la fecha y el API le pide el
motivo **otra vez**. Además, la retro-fecha aparece como toast de error y como alerta en el bloque
al mismo tiempo que su diálogo (el panel viejo ya mostraba el toast, pero la alerta en el bloque
es nueva). **Arreglo:** si `err.code === BACKDATE_OUT_OF_ORDER`, salir de `onError` sin tocar
`reason` ni `commitError`.

## P3

- **P3-1.** Lo escrito en los últimos 700 ms se pierde si se recarga o se cierra la pestaña: no
  hay `beforeunload` ni guardado en `pagehide`. El limpiador del desmontaje
  (`use-block-drafts.ts:229-238`) solo cubre el cambio de orden, no la recarga.
- **P3-2.** En el camino «el último baja», cada tecla en un bloque anterior hace un PUT inmediato
  del último (`produce-blocks.tsx:234-235`), sin espera. Son muchas escrituras, y con P1-1 cada
  una deshabilita la pantalla.
- **P3-3.** `persistAll` (`:259-264`) llama a `edit(..., immediate)` y después a
  `flush([last])`: el último bloque derivado se manda dos veces (POST y luego PUT idéntico).
- **P3-4.** Si los otros bloques cubren todo y el último tiene kg escritos, `lastNext` queda con
  kg y sin cortes. `blockPayload` responde «Escribe los cortes de esta bobina antes de sus
  kilos» en un bloque que el supervisor no tocó.
- **P3-5.** Al escribir en un bloque, `editBlock` lo marca `expanded: true` y queda así: un
  bloque terminado que se tocó ya no se pliega solo durante la sesión (solo con «Plegar»).
- **P3-6.** Accesibilidad: hay un botón «Plegar» por bloque y todos se llaman igual
  (`:751`). Conviene `aria-label="Plegar la bobina <código>"`, que empieza con el texto visible.
  El resto cumple label-in-name: «Abrir ▸» → «Abrir la bobina …», «+ Otro largo» → «Otro largo
  en …», «Registrar producción» → «Registrar producción de …», y el campo de kg tiene `label` y
  `aria-label` que empiezan con «kg consumidos».
- **P3-7.** En catálogo solo se muestra `rows[0]` (`:781`). Un borrador viejo con dos filas de
  la misma bobina se ve como una y se cuenta como varias.
- **P3-8.** «Teórico del plan» (`:387-388`) usa las cifras de la primera bobina. Con bobinas de
  espesor distinto dentro de la tolerancia, es una aproximación, y no lo dice.
- **P3-9.** El commit ejecuta las filas en el orden de `seq` (creación), no en el de montaje. Con
  el camino «el último baja», la fila del último bloque puede ser la más vieja. No vi que rompa
  algo, pero los «Fila N» y el orden de los partes no siguen el orden de la pantalla.
- **P3-10.** La carrera entre `useEffect(latest = order.drafts)` (`use-block-drafts.ts:90-92`) y
  un refetch que trae datos anteriores al último guardado puede dejar `latest` sin la fila
  recién creada. El guardado siguiente haría POST en vez de PUT (fila duplicada que el siguiente
  guardado borra). Es poco probable porque `invalidateQueries` cancela el refetch en vuelo, pero
  con P1-2 resuelto vía `setQueryData` desaparece.

## Vista previa con `scrapKg` (API)

`close-preview.ts`: toma las salidas `SCRAP` (`OUT`, `refId = orderId`, bobinas de la orden)
antes de la acción y suma por bobina las que aparecen después (`id notIn`). Es correcto frente a
un cierre anterior reabierto: la salida vieja ya estaba y la reversa es `IN`, que no entra en el
filtro. Coincide con lo que escribe el cierre (`roofing-production.service.ts:2300-2307`,
`refType: 'SCRAP'`, `refId: orderId`). Hay índice `@@index([refType, refId])`, así que son dos
consultas chicas más dentro de la transacción que se deshace, sin problema de rendimiento. El
campo es opcional en el schema para convivir con un API viejo durante el despliegue. Sin
hallazgos. Riesgo menor: el unitario simula `findMany` con un fake que distingue las dos
llamadas por la presencia de `where.id`, así que no prueba el filtro real por `type`/`refType`.

## Lo que los tests prueban y lo que no

- **Prueban:** el relleno del último bloque, las cifras del bloque, el cuadre, el mapeo «Fila N»
  (unitarios); el relleno, el refresco y el guardado, «Qué va a pasar» con el despunte por bobina
  y el cierre, el error de guardado en el bloque derivado y la casilla del 1 % con su `draftId`
  después del guardado (E2E).
- **No prueban:** `useBlockDrafts` (no hay unitario de la cola, las versiones, el desmontaje ni
  la clave por huella); el camino «el último baja» de `editBlock`; el error «Fila N» del
  **commit** en su bloque (P2-5); el motivo por encima del 10 % al cerrar; la retro-fecha;
  editar después de la vista previa (P1-3); escribir durante un refetch (P1-1); y que el último
  bloque no se pueda vaciar (P1-4).

## Qué se hizo con los hallazgos (autor, cc35)

- **P1 los campos se apagaban con cada guardado**: guardar un bloque ya no vuelve a pedir la lista de órdenes; la pantalla toma en su caché el borrador que devuelve el API (`setQueriesData`). Los campos se apagan solo mientras se registra o con «Qué va a pasar» a la vista; `refreshing` apaga solo los botones.
- **P1 el bloque leía el borrador viejo tras guardar**: con la caché escrita antes de soltar la edición, el bloque pasa directo al borrador nuevo.
- **P1 «Confirmar» muerto tras un error**: sin la bandera `fired`; el doble clic lo frena `pending`. Un error del registro cierra «Qué va a pasar».
- **P1 editar con «Qué va a pasar» abierto**: los campos quedan apagados mientras el resumen está a la vista; para cambiar algo se vuelve con «Volver».
- **P1 el último bloque no se podía vaciar**: vaciarlo a mano lo deja vacío (no se vuelve a llenar hasta que se escriba en él). Tras recargar, sin fila en el borrador, vuelve a llenarse (D-548).
- **P1 E2E viejos**: reescritos para el modelo M `planta-espacio-produccion-ui`, `huecos-cobertura-f8s3` (dos casos de pantalla), `multi-montar-f8s3` (caso de pantalla), `planta-confirmar-cierre-cc27`, `tolerancia-reporte-d388` (caso de pantalla), `planta-cola-f8s3-ui` y `huecos-cobertura-f8s3b` (cabecera, D-558).
- **P1/P2 editar un bloque anterior rellena el último**: es la regla de la ESPEC («el último bloque se llena solo con lo que falta»); queda escrita en D-548.
- **P2 doble clic durante el guardado previo**: los botones quedan apagados mientras se guarda lo pendiente.
- **P2 clave de idempotencia**: atada a las filas que se registran (id, metros, kg) y a las casillas, no solo a «cerrar o no».
- **P2 «Fila N» al guardar**: si nombra otra fila, el error va al bloque de esa bobina.
- **P2 orden del guardado previo**: primero los bloques que bajan (el tope del plan mide todo el borrador).
- **P2 retro-fecha**: el error de fecha fuera de orden lo atiende su diálogo y no borra el motivo ni pinta el bloque.
- **Protección recuperada**: «Qué va a pasar» trae el aviso «¿Sigue en el almacén para otra OP?» de cc29 (D-469) cuando el despunte pasa el 10 % de lo montado.
- **Borrador viejo con dos filas de la misma bobina**: se suma por largo en el bloque (antes salía «largo repetido»).
- **P3**: «Plegar» con nombre por bobina. Sin cambio: `key` por índice en las filas, lo escrito en los últimos 700 ms antes de recargar, el teórico del plan con la primera bobina.
