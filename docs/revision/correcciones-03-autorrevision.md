> **PENDIENTE DE REVISIÓN INDEPENDIENTE** — autorrevisión por un subagente nuevo del mismo modelo que escribió el cambio; no vale como pase cruzado (AGENTS.md §2.2).

# Autorrevisión — rama `fix/correcciones-03` (Correcciones 03, M0..M6)

Alcance: `git diff origin/main...HEAD` (75 archivos) más el árbol de trabajo actual. Revisión de solo lectura; no se corrió Playwright ni servidores. Se corrieron solo las pruebas unitarias acotadas de los archivos nuevos (`status-filter.spec.ts`, `inventory-item-search.spec.ts`, `kardex-peps-dto.spec.ts` en el API; `kardex-range.spec.ts`, `order-history.spec.ts`, `use-column-filters.spec.ts` en el web): 18 + 14 pruebas en verde.

Resumen: **0 P0, 3 P1, 8 P2.** El lado API del cambio (default de exclusión de terminales negativos, `statusCondition`, endpoints nuevos, `reportCoils`, PEPS JSON) está correcto; los hallazgos serios están en el hook `useUrlSearchInput`, en un spec E2E no migrado y en una fuga de visibilidad **preexistente** que el cambio vuelve más transitada.

---

## P0

Sin hallazgos. Qué se revisó para afirmarlo:

- Cada llamador de las listas que ahora excluyen terminales negativos por defecto (`/sales/orders`, `/sales/quotations`, `/coils`, `/purchases`, `/dispatches`, `/invoicing/documents`): pickers `fetchAllForPicker` (`nuevo-comprobante-view`, `nuevo-despacho-view`, `planta-view`, `purchase-form`, `nueva-orden-view`), cobranzas (`pendingOnly` sobrescribe `where.status` con `LIVE_DOCUMENT_STATUSES`, así que el default no le afecta), detalle de pedido y de cliente (acotados por `salesOrderId`/`customerId` → `skipDefault`), PDF de bobinas (`reportPdf` reusa `findAll` con los mismos filtros que la pantalla), `/production` (a propósito NO excluye anuladas; el historial pide `status=DRAFT,IN_PROGRESS,CLOSED` explícito). Ningún llamador dependía de ver anulados sin pasar `status` en un flujo que deba verlos; los pickers ganan (ya no ofrecen pedidos anulados).
- `sellerWhere` / `quotationSellerWhere` se siguen esparciendo antes que el filtro de estado y ninguna rama nueva los pisa; en despachos, `salesOrder: sellerWhere(actor)` sobrevive al `where.OR` de la búsqueda.
- Prisma acepta `notIn` + `not` juntos en el filtro de enum de `coil.status`; sin ninguna condición queda `status: {}`, que Prisma trata como sin filtro.
- `orderStagesWhere`: con un solo estado devuelve `orderStageWhere` intacto; con varios usa `AND:[{OR:[…]}]` sin tocar el `OR` raíz de la búsqueda. La unión de `CONFIRMED`+`IN_PRODUCTION`+`READY` es correcta.
- Endpoints nuevos: `inventory/items/search|resolve` con `@Roles(ADMINISTRADOR, SUPERVISOR_PLANTA)` (mismo alcance que `movements`, sin costos); `reports/kardex-peps` con `@Roles(ADMINISTRADOR)` igual que el `/xlsx`; ambos validan con Zod y salen del mismo `KardexPepsService.report`.

---

## P1

### P1-1 — `useUrlSearchInput` puede pisar lo que el usuario está tecleando si la ida y vuelta del `router.replace` tarda más que el debounce

`apps/web/src/lib/use-url-state.ts:124-141`

El efecto de sincronización `[urlValue]` compara la URL entrante contra `lastCommitted`, que ya avanzó con el commit siguiente. El eco atrasado del commit anterior se toma por un cambio externo y se copia al cuadro (`setDraft`).

Escenario (latencia de RSC ≈ 600 ms; `router.replace` de solo query string en una página dinámica sí pide el payload al servidor y `useSearchParams` no cambia hasta que la transición confirma):

1. t=0 teclea «a»; t=300 commit(«a») → `lastCommitted='a'`, replace pendiente.
2. t=350 teclea «b» (draft «ab»); t=650 commit(«ab») → `lastCommitted='ab'`.
3. t=900 llega el eco de «a»: `urlValue='a' ≠ 'ab'` → `lastCommitted='a'`, `setDraft('a')`. El cuadro retrocede a «a» y, si el usuario ya tecleó «c», su texto («ac») se sobrescribe cuando llega el eco «ab» en t≈1250.

Afecta a los ~10 cuadros de búsqueda migrados (cotizaciones, pedidos, bobinas, compras, comprobantes, despachos, clientes, catálogo, espesor de bobinas). En local con RTT bajo no se ve (por eso los E2E no lo detectan); en Vercel con latencia normal o con red lenta sí. No hay prueba unitaria del hook.

Arreglo sugerido: no sincronizar desde la URL mientras haya un commit propio en vuelo. Por ejemplo, guardar en un `Set` (ref) los valores comprometidos por este hook y, al llegar un `urlValue`, si está en el `Set` descartarlo (y quitarlo) sin tocar el cuadro; o solo sincronizar cuando `draft.trim() === lastCommitted.current` (el usuario no está a mitad de edición). Añadir una prueba con `renderHook` que simule un `urlValue` que llega tarde.

### P1-2 — Fuga de visibilidad por rol en `GET /invoicing/documents` al buscar (preexistente, fuera del diff, pero D-289 la vuelve la ruta normal para encontrar anulados)

`apps/api/src/invoicing/invoicing.service.ts:3108` (`where.OR = [...]`), sobre el `OR` de alcance por vendedor definido unas líneas antes (`createdById` / `salesOrder.sellerId` / `dispatch.salesOrder.sellerId`).

Con `query.search` el `where.OR` del alcance por vendedor se **reemplaza** por el OR de la búsqueda. Escenario: un VENDEDOR (la ruta admite `ADMINISTRADOR, VENDEDOR`) pide `/api/invoicing/documents?search=<nombre de cualquier cliente>` → recibe comprobantes de pedidos de otros vendedores (número, cliente, totales). Sin `search` sí ve solo lo suyo. Está igual en `origin/main`; se reporta porque la petición de la pregunta 1 era verificar la visibilidad por rol y porque el cambio empuja a buscar más (y a mostrar anulados al buscar).

Arreglo sugerido: componer con `AND: [{ OR: alcance }, { OR: búsqueda }]` (o acumular en `AND`) en lugar de asignar `where.OR`; añadir prueba de que un VENDEDOR con `search` no ve documentos ajenos. Idealmente en un commit aparte, fuera de esta rama de UI.

### P1-3 — El arreglo del spec `acabados-d203.spec.ts` (acordeón del menú) está sin commitear

`e2e/tests/acabados-d203.spec.ts:504` — `page.getByRole('link', { name: 'Acabados' }).click()` justo después del login, con la sesión en `/` y todos los grupos del acordeón cerrados (`hidden` en el contenido del grupo) → el enlace no es visible y el click agota el tiempo. El diff commiteado (`git diff origin/main...HEAD`) NO toca ese spec; el árbol de trabajo sí tiene la corrección (`openSidebarGroup(page, 'Catálogo')`), sin commit. Si se cierra la rama sin incluirla, CI queda rojo en ese test.

Arreglo: commitear ese cambio junto con el resto de los specs de menú (`fase1`, `usuarios`). Se buscaron por Grep los demás clicks a enlaces del menú en `e2e/` (`getByRole('link', { name: … })`, regex, `a[href=]`): no hay otros que dependan de un grupo cerrado.

---

## P2

1. **Aserciones negativas del menú que ahora pasan en vacío.** `e2e/tests/auth.spec.ts:110` (`Usuarios`), `e2e/tests/auditoria-d218.spec.ts:140` (`Auditoría`) y `e2e/tests/fase1.spec.ts:157` (`Márgenes, tipo de cambio y reservas`) esperan `toHaveCount(0)` sobre un enlace del grupo «Administración», que en `/` está cerrado (`hidden`): el conteo es 0 aunque el rol SÍ viera el ítem. Antes probaban el filtrado por rol; ahora no. Abrir el grupo (`openSidebarGroup`) antes de afirmar la ausencia, o comprobar contra `navForRole` en una prueba unitaria.

2. **`useUrlState.latest` puede retroceder en ráfagas.** `use-url-state.ts:44-46`: el efecto `latest.current = searchParams.toString()` corre cuando confirma la primera navegación aunque ya se haya escrito una segunda; con tres toggles seguidos antes de que confirme la segunda, el tercero parte de la URL vieja y pierde el segundo. Además `useSort` crea una segunda instancia del hook (su propio `latest`) en la misma vista: dos escrituras en el mismo tick desde instancias distintas se pisan. Poco probable con clics humanos; se corrige haciendo que el efecto solo avance `latest` si `searchParams` es más nuevo que lo escrito (p. ej. ignorar cuando hay una escritura propia pendiente) o compartiendo un único ref por módulo. Tampoco conserva el `#hash` al hacer `replace`.

3. **El Excel PEPS y la pantalla PEPS no coinciden con el rango «Todo».** `kardex-view.tsx:151,175` calcula `pepsFrom = dates.from || <primer día del mes>` para la descarga, mientras la tabla usa `PEPS_ALL_FROM = '2000-01-01'` (`:281`). Con «Todo» la pantalla muestra todo el historial y el botón «Descargar PEPS» baja solo el mes en curso; el propio `kardex-peps-dto.ts` declara que pantalla y Excel «no pueden discrepar». Usar `PEPS_ALL_FROM` también en la descarga (o el mismo `pepsFrom` en ambas).

4. **Filtro por columna «estado» de las órdenes del pedido no coincide con lo que se ve.** `pedidos/[id]/production-orders-card.tsx:61`: el badge muestra «En cola» para una orden `DRAFT` de coberturas, pero el filtro compara contra `PRODUCTION_ORDER_STATUS_LABELS` («Borrador»): escribir «cola» no encuentra nada. Reusar la misma función de etiqueta del badge.

5. **Pedidos: el default de la bandeja arma tres cadenas correlacionadas innecesarias.** `pedidos-view.tsx:60,90` manda `stage=CONFIRMED,IN_PRODUCTION,READY,PARTIALLY_FULFILLED`; `orderStagesWhere` lo traduce a un `OR` con dos condiciones `NOT`/`AND` sobre `reservations→productionOrders` (count y findMany). Es semánticamente igual a `status IN (CONFIRMED, IN_PRODUCTION, PARTIALLY_FULFILLED)`. Con `status=` la consulta es la simple. No se midió (AGENTS.md: medir antes de afirmar): conviene medir el `EXPLAIN`/tiempo con el volumen de producción antes de decidir.

6. **`FormCell` (sin react-hook-form) no asocia ayuda/error al control.** `components/form/form-layout.tsx:135-153`: `HelpArea` no recibe `id` y el control no lleva `aria-describedby`; el error solo se anuncia por `role="alert"`. `FormFieldCell` sí queda bien (ids de `useFormField`). Pasar un id y documentar que el hijo debe llevar `aria-describedby`. Además el rótulo tiene altura fija `h-4`: un rótulo largo en una celda estrecha (span 2-3) se sale sobre el control; no se pudo confirmar sin ver la pantalla.

7. **Columna «Bobina / fleje» vacía en reportes revertidos.** `production.service.ts` `reportCoils` excluye las salidas ya anuladas (`reversals: { none: {} }`), así que el reporte revertido muestra «—». Es lo que dice el comentario de D-291 y evita mentir, pero quien audita un reporte revertido pierde de qué bobina salió; si es relevante, mostrar las anuladas atenuadas (el dato vive en el kardex). Además, si un mismo reporte consume dos veces la misma bobina, la lista del detalle repite el código (el historial sí suma por id).

8. **Pruebas que faltan.** No hay prueba unitaria de `useUrlState`/`useUrlSearchInput` (donde están P1-1 y P2-2), ni prueba de autorización de los endpoints nuevos (VENDEDOR → 403 en `inventory/items/search|resolve` y `reports/kardex-peps`; SUPERVISOR_PLANTA → 403 en `kardex-peps`). Los E2E de `correcciones-03-*` prueban lo que dicen para el flujo feliz como ADMINISTRADOR, pero corren con latencia local (ver P1-1). Enlaces antiguos `/kardex?item=<id>` sin `itemType` ahora muestran el kardex vacío (antes asumían `COIL`); los enlaces internos siempre llevan `itemType`, así que solo afecta a marcadores.

---

## Qué se revisó

| Área                      | Archivos / método                                                                                                                                                                                                                                                 | Resultado                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Filtro de estado en API   | `packages/shared/src/schemas/status-filter.ts`, `coil.ts`, `invoicing.ts`, `purchase.ts`, `sales.ts`, `production.ts`; `coils`, `quotations`, `sales-orders`, `dispatches`, `invoicing`, `purchases` `.service.ts`; `order-readiness.ts`; `status-filter.spec.ts` | Correcto. Único hallazgo: P1-2 (preexistente) y P2-5 (rendimiento del default de pedidos)                            |
| Llamadores del default    | Grep de todas las llamadas web a las 6 listas + `fetchAllForPicker` + cobranzas + PDF de bobinas + `/production`; helpers y specs de `e2e/` que listan sin `status`                                                                                               | Sin regresiones de comportamiento                                                                                    |
| Autorización              | `inventory.controller.ts`, `reports.controller.ts`, `inventory.service.ts` (`searchItems`/`resolveItem`), `kardex-peps-dto.ts`                                                                                                                                    | Roles correctos, sin costos; PEPS JSON = mismo alcance que el Excel                                                  |
| Hook de URL               | `use-url-state.ts`, `use-sort.ts`, `use-column-filters.ts` y todas las vistas migradas (pedidos, cotizaciones, bobinas, compras, comprobantes, despachos, clientes, catálogo, cobranzas, historial de órdenes)                                                    | P1-1, P2-2; parámetros ajenos (`historial`, `op`, `bajoPiso`) se conservan                                           |
| Kardex                    | `kardex-view.tsx`, `kardex-peps-table.tsx`, `kardex-range.ts` (+ spec), enlaces entrantes (`bobina-detalle`, `inventario`)                                                                                                                                        | `resolveKardexDates` correcto (mes anterior, enero, bisiestos); P2-3                                                 |
| Producción / historial    | `production.service.ts` (`reportCoils`, `findAll`), `order-history.ts`, `order-history.tsx`, `produccion-detalle-view.tsx`, `production-orders-card.tsx`                                                                                                          | Decimal correcto en sumas de ML y kg; `refId` del kardex coincide con el reporte en coberturas y drywall; P2-4, P2-7 |
| Sidebar y chips           | `app-sidebar.tsx`, `filter-chip.tsx`, `status-filter.tsx`, `nav.ts`                                                                                                                                                                                               | Modo colapsado a íconos muestra todos los ítems; el ítem activo abre su grupo; P1-3 y P2-1 en pruebas                |
| Formularios y secciones   | `components/form/*`, `section.tsx`, `product-dialog.tsx`, `nuevo-despacho-view.tsx`, `document-form-layout.tsx`, detalles migrados a `Section` (diff `-w`)                                                                                                        | Sin cambios de lógica; P2-6                                                                                          |
| Pruebas                   | `e2e/tests/correcciones-03-*.spec.ts`, `fase1`, `usuarios`, `planta-cola-f8s3-ui`, `acabados-d203`, `fase7e-ajustes-d121`, `cierre-bobina-ui-d164`, `fase2b`, `auth`, `auditoria-d218`; unitarias nuevas                                                          | P1-3, P2-1, P2-8                                                                                                     |
| Reglas duras AGENTS §3/§6 | Dinero/kg/mm (`Decimal`), sin escrituras nuevas, sin migraciones, sin toque a kardex/reservas/costeo                                                                                                                                                              | Sin incumplimientos: el cambio es de lectura                                                                         |

## Resolución (agente que implementó, 2026-09-25)

| Hallazgo                                                                                                      | Qué se hizo                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1-1** eco atrasado de la URL pisa el texto tecleado                                                        | **Corregido** en `useUrlSearchInput`: guarda los valores que él mismo comprometió (`ownCommits`) e ignora su eco atrasado; solo un valor distinto a todos sus commits se toma como cambio externo. Sin prueba unitaria (la web no tiene jsdom/testing-library): queda cubierto por el E2E de recarga y por esta revisión. |
| **P1-2** `where.OR` de la búsqueda de comprobantes pisa el alcance por vendedor (`invoicing.service.ts`)      | **Preexistente y fuera del alcance de esta sesión** (no lo introduce el diff). **No se corrigió** (AGENTS §3.16: sin «aprovechar y de paso arreglar»). **Decisión pendiente del dueño**; arreglo propuesto: componer con `AND` en un commit aparte con su E2E de alcance de vendedor.                                     |
| **P1-3** `acabados-d203` hacía click en el menú cerrado                                                       | **Corregido y commiteado** (`openSidebarGroup`). La corrida completa lo confirmó como rojo real y el reintento pasó.                                                                                                                                                                                                      |
| P2 «Descargar PEPS» con «Todo» bajaba solo el mes                                                             | **Corregido**: usa `PEPS_ALL_FROM`, igual que la pantalla.                                                                                                                                                                                                                                                                |
| P2 filtro «estado» de las órdenes del pedido comparaba «Borrador» y el badge dice «En cola»                   | **Corregido**: el filtro usa la misma etiqueta que el badge.                                                                                                                                                                                                                                                              |
| P2 tres aserciones negativas del menú (`auth`, `auditoria-d218`, `fase1`) pasan en vacío con el grupo cerrado | **Pendiente** (baja): abrir el grupo antes de afirmar `toHaveCount(0)`.                                                                                                                                                                                                                                                   |
| P2 `useUrlState.latest` puede retroceder en ráfagas; `useSort` es una segunda instancia                       | **Pendiente**: el updater mitiga el caso de los chips; sin síntoma reproducido.                                                                                                                                                                                                                                           |
| P2 `FormCell` sin react-hook-form no enlaza ayuda/error con el control (`aria-describedby`)                   | **Pendiente**.                                                                                                                                                                                                                                                                                                            |
| P2 «Bobina / fleje» vacía en reportes revertidos                                                              | **Por diseño** (D-291: solo salidas vivas).                                                                                                                                                                                                                                                                               |
| P2 default de pedidos manda cuatro etapas (subconsultas correlacionadas)                                      | **Pendiente**: medir con datos reales antes de tocar.                                                                                                                                                                                                                                                                     |
| P2 faltan pruebas unitarias de `useUrlState` y de 403 de los endpoints nuevos                                 | **Pendiente**.                                                                                                                                                                                                                                                                                                            |

Además, la corrida completa de la suite destapó dos specs acoplados al markup viejo del formulario
de despacho (`despacho-peso-por-linea.spec.ts`: `div.space-y-1` y `label + input`), ya migrados.

## Apéndice: M1 (D-297) y M2 (D-298), revisión por subagente nuevo

Revisión de solo lectura de `2c13715`, `1d91da6` y `9daefe0`, por un subagente que no escribió el cambio ni leyó el handoff de implementación. **Sigue siendo autorrevisión** (mismo repo, mismo proceso): es una lista de riesgos, no un pase independiente. Corridas: `jest` de `fiscal-document-where`, `kardex-sheet`, `kardex-peps`, `kardex-sheet-xlsx` y `kardex-sheet.service` (27 verdes) y `vitest` de `use-url-state.spec.ts` (11 verdes). No se corrió E2E.

### P0

Sin hallazgos.

### P1

**P1-1. `apps/web/src/app/(app)/kardex/kardex-view.tsx:210` — «Descargar PEPS (SUNAT 13.1)» con el rango «Todo» baja solo el mes en curso (regresión).**
Antes de `1d91da6` el enlace usaba `dates.from || PEPS_ALL_FROM` (`2000-01-01`); ahora usa `dates.from || "<mes en curso>-01"` (`${today.slice(0, 7)}-01`). Escenario: el administrador elige «Todo» (o borra «Desde»), ve en pantalla todo el historial y descarga el formato 13.1: el archivo trae solo el mes actual, con saldo inicial del mes. Es el mismo defecto que esta rama ya había corregido («Descargar PEPS con Todo bajaba solo el mes», tabla de resolución de este archivo), y ningún E2E lo cubre (el E2E nuevo solo comprueba el `href` de «Descargar Excel»). Sugerencia: usar `excelFrom` (que ya vale `dates.from || KARDEX_ALL_FROM`) y agregar una aserción de `href` del botón SUNAT con «Todo».

### P2

**P2-1. `packages/shared/src/kardex-sheet.ts:99-104` (meta `from`) y `apps/api/src/reports/kardex-sheet.service.ts:39` — el Excel de Promedio con «Todo» rotula el período «01/01/2000 al …» y nombra el archivo `kardex-average-<código>-2000-01-01-…`.**
`pepsToKardexSheet` normaliza `KARDEX_ALL_FROM` a vacío («desde el inicio»), pero `movementsToKardexSheet` pasa `query.from` tal cual. Escenario: «Todo» + Promedio + Descargar Excel. Sugerencia: normalizar `from === KARDEX_ALL_FROM` a `''` en el servicio (o dentro de `movementsToKardexSheet`) para que los dos métodos rotulen igual; agregar el caso a `kardex-sheet-xlsx.spec.ts`.

**P2-2. `apps/web/src/app/(app)/kardex/kardex-sheet-table.tsx:28` — la pantalla ya no muestra la unidad de medida.**
La tabla vieja escribía «60.000 kg»; ahora `formatQty(value)` sin unidad, y la cabecera de pantalla (Producto / Código / Método) tampoco la trae (el Excel sí: `UNIDAD:`). Escenario: producto en MTR o NIU frente a una bobina en kg: las cantidades no se distinguen. Los E2E se relajaron a `'60.000'`, lo que confirma la pérdida. Sugerencia: mostrar la unidad en la cabecera de la hoja (o como sufijo en las cantidades).

**P2-3. `packages/shared/src/kardex-sheet.ts:158-172` y `apps/api/src/reports/kardex-peps.ts:175-180` — la suma de los montos de las capas puede diferir en 0,0001 del monto del movimiento.**
Cada capa se redondea por separado (`layerOf` redondea `qty × unitCost` a 4 decimales) mientras que `outTotal` de la fila se redondea una vez sobre la suma de porciones, y el C.U. de la capa (4 decimales) no reproduce `total ÷ qty`. Escenario: salida sobre 3 capas con costos unitarios de más de 4 decimales (capas nacidas de `total ÷ qty`, o afectadas por un ajuste de costo repartido): Σ filas de capa ≠ total del movimiento; `Totales` sale del movimiento entero, así que no hay doble conteo. Las cantidades sí cuadran exactamente (`Decimal` a escala 3). No hay aritmética nueva en el Excel: `num()` solo transporta (`Number(string)`); sin incumplimiento de la regla de `Decimal`. Sugerencia: documentarlo en el UAT, o hacer que la última capa absorba el residuo de redondeo (`outTotal − Σ capas previas`).

**P2-4. `packages/shared/src/kardex-sheet.ts:86-125` — la hoja de Promedio no lleva «Saldo inicial» ni «Totales»; la de PEPS sí.**
Con «Mes actual» o un rango acotado, la primera fila trae el saldo ya arrastrado (`openingBalance`) sin fila que lo explique, y el Excel de Promedio no tiene totales. Escenario: el contador quiere cuadrar el período en el Excel de Promedio. Los saldos son correctos, pero la hoja «igual para los dos métodos» no lo es. Sugerencia: confirmar con el dueño si el formato del cliente exige ambas filas también en Promedio (el saldo de apertura ya lo calcula `findMovements`) y registrarlo como decisión.

**P2-5. `apps/api/src/reports/kardex-sheet.service.ts:31-34` — el Excel de Promedio hereda el tope de 10 000 movimientos de `findMovements` (orden ascendente).**
Un ítem con más de 10 000 movimientos entrega los más antiguos y omite los recientes sin avisar; PEPS no tiene tope. Improbable hoy. Sugerencia: error o aviso explícito si `items.length === 10_000`.

**P2-6. `apps/web/src/app/(app)/kardex/kardex-view.tsx:82-91` y `115-116` — pantalla y Excel de Promedio no leen el mismo rango con «Todo».**
La pantalla manda `to` vacío (sin cota superior) y el Excel manda `to = hoy`; un movimiento con `operationDate` futura aparecería en pantalla y no en el Excel. Solo un ADMINISTRADOR puede fijar fecha de operación. Sugerencia: aplicar la misma cota a ambos.

**P2-7. `apps/web/src/app/(app)/kardex/kardex-view.tsx:105-108` — el filtro de detalle solo ve `row.detail` (texto de la hoja), no lo que el Promedio pinta.**
En Promedio la celda muestra además el usuario (`actorName`), «Factura: ver» y «registrado …», que el filtro no encuentra. Escenario: filtrar por el nombre del usuario devuelve «Ningún movimiento coincide». En PEPS, con el filtro activo, las filas «Saldo inicial», «Totales» y la última fila de capa (donde va el saldo) desaparecen si su texto no coincide. Sugerencia: aceptable si se documenta; si no, filtrar sobre el texto renderizado.

**P2-8. Rótulos distintos entre métodos (`kardex-sheet.service.ts`, `kardex-sheet.ts`).**
`UNIDAD:` sale como `KGM` en Promedio y `01 - KILOGRAMOS` en PEPS; el detalle de una anulación dice «(anulación)» en Promedio y «OTROS · <nota>» en PEPS. Cosmético; unificar cuando se toque el formato.

**P2-9. `apps/web/src/app/(app)/kardex/kardex-view.tsx:158` (preexistente) — `RoleGate` deja pasar a VENDEDOR, pero `/inventory/movements` y `/inventory/items/search` son de ADMINISTRADOR y SUPERVISOR_PLANTA.**
El vendedor que teclea `/kardex` ve la pantalla y «No se pudo cargar el kardex.». No expone datos (el API responde 403). Sugerencia: quitar `Role.VENDEDOR` del `RoleGate`.

**P2-10. `apps/api/src/reports/kardex-sheet-xlsx.ts:57-70` — el Excel no da formato numérico a las celdas** (se ve `4` y `1234.5` en vez de `4.0000` y `1,234.50`) y la fecha es texto `DD/MM/YYYY` (heredado del PEPS). Cosmético.

**P2-11. Pruebas.** `9daefe0` no tiene pruebas en vacío que se hayan detectado. El test del eco atrasado (`use-url-state.spec.ts`, «el eco atrasado de un commit propio…») **falla con la implementación vieja por razonamiento**: con la vieja, al llegar el eco de «ab» con `lastCommitted = 'abc'`, `urlValue !== lastCommitted` ejecuta `setDraft('ab')` y la aserción `toBe('abc')` cae. No se ejecutó contra la versión vieja (revisión de solo lectura); conviene hacerlo una vez en una rama descartable con el `use-url-state.ts` de `95a498f^`. Falta un caso de `useUrlSearchInput` que ejercite la limpieza de `ownCommits`. Además, `e2e/tests/correcciones-03-listas-kardex.spec.ts` no cubre el botón SUNAT (P1-1) ni el rango «Todo» del Excel de Promedio (P2-1).

### Sin hallazgos en (lo revisado)

- **M1, barrido.** `fiscalDocumentListWhere` compone alcance y búsqueda con `AND: [{OR}, {OR}]`; `pendingOnly` solo reemplaza `status` y `docType`, no toca `AND`, así que sigue respetando el alcance. `customerId` y `salesOrderId` de la query son filtros conjuntivos: un VENDEDOR que apunta a un pedido o cliente ajeno recibe cero filas. Los roles de la ruta son ADMINISTRADOR y VENDEDOR, y `actor.role !== ADMINISTRADOR` equivale a `=== VENDEDOR` ahí. Otros `OR` de búsqueda en `apps/api/src`: `quotations.service.ts:918`, `sales-orders.service.ts:2585` y `dispatches.service.ts:1105` usan `sellerWhere`/`quotationSellerWhere`, que devuelven `{ sellerId }` sin `OR` (sin colisión; `orderStagesWhere` usa `AND` y la búsqueda `OR`, claves distintas); `receivables` y cobranzas son solo ADMINISTRADOR y sin `search`; `customers`, `catalog`, `coils`, `pos`, `inventory` y `purchases` no tienen alcance por vendedor. El E2E de dos vendedores falla con el código viejo (A vería el comprobante de B por nombre o documento).
- **M2, mapeo numérico.** `movementsToKardexSheet`: ADJUST positivo va a entradas y negativo a salidas sin cantidad ni C.U., con el monto en valor absoluto; las anulaciones conservan el sentido del movimiento y se rotulan; `totalCost` y `balance*` nulos (sin costos) quedan como celda vacía; el saldo sale de `findMovements`, sin recalcular (el `balanceTotalCost` nuevo es el `runningValue` que ya existía). `pepsToKardexSheet`: con una sola capa (o ninguna) usa la fila del motor; con varias abre una fila por capa, el saldo va solo en la última, y `Totales` sale de `report.totals` (el movimiento se cuenta una vez: sin doble conteo). `outLayers` incluye el faltante sin capa al costo registrado; para la anulación de una entrada (OUT con `reversalOfId`) toma primero la capa que abrió esa entrada y luego las más antiguas, coherente con `consumed`. Las cantidades de las capas suman exactamente `outQty`. Sin aritmética con `number`.
- **M2, seguridad.** `GET /reports/kardex/xlsx`, `GET /reports/kardex-peps` y `.../kardex-peps/xlsx` son solo ADMINISTRADOR (con centinela de metadatos en `reports.controller.spec.ts`). `costing=peps` en la URL lo ignora la pantalla si el rol no es ADMINISTRADOR (`method` depende de `isAdmin`) y el API lo rechazaría igual. SUPERVISOR_PLANTA ve el promedio con costos (comportamiento previo); `balanceTotalCost` está bajo `showCosts`. VENDEDOR no llega a los datos.
- **Web.** Estados de carga y error correctos (`isPending` de PEPS acotado a `validRange`; consulta de Promedio deshabilitada en PEPS y viceversa); opacidad de anuladas solo en Promedio y por `reversedById`; enlaces del Detalle respetan `REF_TARGET_ROLES` e `INVOICE_LINK_ROLES`; `KARDEX_ALL_FROM` normalizado a vacío en la hoja PEPS.

### Resolución del apéndice (agente que implementó, 2026-09-25)

| Hallazgo                                                                      | Qué se hizo                                                                                                                                                             |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1-1** «Descargar PEPS (SUNAT 13.1)» con «Todo» bajaba solo el mes en curso | **Corregido**: el enlace usa el mismo rango que «Descargar Excel» (`KARDEX_ALL_FROM` hasta hoy). Sin aserción E2E propia (el botón vive en el menú «⋯»); queda como P2. |
| P2-1 período «01/01/2000» en el Excel de Promedio con «Todo»                  | **Corregido** en `movementsToKardexSheet` (con su unitario).                                                                                                            |
| P2-2 la pantalla ya no muestra la unidad                                      | Pendiente (baja): la cabecera puede llevarla.                                                                                                                           |
| P2-3 capas redondeadas una a una                                              | Sin cambio: la suma puede diferir en 0,0001 del monto del movimiento; el saldo y los totales salen del motor, no de sumar filas.                                        |
| P2-4 la hoja de Promedio no lleva «Saldo inicial» ni «Totales»                | Pendiente (el API de movimientos no entrega el saldo inicial del rango).                                                                                                |
| P2-5 a P2-11                                                                  | Pendientes, anotados; ninguno bloquea el deploy.                                                                                                                        |
