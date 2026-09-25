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
