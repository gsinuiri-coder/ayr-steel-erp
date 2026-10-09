# Revisión de segundo modelo (Sonnet) — cc35 corte 4

Alcance: diff `origin/cc35-c3...origin/cc35-c4` (produce-accessory.tsx, accessory-blocks.ts y su spec, roofing-order-panel.tsx, planta-view.tsx, dos specs E2E, D-559). Solo lectura; no se corrió nada. Las rutas de archivo son de `apps/web/src/app/(app)/planta/` salvo que se indique otra.

## P0

Ninguno.

## P1

### P1-1. La clave de idempotencia nunca se suelta: un segundo parte idéntico de la misma bobina se pierde en silencio

`produce-accessory.tsx:141-149` (keyFor) y `:169-202` (sendReports).

`keys` es un `Map` de huella de cuerpo a clave que no se vacía tras un envío exitoso. El patrón existente (`use-block-drafts.tsx`, `onSent: keys.current.delete`) sí la suelta. El cuerpo del parte es `{coilId, meters, piecesCount?, consumedKg?, operationDate, ...}`.

Escenario: en la misma sesión de pantalla, el supervisor registra 5 m en la bobina A (clave K1) y los 5 m se descuentan. Más tarde, en el mismo montaje del panel, vuelve a escribir 5 m en la bobina A. La huella es idéntica y reutiliza K1. El API (`claimIdempotencyKey`, `roofing-production.service.ts:992`) responde `claimed:false` y no escribe nada. El front muestra «producción registrada» y limpia el bloque, pero no entró kardex ni avance. Es un parte perdido sin aviso, justo el caso de dos turnos de 5 m en una bobina. Aplica igual al último bloque con `report-and-close`.

Arreglo: borrar la clave de la huella al terminar bien cada POST (el `sent.push` y el éxito de `close`), igual que `onSent`. Agregar un spec que registre dos veces los mismos metros en la misma bobina sin recargar y compruebe dos partes.

## P2

### P2-1. Un refresco después de una respuesta perdida duplica el parte

`produce-accessory.tsx:117` y `:55-73`.

Lo escrito sobrevive al refresco (localStorage) pero las claves viven en un `useRef`. Si el POST llegó al servidor y la respuesta se perdió (corte de red), el bloque sigue en localStorage. Tras recargar, «Registrar» manda el mismo contenido con una clave nueva y el servidor lo acepta como parte nuevo. El tope de metros del pedido (D-146) lo frena solo cuando el total excede lo que falta. Arreglo: guardar la clave junto a la edición en localStorage (campo `key` en `AccessoryEdit`, regenerada si cambia el contenido) y soltarla al confirmar el envío.

### P2-2. No se valida antes de enviar que los metros escritos quepan en lo que falta, y el envío no es todo o nada

`produce-accessory.tsx:292-302`. `blocking` mira solo errores de formato por bloque. Si la suma escrita supera `remainingMeters`, los bloques anteriores se registran y el que pasa el tope sale rechazado después. La banda «cuadre» (`:512-536`) muestra el sobrante pero no bloquea ni avisa. D-559 acepta que no es todo o nada, pero el exceso se puede detectar en el cliente antes del primer POST. Arreglo: aviso o bloqueo previo cuando `typedTotal > remainingMeters` (con la misma tolerancia que aplique el API), sin esperar al rechazo.

### P2-3. Cobertura de pruebas menor a lo pedido

- `accessory-blocks.spec.ts` solo prueba la parte pura. No hay prueba del componente: relleno del último bloque tras registrar los anteriores y releer, borrado de lo registrado, ni «último vacío».
- `planta-modelo-m-cc35.spec.ts` cubre un solo camino: dos bobinas, recarga, «Registrar y cerrar». No cubre «Registrar producción» (serie de partes sin cierre), fallo a mitad de serie (el primero queda, el segundo con error), cierre con el último bloque vacío (`/close` suelto), retro-fecha con confirmación, el motivo de despunte alto, ni repetir metros iguales (P1-1).
- `tolerancia-accesorio-d389.spec.ts` perdió la aserción de que otros kilos hacen desaparecer el aviso y volver a lo rechazado lo trae de nuevo; esa regla sigue en el código y ya no se prueba.

## P3 (notas)

1. `:129-133`. El último bloque se llena solo y «Registrar producción» sin tocar nada manda todo lo que falta a la última bobina. Parece lo pedido; conviene que el texto de ayuda lo diga. Además, al escribir piezas o kg en el último bloque se congela el relleno (`setEdit` copia `b.edit`) y deja de seguir a los otros bloques.
2. `:57-64`. `JSON.parse` de localStorage no valida la forma: un valor viejo o corrupto sin `meters` rompe `b.edit.meters.trim()`. Validar con Zod o descartar si no es `{meters,pieces,consumedKg}` de texto. Tampoco hay limpieza de órdenes cerradas por otra vía, y la clave no incluye al usuario (equipo compartido).
3. `:181-190`. Si un `BACKDATE_OUT_OF_ORDER` aparece en un bloque posterior al primero, sale como error de bloque y no abre el diálogo de confirmación; se resuelve al reintentar. Y en el cierre, el fallo de la vista previa pasa por `onCloseError` y además abre el diálogo de retro-fecha: doble aviso (toast más diálogo) y limpia `reason`.
4. `:317-321`. El «Teórico» de la banda usa la geometría de la primera bobina para todo el pedido, y «Bobinas usadas» cuenta montadas. Con bobinas de ancho distinto el teórico no coincide con la suma de los bloques.
5. Se perdió el cierre suelto con `consumedKg` total de la corrida (D-089, campo «closeKg» del panel anterior). Ahora el cierre sin último bloque no puede declarar kilos. Es coherente con ESPEC (kg por bloque), pero confirmar que se acepta.
6. «Registrar y cerrar» sin nada registrado ni escrito llega al API y falla con un mensaje; antes `canCloseOnly` lo deshabilitaba. Menor.
7. Accesibilidad: los campos de metros y piezas se nombran solo con `aria-label` (sin `<label>` visible), el cuadre `role="status"` se re-anuncia en cada tecla, y los errores por bloque usan `role="alert"` simultáneo en varios bloques. Aceptable para un escritorio de uso interno; no bloquea.

## Verificado sin hallazgo

- Relleno del último bloque tras registrar los anteriores: el valor es consistente con el cierre porque `remaining` baja lo mismo que se resta de «otros»; el cierre usa el cuerpo calculado en la vista previa (`pendingClose`), como pide D-453.
- Relectura: `refetchQueries(['roofing-batch'])` antes de soltar lo enviado evita el re-relleno con lo viejo; `busy` incluye `refreshing`.
- Cierre con el último vacío usa `/close` suelto con su vista previa; retro-fecha y `operationDate` viajan en cada parte; el motivo de despunte se pide ante el rechazo y viaja como `closeReason` o `reason` según la ruta.
- Panel y planta: se eliminaron `OrderDraft`/`EMPTY_DRAFT`/`onDraft` sin referencias colgantes en `planta-view.tsx`; `stateOf` ya no marca «Sin plan» a un accesorio.

## Qué se hizo con los hallazgos (autor, cc35)

- **P1 la clave de idempotencia se reusaba** (un segundo parte idéntico se perdía): la clave vive ahora **con lo escrito del bloque** (en el navegador, D-559); se genera al mandar y se descarta al cambiar el contenido o al registrarse. Un reintento tras recargar reusa la misma; un parte nuevo con las mismas cifras lleva otra.
- **P1 partes duplicados tras un F5 o un cambio de orden a mitad de la serie**: cada bloque queda marcado como registrado en el almacenamiento apenas su parte responde, y no se vuelve a mandar; al cargar, los marcados se descartan (la orden releída ya los trae).
- **P2 «Bajar» en el último bloque lleno solo**: vuelve a estar mientras la bobina no roló.
- **P2 avisos del agregado**: se muestran los del último parte registrado.
- **P2 «Registrar producción» manda también el último bloque lleno solo**: es la regla de la ESPEC («el último se llena solo con lo que falta») y la pantalla lo muestra antes de registrar; igual en coberturas. Queda escrito en D-559.
- **P2 «Registrar y cerrar» graba los bloques anteriores antes de la vista previa**: es la consecuencia de D-559 (sin borrador del servidor para metros) y está escrito ahí.
- **P2 kilos de toda la corrida al cerrar (D-089)**: los kg consumidos de cada bloque los reemplazan, igual que en coberturas (ESPEC §1); el despunte cae en su bobina (cc34).
- **P2/P3 sin cambio**: la casilla de tolerancia no se guarda en el navegador; la clave del almacenamiento no incluye al usuario (es un equipo de planta); «Teórico» con la primera bobina.
