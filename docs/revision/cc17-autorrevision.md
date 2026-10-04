# cc17 — Autorrevisión (D-385: importador en TONELADA y bobina sin asignar)

> **Autorrevisión.** La hizo un subagente del mismo modelo que no leyó el handoff de
> implementación. Es una **lista de riesgos, no una aprobación**, y no vale como pase cruzado
> (AGENTS.md §2.2).

- Rama: `cc17/importador-bobina` (worktree `ayr-cc17`), diff `origin/main...HEAD`, 4 commits
  (`555efcf`, `15da50c`, `cae5e96`, `90f24c1`).
- Alcance revisado: A (TONELADA → kg en el importador) y B (línea de bobina sin bobina asignada,
  elegir la bobina al confirmar con ±1 %).
- Método: lectura del diff y del código que lo rodea (`sales-lines.ts`, `quotations.service.ts`
  update/duplicate, `sales-orders.service.ts` confirm/preview/reservas temporales,
  `dispatches.service.ts`, `imported-documents-sweep.service.ts`, `importar-view.tsx`). No se
  corrió ninguna suite.

## Resumen

| Severidad | Cantidad |
| --------- | -------- |
| P0        | 0        |
| P1        | 2        |
| P2        | 5        |
| P3        | 6        |

---

## P1 — corregir antes del deploy

### P1-1. La unidad desconocida no bloquea la fila en la pantalla, y el servidor no la vuelve a comprobar

- **Dónde:** `apps/api/src/imports/quotation-import.service.ts:283-296` emite el error con
  `field: 'qty'`; `apps/web/src/app/(app)/cotizaciones/importar/importar-view.tsx:1238-1246`
  (`resolveRow`) copia de `raw.issues` **solo** los avisos con `field === 'product'`. Los de
  `qty` se descartan y la cantidad se vuelve a validar en el cliente solo por formato
  (`:1265-1271`).
- **Escenario:** un archivo trae `UNIDAD MEDIDA = "TM"` (o `KG`, `UND`, `ML`…) en una fila de
  bobina. El preview del API marca «La unidad «TM» no se reconoce…» como error, pero la pantalla
  no lo muestra, la fila no cuenta en `blockingRows` (`:241`) y el botón de importar queda
  habilitado. `confirm` del importador no recibe la unidad (`quotationImportRowInputSchema` no la
  tiene) y crea la cotización con 4.192 kg por S/ 12 789 (unitario ≈ S/ 3 050/kg). Lo mismo pasa
  con el aviso «La fila está en TONELADA: si el producto que elijas se vende en kilos,
  multiplica…» (`:289-295`), que tampoco llega a verse.
- **Por qué es P1:** el alcance aprobado dice «unidad desconocida → la fila queda bloqueada con
  mensaje claro». Hoy solo queda bloqueada en el JSON del preview.
- **Propuesta:** que `resolveRow` conserve también los avisos de `qty` del servidor que no
  dependen de lo editable (al menos el de unidad), o emitir el error de unidad con un `field`
  propio (`'unit'` o `'row'`) que el cliente conserve siempre. Además, como segunda cerradura,
  que el confirm del importador no admita una fila cuyo `rawUnit` no se reconozca (mandar la
  unidad en la fila o revalidar contra el papel). Falta un test web/E2E de la fila bloqueada.

### P1-2. El barrido lee el papel sin la conversión de toneladas: las filas en TONELADA no se emparejan

- **Dónde:** `apps/api/src/imports/quotation-import.service.ts:944-976` (`readPaperLines`). Su
  propio contrato dice «la misma lectura que `preview` … el barrido compara contra esto, así que
  no puede leer el archivo de otra forma», pero `qty` sale de `parseAmount(field(r, 'qty'))` sin
  `paperQtyOf`. Emparejamiento: `imported-documents-sweep.service.ts:694-701` exige
  `toDecimal(p.qty).equals(line.qty)`.
- **Escenario:** se importa setiembre (FFA1-1419, `BOB030AZUL 4.192 TONELADA` → línea de
  4192.000 kg). Al correr el barrido con el mismo archivo, el papel dice `4.192` y la línea
  `4192.000`: «ninguna línea del papel tiene su producto (BOB030AZUL) y su cantidad», la fila del
  papel queda en `unpairedPaperRows` y el documento entero va a (c) con un falso «sin pareja».
  Ningún hallazgo de importe de ese documento se corrige solo.
- **Propuesta:** aplicar en `readPaperLines` la misma conversión. El barrido no conoce el
  producto, pero para las filas de bobina (`/^BOB/` o descripción «BOBINA», igual que
  `resolveCoilRows`) la unidad del producto es siempre KGM, que es exactamente lo que ya hace
  `resolveCoilRows` (`paperQtyOf(raw, Unit.KGM)`). Para el resto, pasar el producto resuelto o
  documentar que el barrido no convierte. Agregar el caso a `describe('readPaperLines')`
  (`quotation-import-coil.spec.ts:592`). Si el dueño confirma que el barrido no se va a correr
  con archivos en toneladas, puede bajar a P2, pero el contrato de la función queda roto igual.

---

## P2 — mejorable

### P2-1. Dos locks de bobinas en la misma confirmación: rompe el orden único y abre un deadlock

- **Dónde:** `apps/api/src/sales/paper-coil-assignment.ts:375-380` bloquea las bobinas elegidas;
  después `sales-orders.service.ts:572` → `reserveLines` (`:1619-1623`) bloquea la **unión**
  (bobinas de las líneas + bobinas de los agregados de materia prima) en orden de id. El
  comentario de `reserveLines` (`:1614-1618`) explica justo por qué dos locks separados se cruzan.
- **Escenario:** la cotización tiene la línea sin bobina (eliges la X) y otra línea de cobertura
  del mismo color y espesor cuyo agregado incluye la W < X. La transacción A toma X y luego pide
  W. En paralelo B (otra confirmación o reserva temporal de cobertura del mismo agregado) toma W
  y luego pide X. Postgres aborta una con `40P01`: no rompe datos, pero el usuario ve un 500 y
  tiene que reintentar.
- **Propuesta:** no bloquear en `resolvePaperCoilAssignments`. Validar la tolerancia sin lock y
  dejar que `createReservations` bloquee la unión de una vez y compruebe el disponible (ya
  rechaza si el saldo bajó). Si se quiere validar la tolerancia bajo lock, revalidarla dentro de
  `reserveLines` o calcular la unión completa antes y bloquearla una sola vez.

### P2-2. Duplicar una importada con línea sin bobina da 400

- **Dónde:** `apps/api/src/sales/quotations.service.ts:616` (`isWholeCoil` = `reserveItemType === 'COIL'`)
  y `:719-729`. La línea sin bobina tiene `reserveItemType = PRODUCT`, viaja como
  `{ productId: BOB… }` y `unassignedCoilProducts` (`:641`) solo recibe las bobinas atadas.
  `resolveSalesLines` (`sales-lines.ts:411-415`) lanza «BOB030AZUL es el producto de venta de una
  bobina: elige la bobina que se vende (venta directa)».
- **Escenario:** el vendedor duplica la cotización emitida de FFA1-1419 antes de confirmarla para
  cotizar lo mismo a otro cliente: el duplicado entero falla con un mensaje que en un duplicado no
  tiene solución.
- **Propuesta:** en el duplicado, tratar la línea `BOB…` sin bobina igual que la atada (D-322):
  agregar su `productId` a `unassignedCoilProducts` con un aviso «elegí la bobina con «Bobina
  completa (venta directa)»». Test en `quotation-duplicate-coil-d322.spec.ts`.

### P2-3. La excepción «sin bobina asignada» al editar es por producto, no por línea

- **Dónde:** `apps/api/src/sales/quotations.service.ts:301-303` y `:526-538`. El permiso se pasa
  aunque el actor no sea ADMINISTRADOR y aunque la línea ya no sea del papel (`paperLines`).
- **Escenarios:** (a) en una importada que ya tiene una línea `BOB030AZUL` sin bobina, cualquier
  edición puede **agregar** otra línea `BOB030AZUL` sin bobina (mismo `productId`), que después
  aparece en confirmar como `CHOOSE_COIL` contra unos kilos que no vienen del papel. (b) Un
  VENDEDOR cambia la cantidad de la línea sin bobina: deja de ser del papel (D-256), se recalcula
  el importe, pero sigue exenta de la regla D-254 R1 y la tolerancia de confirmar se mide contra
  los kilos que tipeó, no contra los del comprobante.
- **Propuesta:** limitar la excepción a las líneas sin bobina que **siguen** siendo del papel
  (las de `unchanged`), o al menos no admitir más líneas sin bobina de ese producto que las que
  había. Decidir con el dueño si el VENDEDOR puede tocar esa línea.

### P2-4. El barrido trata la línea sin bobina como defecto de R1 y la ata con semántica distinta a D-385

- **Dónde:** `apps/api/src/imports/imported-documents-sweep.service.ts:549-566`
  (`productFinding`) y `:360-367` (`execute` salta todo documento con un hallazgo de producto
  sin `autoCoilId`), `:614-620` (`fixQuotation` ata con `saleCoilId` y la cantidad del papel).
- **Escenarios:** (a) toda importada D-385 sin bobina aparece en el reporte como «no vende una
  bobina del pool» y, mientras no haya una bobina con saldo ≥ al papel, el documento **entero**
  queda fuera de la corrección automática aunque sus otras líneas tengan hallazgos de importe
  corregibles. (b) Si entra una bobina única con saldo ≥ al papel, el barrido la ata como venta
  parcial de D-254 (reserva la cantidad del papel y deja un remanente), no como D-385 (saldo
  entero, ±1 %, elegida por una persona al confirmar).
- **Propuesta:** que el barrido distinga la línea D-385 de una cotización importada (excluirla de
  `productFinding` o reportarla como «sin bobina asignada: se elige al confirmar» sin bloquear el
  resto del documento). Decisión del dueño sobre si el barrido debe atarla alguna vez.

### P2-5. El importador ya no exige en el servidor que la fila de bobina sin bobina no tuviera candidata

- **Dónde:** `apps/api/src/imports/quotation-import.service.ts:858-860`. Toda fila sin
  `saleCoilId` entra en `unassignedCoilProducts`, sin mirar si el pool tenía candidatas.
- **Escenario:** antes el confirm devolvía 400 si una fila `BOB…` llegaba sin bobina (D-254 R1);
  ahora la acepta siempre. La única cerradura de «hay dos candidatas, elige cuál» es la pantalla
  (`importar-view.tsx:1247-1251`). Un cliente desincronizado o un cambio futuro de la pantalla
  crea líneas sin bobina donde había bobina libre. No rompe datos (se resuelve al confirmar), pero
  debilita una regla que estaba en el servidor.
- **Propuesta:** en el confirm, admitir sin bobina solo las filas cuyo pool, releído dentro de la
  transacción, no tenga candidata con la cantidad del papel; o dejarlo registrado como decisión
  si se acepta el cambio.

---

## P3 — notas

### P3-1. Reserva temporal de una importada con línea sin bobina: rechazo con un mensaje que confunde

`sales-orders.service.ts:1950-1979` arma las líneas con `quotationReservableLines`, que deja la
línea sin bobina como `PRODUCT BOB…`; `reserveLines` llama a `lockAvailability` y rechaza con
«BOB030AZUL tiene 0.000 KGM disponibles … y la reserva necesita 4192.000». La cotización entera no
se puede reservar, ni sus otras líneas. Ya pasaba con el duplicado de D-322, pero D-385 lo vuelve
el caso normal de la importada sin stock. Propuesta: excluir la línea sin bobina de la temporal
(como en el preview) o rechazar con «la línea N no tiene bobina: se elige al confirmar».

### P3-2. Una bobina ya vendida por otra línea de la misma cotización aparece como elegible

`paper-coil-assignment.ts:310` llama a `coilPoolFor` con `exceptQuotationIds: [quotationId]`, así
que una bobina W que la línea 1 ya vende (venta parcial D-254) aparece como opción de la línea 2.
Si se elige, `resolvePaperCoilAssignments` la acepta y `reserveLines` rechaza después con «W tiene
X disponibles … y el pedido necesita Y». Bloquea, pero con un mensaje opaco y después de que el
preview la mostró como «dentro de tolerancia». Propuesta: excluir de las opciones las bobinas que
la propia cotización ya tiene en `reserveItemId`.

### P3-3. El diálogo deja elegir la misma bobina en dos líneas `CHOOSE_COIL`

`confirm-quotation-dialog.tsx:110-115` no lo impide; el API responde «La misma bobina no puede
atender dos líneas» (mensaje claro). Propuesta: marcarlo en el diálogo antes del clic.

### P3-4. El preview de confirmar no descuenta la bobina elegida del agregado de materia prima

`previewLinesOf` corre sin las líneas `CHOOSE_COIL`. Si otra línea de la misma cotización es una
cobertura del mismo color y espesor, confirmar reserva primero la bobina entera (`COIL:` ordena
antes que `RAW_MATERIAL:`) y la cobertura puede quedar corta o caer en
`assertRawMaterialInvariant`, cosa que el preview no anticipa. Mismo patrón que las ventas de
bobina D-116 ya existentes; solo nota.

### P3-5. Fila de bobina con color no interpretable: la línea sin bobina cae en el camino genérico

`paper-coil-assignment.ts:286-288`: si `lineCoilPool` devuelve `null`, la línea no es
`CHOOSE_COIL`; el preview la muestra como `RESERVE_STOCK` con «BOB… tiene 0.000 KGM disponibles».
Coherente con confirm (también rechaza), pero el motivo real (color sin interpretar) no se dice.
Del mismo tipo: en `toPreviewRow` (`:281`) una fila de bobina con `product = null` no se convierte
mientras `resolveCoilRows` sí buscó en el pool en kilos; la fila queda bloqueada igual.

### P3-6. Huecos de tests y texto

- Sin test de: edición de una importada que conserva la línea sin bobina
  (`storedUnassignedCoilProducts`; `quotation-update-d256.spec.ts` solo agregó el mock), duplicado
  de una importada con línea sin bobina, barrido con un archivo en toneladas, y la fila de unidad
  desconocida en la pantalla.
- `quotation-import-real-files.spec.ts` comprueba «no se reconoce» en **todas** las filas de
  agosto, pero en setiembre solo mira FFA1-1419. Conviene repetir el barrido de unidades sobre el
  archivo de setiembre entero: cualquier variante de unidad que no esté en
  `QUOTATION_IMPORT_UNITS` ahora bloquea filas que antes entraban.
- `cotizacion-detalle-view.tsx` (cotización manual): «Edita la cotización y quita la línea y elige
  la bobina…» encadena dos «y» (la frase ya era así antes del cambio). Solo redacción.

---

## Verificado sin hallazgo

- `Decimal` en toda cuenta nueva: `importQtyInProductUnit` (`qty.times(1000)`),
  `paperCoilWeightCheck` (tolerancia como string `'0.01'`, bordes inclusivos), el diálogo usa la
  misma función. `KG_PER_TONNE` es un entero exacto.
- Constante única `PAPER_COIL_WEIGHT_TOLERANCE`, usada por API (preview y confirm) y web.
- Preview y confirm calculan lo mismo para `CHOOSE_COIL` (`paperCoilChoices` + `paperCoilBlocker`).
- La cotización manual no cambia: `unassignedPaperCoilLines` devuelve `[]` si no es importada, y
  `coilAssignments` en una manual da 400.
- Despacho: con `reserveQty` = saldo y `qty` = kilos del papel, `proratedQty` saca el saldo entero
  al despachar la línea completa y `closeEmptySoldCoils` cierra la bobina; la factura usa los kilos
  del papel. Coherente con «se reserva el saldo entero; el importe no se recalcula».
- `updateItemQty` del pedido rechaza cambiar la cantidad de una línea `COIL`, así que la diferencia
  `qty` ≠ `reserveQty` no se reinterpreta después.
- El kardex no se escribe fuera de `InventoryService`: confirm solo crea reservas por
  `createReservations`.
- Filas en KILOGRAMO o sin unidad: sin conversión (test con agosto real).
