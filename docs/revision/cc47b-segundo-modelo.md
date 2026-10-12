# cc47b — revisión del segundo modelo (Sonnet)

Alcance: `git diff bd48dd75 11eaf1e4` (41 archivos, solo web y E2E). Revisión estática más `tsc --noEmit` (limpio) y `eslint` sobre los archivos de vista tocados (limpio). No se corrió Playwright. Sigue siendo un modelo, no una persona.

Veredicto: sin P0 ni P1. La mecánica de D-623, D-624 y D-625 está bien resuelta. Hay desvíos de la letra del pedido (P2) y riesgos de fragilidad en el E2E nuevo.

## Lo que se comprobó y está bien

- `HeaderActions` (`apps/web/src/components/header-actions.tsx:86-90`): una descarga nunca es principal, aunque una vista la nombre en `primary`. Con `primary={[]}` y solo descargas queda solo «Más opciones». Si no hay acciones visibles devuelve `null` (el menú vacío no se muestra).
- Ningún `aside=` de `TableToolbar` lleva ya descargas. Solo quedan dos `aside`, ambos con «Ver por» (Ventas y margen y Producción), como pide D-615.
- Causa de D-624 bien identificada: las tablas de Cobranzas eran `<Table>` sin `list`, así que no tenían alto propio ni cabecera fija. Ahora son `<Table list>`. Inventario también pasa a `list`. El CSS de `globals.css:210` ya fija el `thead` sticky en `data-density='list'`, así que `SummaryTable` sin clase sticky no es defecto. Los `TabsContent` pasan a `grid-cols-1` (si no, la columna `auto` del grid se estira al ancho de la tabla) y `TabsContent`, `SidebarInset`, el contenedor del `AppFrame` y `Section` ganan `min-w-0`. Es la causa real del scroll horizontal de página, y se arregla en el componente compartido.
- El Excel de «Comprobantes con saldo» sigue llevando buscar, filtros y orden: `pendingParamsOf` se comparte entre la tabla y la cabecera, y `useUrlState` y `useSort` derivan de la URL, así que no hay desfase entre los dos usos.
- Permisos y confirmaciones: los `show:` y los roles se conservan (kardex solo admin, Por cliente solo admin; el vendedor queda en `pendientes`). «Anular orden» y «Cancelar lo pendiente» pasan a `destructive` (al final, en rojo), con el mismo `ReasonDialog` y la misma confirmación.
- Mostrador: el `DropdownMenu` queda dentro del árbol React de `DialogContent`, así que el clic en el menú no cuenta como «fuera» del diálogo. «Imprimir comprobante» sigue principal.

## Hallazgos

### P2-1 — Descargas sueltas que quedan en la página (viola D-623.1, «cualquier archivo… nunca sueltas en la página»)

- `apps/web/src/app/(app)/catalogo/precios/importar/importar-precios-view.tsx:181-185`: botón «Descargar plantilla» suelto en la cabecera.
- `apps/web/src/app/(app)/compras/importar/importar-compras-view.tsx:283-292`: botones «Plantilla» y «Ejemplo» sueltos.
- Escenario: el dueño abre «Importar compras» y ve tres descargas como botones. El pedido dice «TODAS las páginas».
- Corrección: pasarlas a `HeaderActions` con `primary={[]}` y rótulos «Descargar plantilla» / «Descargar plantilla de ejemplo». Si el dueño las considera fuera de alcance (no son reportes), registrarlo como decisión; hoy el diff no dice nada.

### P2-2 — En pestañas, el rótulo no dice la pestaña (D-623: «en pestañas la descarga es de la pestaña activa y el rótulo lo dice»)

- Solo Cobranzas e Inventario rotulan («Descargar Excel · Por cliente», «· Bobinas por tipo»).
- Los reportes con pestañas de línea (o «Ver por») siguen con «Descargar Excel» a secas:
  - `reportes/ventas-margen/ventas-margen-view.tsx:151`
  - `reportes/ventas-material/ventas-material-view.tsx:235`
  - `reportes/merma/merma-view.tsx:104`
  - `reportes/produccion/produccion-view.tsx:114`
  - `reportes/bobinas/reporte-bobinas-view.tsx:124,134`
  - `reportes/inventario-valorizado/inventario-valorizado-view.tsx:166`
- Escenario: en Ventas por material, pestaña Drywall, el menú dice «Descargar Excel» y baja solo Drywall. El usuario no lo sabe hasta abrir el archivo.
- Corrección: rótulo con la línea (`Descargar Excel · ${BUSINESS_LINE_LABELS[line]}`) o decidir que «pestaña» solo cuenta cuando las pestañas son tablas distintas (como en Cobranzas) y dejarlo escrito. Si se cambia el rótulo, hay que ajustar `moreOption(page, 'Descargar Excel')`, que usa `exact: true`, en unos 12 E2E.

### P2-3 — Compras: la acción principal cambia con la selección

- `apps/web/src/app/(app)/compras/compras-view.tsx:167`: `primary={['receive','new']}`. Con filas marcadas, «Nueva compra» (principal desde cc31) baja al menú y «Recibir seleccionadas» pasa a la cabecera, lejos de la tabla donde se marca.
- El pedido dice «uno principal: el que marcó una decisión anterior; si no, la más frecuente». Aquí la decisión anterior es «Nueva compra». El cambio dinámico es defendible, pero es una elección de política no registrada como decisión, y mueve el botón bajo el cursor.
- Corrección: dejar «Nueva compra» siempre principal y «Recibir seleccionadas» en «Más opciones», o registrar la excepción como `D-nnn` y avisar al dueño.
- Si se mantiene, `recibir-seleccionadas-d353.spec.ts:44` sigue verde: el botón es principal mientras haya selección.

### P2-4 — El E2E de D-625 puede dar falso verde y es frágil

`e2e/tests/cabecera-y-ancho-cc47b.spec.ts:55-74`

- Solo mide `documentElement.scrollWidth` en 23 rutas de lista, con la base casi vacía en CI. Una tabla ancha sin filas no desborda, así que la regresión que motivó D-625 (tabla ancha con datos) puede pasar sin detectarse. Tampoco cubre páginas de detalle, el modal de Ventas por material (90 %), «Subtotales por tipo» ni D-624 (cabecera fija y alto de Cobranzas, Inventario, Inventario valorizado y Reporte de bobinas). El pedido pide «comprobar» esas cuatro pantallas y no hay test que lo haga.
- `waitForLoadState('networkidle')` con `.catch` espera hasta 30 s por ruta si la página sondea (`/`, `/planta`, dashboards con `refetchInterval`). 23 rutas × 30 s superan el `setTimeout(300_000)`.
- Corrección: esperar un elemento concreto por ruta (la tabla o el `h1`) en vez de `networkidle`. Añadir un test con datos (el desglose de Ventas por material con ancho `>= 0.85 * viewport` a 1366) y otro que verifique que `Table list` de Cobranzas tiene `maxHeight` fijado y `scrollHeight > clientHeight` con filas.

### P3-1 — Aserciones vacuas en E2E (pasan aunque el código esté mal)

- `cabecera-y-ancho-cc47b.spec.ts:78-82` y `estandar-tablas-cc47.spec.ts:110`: `toHaveCount(0)` de un `link «Descargar…»` antes de abrir el menú. Con el menú cerrado (Radix no monta el contenido), esa aserción pasa siempre. Solo atrapa el caso «descarga como principal», que es lo que se quería, pero la de la línea del buscar (`linea-tabla`) sí sería vacua incluso con la descarga aún en el menú. Aceptable, pero se puede reforzar con `toHaveCount(0)` sobre `getByRole('link', {name:/Descargar/})` en toda la página, no solo en la barra.
- No hay ninguna prueba de que el menú de Mostrador abre y descarga: `documentos-cc32.spec.ts:357` solo comprueba que el botón «Más opciones» es visible. Riesgo bajo, pero es el único caso de `HeaderActions` dentro de un `Dialog` y conviene un clic real.

### P3-2 — Inventario: condición de la descarga distinta de la de las pestañas

- `inventario-view.tsx:59` usa `COIL_BUSINESS_LINES.includes(line) && tableTab === 'bobinas'`. `LinePanel` muestra la pestaña de bobinas también cuando `coils.length > 0` en una línea que no es de bobinas (`showCoils`, `inventario-view.tsx:~125`). En ese caso raro la pestaña existe y no hay Excel (antes sí lo había). Corrección: aceptarlo y documentarlo, o elevar `showCoils`.

### P3-3 — Modales de detalle no ensanchados

- Solo se aplicó `WIDE_DIALOG_CLASSNAME` al desglose de Ventas por material y al historial de precio. Quedan sin ensanchar otros que muestran tablas de lectura: `components/production/close-preview-dialog.tsx:87` («Consumo por bobina»). Los demás con tabla son de operación o de selección (`coil-picker`, `plan-adjust`, `change-line-qty`, `confirm-quotation`, `reactivate-with-order-lines`, `edit-received-purchase`) y es correcto dejarlos. Falta una nota que diga cuáles se evaluaron y por qué.

### P3-4 — Detalle menor

- `WIDE_DIALOG_CLASSNAME` usa `[&>*]:min-w-0`. Es correcto para la grilla del `DialogContent`, pero solo cubre hijos directos. Si un modal envuelve su tabla en varios `div` con `flex`, el desborde sigue dentro del hijo. No se encontró un caso hoy.
- `moreOption` (`e2e/helpers/ui.ts:333-338`) decide con `item.count()` sin esperar: si el menú se abrió en un paso previo y se cierra por animación, hace un clic de más. En la práctica el `Escape` posterior de cada test lo evita.

## E2E tocados: ¿quedan rojos en CI?

Revisión estática, no ejecutados.

- No se encontraron especificaciones que busquen aún `link «Descargar Excel»`, «Excel de pendientes», `a[href=".../receivables/xlsx"]` ni botones movidos («Nuevo color», «Nuevo producto», «Recibir seleccionadas (n)» siguen existiendo como botón único y visible en la cabecera).
- Todas las llamadas nuevas a `moreOption` usan `exact: true`, así que el rótulo con sufijo de Cobranzas no choca con «Descargar Excel».
- Cada uso deja un `Escape` después. El `DropdownMenu` es `modal={false}`, así que el `Escape` lo cierra sin tocar el diálogo.
- Riesgo real de rojo: el test de 23 páginas por timeout (P2-4). El resto no debería ponerse rojo por el montaje diferido del menú, porque `moreOption` abre antes de afirmar.

## Resumen

0 P0, 0 P1, 4 P2 (descargas de plantilla sueltas, rótulos sin pestaña, principal dinámico en Compras, cobertura y fragilidad del E2E nuevo), 4 P3.

## Qué se hizo con cada hallazgo

- **P2-1 (plantillas de los importadores):** corregido. «Descargar plantilla» de precios de lista, y la plantilla y el ejemplo de importar compras, pasan a «Más opciones».
- **P2-2 (rótulo sin pestaña):** corregido. En los reportes con pestañas de línea el rótulo dice la pestaña («Descargar Excel · Drywall», «… · Todas las líneas»), y el ayudante de E2E `moreOption` busca por el comienzo del rótulo.
- **P2-3 (Compras cambia de principal):** queda como decisión registrada (D-626), en el UAT.
- **P2-4 (E2E de ancho):** el recorrido ya no depende de `networkidle` y se sumó la prueba de D-624, que comprueba la lista con el scroll único y la cabecera fija en las seis pantallas con pestañas. La base de la CI tiene pocas filas: la medida a 900 px en local (sin desborde) completa la verificación.
- **Autorrevisión:** «Imprimir» como principal de una cotización cerrada o anulada; comentarios al día; Mostrador sin hueco en el pie. El caso raro de un saldo de bobina en una línea sin bobinas en Inventario y el diálogo de cierre de producción («Consumo por bobina», un diálogo de operación) quedan anotados.
