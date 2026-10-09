# Revisión de segundo modelo (Sonnet) — cc35 corte 3

Alcance: `git diff origin/main...origin/cc35-c3` (11 archivos). Solo lectura; no se corrió nada (sin servidores ni E2E). Todo lo de abajo se verificó leyendo el código de `origin/cc35-c3`.

Veredicto: **no desplegar tal cual.** Hay 3 P1 (uno de ellos es que la pantalla nueva deshabilita los campos tras cada guardado automático). El API (`close-preview.ts`, `scrapKg`) está bien.

## P1 — se corrigen antes del deploy

### P1-1. Cada guardado automático deshabilita todos los campos del bloque mientras se refresca la lista

- `produce-blocks.tsx:374` (`busy` incluye `refreshing`), `:812-:880` (todos los `Input`/`select`/botones llevan `disabled={busy}`); `roofing-order-panel.tsx:319` (`refreshing={refreshing || mount.isPending}`); `planta-view.tsx:191` (`refreshing` = `roofing.isFetching || draftOrders.isFetching || inProgress.isFetching`); `use-block-drafts.ts:152` (`onSaved()` → `invalidateProduction`, que invalida `['roofing-batch']`).
- Escenario: el supervisor escribe «4» planchas y se detiene 700 ms. El guardado sale, `onSaved` invalida `roofing-batch`, la consulta pasa a `isFetching`, `busy` pasa a true y los campos del bloque (y de todos) se deshabilitan. Un input deshabilitado pierde el foco: el supervisor sigue tecleando y las teclas se pierden, o tiene que volver a hacer clic tras cada pausa. Con el modelo de «escribir y se guarda solo» esto ocurre en cada pausa. Los E2E no lo ven porque Playwright espera.
- Arreglo: separar `busy` en dos. Los campos solo se deshabilitan mientras corre `commit`/`previewClose`/`release`, nunca por `refreshing`. `refreshing` solo debe bloquear los botones «Registrar…». Alternativa: no invalidar toda la familia en cada guardado, solo `['production-order', id]` y `['roofing-batch']` con `refetchType` que no ponga `isFetching` en primer plano.

### P1-2. «Confirmar: registrar y cerrar» queda muerto después de un error del commit

- `produce-blocks.tsx:959` (`const fired = useRef(false)`), `:1007-:1009` (se pone en true y nunca se baja). `onError` (`:288-:302`) no limpia `preview`; solo `onSuccess` y «Volver» lo hacen.
- Escenario: «Registrar y cerrar» → vista previa → «Confirmar» → el commit falla (409 de bloqueo, «Fila 2: …», tope del plan). La vista previa sigue en pantalla con `fired.current === true`. El supervisor corrige el bloque y vuelve a pulsar «Registrar y cerrar»: `setPreview(result)` reutiliza la misma instancia de `ClosePreviewBlock`, el `ref` no se reinicia y «Confirmar» no hace nada, sin mensaje. Solo «Volver» y repetir lo destraba.
- Arreglo: quitar el `ref` y apoyarse en `pending` (el botón ya se deshabilita con `commit.isPending`), o resetear al fallar (`onError` → `setPreview(null)`), o `key` del componente atada a un contador de vistas previas.

### P1-3. Los E2E existentes siguen usando la interfaz que este diff elimina

- El diff reemplaza las tarjetas de coberturas y borra «Agregar al borrador de …», «Reportar desde la bobina …», «Corregir la fila …», «Ejecutar … / Reportar y cerrar» para coberturas, y la barra de progreso «Órdenes reportadas». Solo se agregó `planta-modelo-m-cc35.spec.ts`; no se tocó ningún otro E2E.
- Siguen referenciando esos controles, por ejemplo: `borrador-reportes-f8s3.spec.ts`, `huecos-cobertura-f8s3.spec.ts`, `multi-montar-f8s3.spec.ts` (`:286-:289`), `planta-confirmar-cierre-cc27.spec.ts`, `planta-espacio-produccion-ui.spec.ts`, `tolerancia-reporte-d388.spec.ts`, `tolerancia-accesorio-d389.spec.ts` (este último puede ser del accesorio, que no cambia: verificar), `e2e/helpers/ui.ts`. Se espera una cascada de rojos de producto en la suite completa del cierre.
- Arreglo: reescribirlos contra el modelo M (o declarar explícitamente cuáles quedan para el corte siguiente y no desplegar antes). El commit dice «en curso», pero esto debe estar resuelto antes del deploy.

## P2 — conviene corregir

### P2-1. Entre el guardado y el refetch el bloque lee el borrador viejo

- `use-block-drafts.ts:146-:150` quita la edición cuando termina el guardado; `produce-blocks.tsx:158-:172` (`contentOf`) lee entonces `order.drafts`, que aún es el de antes del refetch (`latest.current` tiene el nuevo, pero la vista no lo usa). El bloque parpadea al contenido viejo (o, en el último bloque, vuelve a «derivado») hasta que llega el refetch. Si el usuario teclea en esa ventana, el nuevo `edit` nace de `block.rows` viejas y pisa lo recién guardado. Hoy lo tapa el P1-1 (campos deshabilitados), así que al arreglar el P1-1 esto aflora.
- Arreglo: guardar el borrador devuelto por el API en estado (no solo en un ref) y leerlo en `contentOf`, o conservar la edición hasta que `order.drafts` refleje el guardado.

### P2-2. `latest.current` se puede pisar con un refetch más viejo

- `use-block-drafts.ts:90-:92`: cada cambio de `order.drafts` sobrescribe `latest.current`. Si un refetch que se pidió tras el guardado 1 llega después del guardado 2, `draftsOf()` ve una lista sin la fila nueva y el siguiente guardado hace `POST` en vez de `PUT` (fila duplicada de la misma bobina; el siguiente guardado la limpia, `:121-:124`, pero un commit entre medias llevaría ambas, y `byCoil` en `produce-blocks.tsx:271` se queda con la última fila). Ventana estrecha. Arreglo: no regresar `latest` a datos más viejos (comparar por `updatedAt`/cantidad) o resolver la ruta por `coilId` en el servidor (upsert).

### P2-3. La vista previa puede quedar vieja respecto a lo que se confirma

- `produce-blocks.tsx:554-:567`: con la vista previa abierta los campos siguen editables (`busy` no incluye `preview !== null`). Una edición después de la vista previa se guarda sola a los 700 ms y «Confirmar» (`commit.mutate(true)`) confirma el borrador nuevo sin volver a calcular «Qué va a pasar». Arreglo: deshabilitar los campos mientras haya vista previa, o descartar `preview` al primer `edit`.

### P2-4. Una invalidación enorme por pausa de escritura

- `onSaved` = `invalidateProduction` (`production-queries.ts`): invalida más de 15 familias (inventario, ventas, reservas, cotizaciones…) en cada guardado de un campo. Con el autoguardado son decenas por orden. Basta `['production-order', id]` y `['roofing-batch']` para el borrador; el resto cambia solo al registrar.

### P2-5. El relleno del último bloque pisa lo que el usuario escribió en él

- `produce-blocks.tsx:218-:240`: al editar un bloque no-último, si el último ya estaba guardado o tocado, sus cortes se reemplazan por `fillFromRemaining(...)` sin aviso. Un supervisor que ajustó a mano el último pierde su edición. Aceptable si es el comportamiento de la ESPEC; entonces debería decirse en el bloque («se recalcula con lo que falta»). Verificar con el dueño.

### P2-6. Cobertura de pruebas incompleta frente a lo pedido

- No hay prueba del hook `useBlockDrafts` (debounce, cola serial, versiones, desmontaje): es la parte más frágil y no tiene un solo test. Mínimo: pruebas con timers falsos para (a) dos ediciones seguidas = un guardado, (b) edición durante un guardado no se pierde, (c) flush al desmontar, (d) bloque vacío = `DELETE`.
- No hay E2E de: accesorio y drywall sin cambios (regresión pedida), plancha de catálogo (rama `catalog`), tolerancia >5 % con aviso fuerte, motivo de despunte >10 % al cerrar, bobina terminada plegada + «Abrir ▸», ni el caso del P1-2.
- `close-preview.spec.ts` prueba el `scrapKg` por bobina con un Prisma simulado (bien: incluye el despunte viejo de un cierre reabierto que no debe contar), pero no hay prueba de base real; el par `db-spec` de la preview con despunte no existe. Aceptable por ahora.
- `production-blocks.spec.ts` es correcto y cubre `fillFromRemaining`, `blockFigures`, `coilOfRowError` y `planSquare`. Falta un caso de `fillFromRemaining` con dos largos iguales repetidos en `remaining`.

## P3 — notas

- `produce-blocks.tsx:751`: los botones «Plegar» de varios bloques tienen el mismo nombre accesible; agregar `aria-label` con el código de bobina (el «Abrir» y el «Bajar» sí lo llevan).
- `produce-blocks.tsx:781-:849`: filas con `key={i}`; al quitar un corte con «✕» el foco se pierde. Aceptable, pero conviene llevar el foco al siguiente campo.
- `produce-blocks.tsx:869-:877`: el `Input` de kg lleva `aria-label` y además `<label htmlFor>`; el `aria-label` gana y oculta el texto «opcional». Usar solo el `label` o incluir «opcional» en el `aria-label`.
- `produce-blocks.tsx:574-:580`: «Sin guardar todavía» aparece también cuando solo hay un error de validación sin guardar; está bien, pero si un bloque tiene error de guardado debería decir «Hay un bloque sin guardar» (hoy se lee igual que «escribiendo»).
- `produce-blocks.tsx:255-:266` (`persistAll`): «Registrar y cerrar» → «Volver» deja el último bloque guardado como borrador (ya no «derivado»). Es correcto, pero cambia el comportamiento de relleno automático desde ese momento; vale una línea en el UAT.
- `useIdempotencyKey`: la huella del commit es solo `'commit'`/`'close'` (no el contenido). Tras un corte de red incierto, si el usuario edita y reintenta, la clave se reusa y el servidor devolvería el resultado del primero (D-182 pide clave por contenido). Igual que el panel anterior, pero el autoguardado hace más probable la edición entre intentos; conviene incluir un hash de los ids/versiones del borrador en la huella.
- Cabecera de `planta-view.tsx`: la tarjeta de compromiso y la barra de progreso pasan a la línea de descripción; se pierde el `role="progressbar"` («Órdenes reportadas»). No hay regresión funcional; confirmar que ningún E2E lo buscaba (no se encontró referencia).
- `coil-picker.tsx`: el cambio (mensaje de «sin bobinas» dentro de la tabla, esqueleto más pequeño) es coherente; ningún riesgo hallado.

## Lo que se verificó y está bien

- `close-preview.ts`: el filtro del `scrapOuts` (refId = orden, `SCRAP`, `OUT`, solo bobinas montadas) coincide con lo que escribe el cierre (`roofing-production.service.ts:2307`, `refType: 'SCRAP'`, `refId: orderId`); el «antes» se lee después de bloquear la orden; los `id` de un cierre reabierto se excluyen; todo dentro de la transacción que se deshace; `scrapKg` opcional en el esquema para el despliegue web/API escalonado (orden de deploy correcto: API antes que web).
- Decimal: todas las cifras de `production-blocks.ts` usan `Decimal`/`toDecimal`; el único `number` son conteos de planchas (enteros). El patrón de kg `^\d+(\.\d{1,3})?$` coincide con el del API.
- Mapeo de casillas a `draftId` (`produce-blocks.tsx:271-:276`): se calcula después de `persistAll`, con `latestDrafts()`, así que el derivado recién guardado entra. Con un borrador viejo de dos filas por bobina la casilla va a la última; `saveNow` ya las unifica antes.
- Orden de guardado al editar un bloque no-último con el último ya guardado (`:233-:240`): si el último se encoge se guarda primero y al crecer va después, de modo que el tope del plan nunca se excede transitoriamente. Correcto.
- `useBlockDrafts`: cola serial, versión por bloque (un guardado viejo no borra una edición nueva), clave de idempotencia por huella de contenido para el alta, vaciado al desmontar. `ProduceBlocks` se monta con `key={active.orderId}` (`planta-view.tsx:621`), así que no se mezclan órdenes. Accesorio y drywall siguen en su camino (`roofing-order-panel.tsx`: `!order.isAccessory ? <ProduceBlocks/> : …`; drywall tiene su panel propio).

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
