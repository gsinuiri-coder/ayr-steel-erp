# cc28, corte 2: autorrevisión

> **Autorrevisión.** La hizo un subagente nuevo que no leyó el handoff de implementación ni
> escribió el código. Es una **lista de riesgos, no una aprobación**, y no vale como pase
> cruzado (AGENTS.md §2.2).

- Rama `cc28-corte2`, diff `origin/main...HEAD` (main = `fc1c8347`), 6 commits (`8297b621`..`4371eca8`).
- Alcance: D-461 (fila de redondeo), D-446 (descargas por `fetch`), D-444 (etiquetas del Panel),
  D-462 (buscador y marca con espacios), P2-2 de cc20 (otras bobinas montadas en el rechazo),
  cambios sin guardar (ventas y despacho), tests y E2E nuevos.
- Verificación propia: unitarios de API `search-seq`, `sales-margin.service`,
  `other-mounted-coils-hint`, `tolerance-override-accessory`, `imported-invoice-d387`,
  `reports-xlsx` y `admin-dashboard` (7 suites, 133 tests en verde), y unitarios web
  `download.spec` y `admin-dashboard.spec` (8 tests en verde). No se corrió ni build ni E2E: hay
  una corrida en curso en este worktree.

---

## P1

### A-1 (P1): la fila «Redondeo al céntimo» está en la tabla equivocada

- `apps/web/src/app/(app)/reportes/ventas-margen/ventas-margen-view.tsx:279-290`.
- La fila está dentro del `<TableBody>` de **«Facturación parcial en el rango»** (la sección
  `excluded.length > 0`, líneas 242-293) y no en **«Totales por línea de negocio»** (331-380), que
  es donde D-461 la pone y donde la pone el Excel (`reports-xlsx.ts:239-250`).
- Qué falla:
  1. En «Todas» sin pedidos de facturación parcial (lo normal), la fila **no se ve nunca**: la tabla
     por línea vuelve a no cerrar contra «Todas», que es lo que D-461 venía a arreglar.
  2. Con pedidos de facturación parcial, aparece debajo de los pedidos excluidos, en una tabla
     cuyas columnas son Pedido / Cliente / Venta en el rango / Material de OPs, así que se lee como
     parte de la venta excluida. Y `colSpan={3}` no cuadra con esa tabla (3 o 4 columnas).
- Ningún test lo detecta: el E2E de cc23 mira solo la API y no hay test de la vista.
- Arreglo: mover el bloque al final del `<TableBody>` de «Totales por línea de negocio» (después
  de `totalsByLine.map`); ahí `colSpan={3}` sí cuadra con Costo / Margen / %. Conviene una aserción
  en un E2E de UI (o en `reportes-por-linea-cc23`) de que la fila está en esa tabla cuando
  `roundingPen ≠ 0`.

## P2

### A-2 (P2): el E2E de cc23 deja viva la boleta del mostrador; la purga falla en silencio

- `e2e/tests/reportes-por-linea-cc23.spec.ts:118-154`; `e2e/helpers/sales.ts:862-866`;
  `apps/api/src/sales/order-cancel-checks.ts:140`.
- `purgeSalesTrail` anula el **pedido**, y la anulación se rechaza mientras haya un comprobante
  vigente («El pedido … tiene el comprobante … vigente»). La venta de mostrador emite una boleta
  aceptada, así que el `POST /cancel` responde 4xx. El helper no mira el status (el `.catch` solo
  atrapa errores de red), y la boleta, el pedido despachado y el stock de `setupPosStock` quedan
  en la base.
- Además la purga no está en un `finally`: si falla la aserción de suma, ni siquiera se intenta.
- Efecto: cada corrida local que reusa la base agrega 0,0017 de redondeo con fecha de hoy.
  `reportes-costeo-rf-s4a.spec.ts:228` compara `Σ totalsByLine.salesPen` contra `totals.salesPen`
  del día con `toBeCloseTo(…, 2)` (tolera menos de 0,005). Con tres corridas en el mismo día
  sobre la misma base (o con otra prueba que también deje redondeo hoy), ese spec se pone rojo
  sin que haya un defecto, y el rojo apunta a otro lado. En CI la base es nueva y no pasa.
- Arreglo: emitir una nota de crédito total de la boleta (o usar el camino de anulación del
  mostrador, si existe) antes de anular el pedido, todo en un `finally`; y que `purgeSalesTrail`
  avise si el cancel no responde 2xx. Otra opción es que rf-s4a sume `totals.roundingPen` a su
  `sumOf('salesPen')`, que es justo el invariante de D-461.

### A-3 (P2): el aviso de «otra bobina montada» casi no llega a la pantalla

- `apps/api/src/production/roofing-production.service.ts:1159-1177`;
  `apps/web/src/app/(app)/planta/accessory-report-card.tsx:162-167`;
  `apps/api/src/production/roofing-drafts.ts:137-150`; `apps/web/src/app/(app)/planta/tolerance-override.tsx`.
- La pista se agrega solo al **mensaje** del rechazo con código (`TOLERANCE_OVERRIDE_REQUIRED`).
  Pero:
  1. **Accesorio:** cuando llega `excess`, la tarjeta muestra el aviso de la casilla armado con las
     cifras y **no** muestra `err.message` (`toast.error` solo corre si falta `excess`). La pista
     no se ve nunca.
  2. **Planchas por borrador:** la vista previa (`checkDraftRows`) llama a `mountedKgForReport`
     con `authorized: true`, así que nunca rechaza: la fila sale «Fuera de tolerancia» con la
     casilla, el administrador la marca y el commit entra sin pasar por el rechazo. La pista solo
     aparece si se ejecuta **sin** la casilla (toast de `onCommitError`).
  3. Con la casilla marcada, que es justo el escenario de P2-2 de cc20 («A queda en 0 con un
     faltante que está en B»), no hay ningún aviso.
- El arreglo que pedía cc20 era el mensaje **y** el aviso de la casilla. Queda hecha la mitad
  que menos se ve. Tampoco hay test del cableado en `reportInTx`: el spec nuevo prueba la
  función pura, y `tolerance-override-accessory.spec.ts` no tiene un caso con dos bobinas.
- Arreglo: mandar la lista de otras bobinas con saldo como dato (p. ej. dentro de `excess`, o en
  `outOfTolerance` de la vista previa del borrador) y mostrarla en `ToleranceOverride`. Si no,
  al menos mostrar `err.message` en la tarjeta del accesorio. Y agregar un unitario de
  `reportInTx` con dos consumos que compruebe el texto.

### A-4 (P2): la descarga por `fetch` no renueva la sesión en un 401

- `apps/web/src/lib/download.ts:39-41` frente a `apps/web/src/lib/api.ts` (`tryRefresh`).
- `api()` hace refresh y reintenta ante un 401, y `downloadFile` no. La cookie de acceso vence
  con `ACCESS_TOKEN_TTL_SECONDS` (`apps/api/src/auth/cookies.ts:17`). Quien deja una lista
  abierta sin que TanStack vuelva a pedir datos y después hace clic en «Descargar Excel» recibe
  un aviso «Unauthorized» o similar, en vez del archivo. Con el `<a>` de antes también fallaba
  (se abría el JSON del 401), así que no es una regresión. Pero el objetivo de D-446 es que la
  descarga se comporte como el resto de la app, y ahora el arreglo es trivial.
- Arreglo: ante un 401, `tryRefresh()` (exportarlo desde `api.ts`) y un reintento único.

## P3

### A-5 (P3): la fila de redondeo se llama «redondeo», pero mide cualquier diferencia entre cabecera y líneas

- `apps/api/src/reports/sales-margin.service.ts:599-604`.
- `roundingPen = Σ subtotal de comprobantes − Σ subtotal de sus líneas` sobre los pedidos dentro
  de los totales. Para lo que emite el ERP (`sumLineTotals`/`roundDocumentTotals`, D-377) la
  diferencia es de a lo sumo 0,005 por comprobante, y el signo con notas de crédito es correcto
  (las dos sumas usan el mismo signo). Los pedidos excluidos o no rastreables no aportan: ni su
  cabecera ni sus líneas (salvo Servicios, que entra por los dos lados en `addNoCostSales`), así
  que la identidad `pestañas + «Sin línea» + redondeo = «Todas»` se sostiene. Lo comprobé en
  código.
- El riesgo es otro. Un comprobante cuya cabecera no sea `céntimo(Σ líneas)` (un `IMPORTED`
  antiguo con importes del papel, o uno sin líneas) cae entero en esta fila con la etiqueta
  «Redondeo al céntimo», sin cota y sin aviso.
- Arreglo: calcular la diferencia por comprobante. Si alguna pasa de 0,005, mostrarla aparte
  («Diferencia entre comprobante y líneas») o al menos registrarla. Si no, acotar el texto de la
  fila.

### A-6 (P3): el menú «⋯» no se cierra al descargar desde él

- `apps/web/src/components/header-actions.tsx:131-137` y `189-200`.
- `onDownloadClick` llama a `e.preventDefault()` en el `<a>` hijo del `DropdownMenuItem asChild`.
  Radix compone su `onClick` con `composeEventHandlers`, que **omite** su `handleSelect` cuando el
  evento ya viene con `defaultPrevented`. El ítem no dispara `onSelect` y el menú queda abierto
  durante la descarga y después. Afecta a todas las descargas secundarias (kardex Excel/SUNAT,
  reporte de bobinas Excel/PDF, hoja de planta, etc.). No lo verifiqué en el navegador: lo
  deduzco del contrato de Radix.
- Arreglo: en el ítem de menú, descargar desde `onSelect` del `DropdownMenuItem` (con
  `e.preventDefault()` del evento de click solamente), o cerrar el menú a mano.

### A-7 (P3): sin indicador mientras baja y sin protección contra el doble clic

- `apps/web/src/lib/download.ts:39-58`; `header-actions.tsx:131-137`.
- Antes, el navegador mostraba la descarga en cuanto llegaban los headers. Ahora no pasa nada
  visible hasta que el blob termina, y un Excel de 5000 filas o un PDF de reporte puede tardar
  segundos. Un segundo clic baja dos archivos (hubo doble clic de usuarios reales, AGENTS.md §6).
  Además, si el API no manda `Content-Disposition`, el nombre de respaldo es el último segmento
  de la ruta (`xlsx`, `pdf`), sin extensión. Hoy todos los endpoints lo mandan.
- Arreglo: un toast de carga o un estado pendiente por `href` que ignore clics repetidos, y un
  respaldo de nombre con extensión según `Content-Type`.

### A-8 (P3): el JSDoc de `fillDays` quedó pegado a `billedPen`

- `apps/web/src/lib/admin-dashboard.ts:16-31`.
- El comentario nuevo se insertó entre el JSDoc de `fillDays` («Cada día del rango…») y la
  función. Ahora `billedPen` tiene dos bloques y `fillDays` ninguno.
- Arreglo: mover el bloque de `fillDays` debajo de `billedPen`.

### A-9 (P3): el título del gráfico dice «incluye ventas sin costo comparable» aunque no haya ninguna

- `apps/web/src/app/(app)/admin-dashboard.tsx:209`.
- La línea bajo el titular solo agrega el paréntesis si `billed ≠ salesPen` (148-150), pero el
  título del gráfico lo dice siempre. Si es la redacción de D-444 aprobada, no hay nada que
  corregir. Si no, condicionarlo igual.

### A-10 (P3): búsqueda parcial con guion no encuentra la marca con espacios

- `apps/api/src/sales/quotations.service.ts:1465-1474`; `packages/shared/src/schemas/quotation-import.ts:666-669`.
- Un número completo (`FFA1-1419`, `FFA1 - 1419`) sí encuentra la marca `FFA1 - 1419`, porque el
  prefiltro va sin guion y la comparación final compacta los dos lados. Pero un fragmento con
  guion que no normaliza (`A1-14`) cae en `notes contains 'A1-14'`, que no calza con
  `Factura externa: FFA1 - 1419`. Es un caso de borde, coherente con «nada más se adivina».
- Otra precondición que sigue igual que antes: el prefiltro `startsWith 'Factura externa: FFA1'`
  supone un solo espacio después de los dos puntos. Una marca con dos espacios, que el parser sí
  lee (caso del spec `'Factura externa:  FFA1-1419  '`), no la encuentra el buscador con serie.
  Viene de antes de cc28.
- Arreglo: opcional. Si importa, prefiltrar con `contains` del correlativo en vez de `startsWith`
  de la serie.

### A-11 (P3): `searchSeqOf` deja de reconocer formas que antes calzaban

- `apps/api/src/common/search-seq.ts:17-22`.
- Ahora solo valen `123`, `COT-123`, `COT 123` y `cot123`. Dejan de encontrar por correlativo
  `#123`, `N° 123`, `Cot. 123`, `PED.123`, y también `COT-000123` en la lista de pedidos. Es lo
  que decidió D-462 y evita el falso positivo de `BBV1-347`. Lo anoto como cambio de
  comportamiento para el guion de UAT, no como defecto. El RUC/DNI (`docNumber contains`) y el
  nombre del cliente siguen igual, y los ceros a la izquierda (`0042`, `COT-000123`) siguen
  dando el número.

### A-12 (P3): huecos de cobertura

- `apps/api/src/reports/reports-xlsx.spec.ts`: todos los fixtures llevan `roundingPen: '0.0000'`.
  La rama que **agrega** la fila al Excel (`reports-xlsx.ts:239-250`) no tiene test.
- `e2e/tests/excel-listas-cc26.spec.ts`: el clic en el enlace del 400 simulado depende de que
  React ya haya hidratado el `onClick`. Si el clic llega antes, el navegador navega al JSON y el
  test falla de forma intermitente. Esperar algo que solo existe tras hidratar (p. ej. la tabla
  con datos) antes del clic lo hace determinista.
- Los cambios de «cambios sin guardar» (`sales-document-form.tsx:539-546`,
  `nuevo-despacho-view.tsx:368-375, 483, 612`) no tienen test. Revisé el código: la línea vacía se
  compara contra `emptyLine(0)` sin `key` (el orden de propiedades se conserva porque las líneas
  se editan con spread) y los `onValueChange` de Radix solo se disparan por interacción. No
  encontré defecto.

---

## Cuentas

| Severidad | Cantidad          |
| --------- | ----------------- |
| P0        | 0                 |
| P1        | 1 (A-1)           |
| P2        | 3 (A-2, A-3, A-4) |
| P3        | 8 (A-5 … A-12)    |

## Resolución (sesión cc28, corte 2)

- **A-1 (P1), corregido:** la fila «Redondeo al céntimo de los comprobantes» va en «Totales por
  línea de negocio» (antes había quedado en «Facturación parcial»).
- **A-2 (P2), corregido:** el E2E de cc23 anula la venta de mostrador en un `finally` antes de la
  purga (también SM-1 del segundo modelo).
- **A-3 (P2), en parte:** la tarjeta del accesorio muestra siempre el mensaje del rechazo, con el
  aviso de la otra bobina. El aviso en la casilla del borrador (la vista del borrador marca la fila
  sin pasar por el rechazo) queda en PROGRESO.
- **A-4 (P2), corregido:** la descarga reintenta una vez tras refrescar la sesión con un 401
  (SM-2), sin caché, y no arranca dos veces el mismo enlace (A-7 / SM-3).
- **A-8, A-9 (P3), corregidos:** JSDoc de `fillDays` en su lugar; el título del gráfico dice
  «incluye ventas sin costo comparable» solo cuando las hay.
- **A-5, A-6, A-10, A-11, A-12 (P3):** en PROGRESO.
