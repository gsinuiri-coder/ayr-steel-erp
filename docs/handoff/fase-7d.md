# Handoff — Fase 7d, pulido UI/UX pre-entrega al cliente — 2026-09-06

## 1. Resumen

Fase de pulido, no de features: la app queda presentable y operable para UAT con el cliente,
sin tocar dominio ni schema salvo lo estrictamente listado. Cuatro decisiones nuevas,
**D-112..D-115** (la última, un pedido del dueño después del cierre inicial: revertir el
contenedor de scroll interno de tabla).

Cuatro tareas: **fechas** (el pendiente de nueve pantallas que dejó la Sesión M-4, más un
décimo hallazgo nuevo), **paginación server-side** en las diez tablas que crecen sin techo,
**tablas con encabezado fijo** (el contenedor de scroll interno se revirtió — D-115) y
**afordancia de link unificada**, y un **barrido general** de estados vacíos, loading, errores
y viewport móvil.

Estado: `pnpm turbo lint typecheck test build` en verde; E2E local verde (suites existentes
reparadas + 3 nuevos). **Deployado y verificado contra producción real**: 119/119 E2E en
producción (38 saltados por D-081), purga corrida — ver §4 para el detalle, incluido un
residuo estructural no bloqueante (ventas y mermas ya hechas que el append-only no permite
deshacer sin una reversa de dominio nueva, fuera de alcance de esta fase).

## 2. Hecho

### Fechas (D-112)

Las nueve pantallas anotadas en la Sesión M-4 (`despacho-detalle-view.tsx` ×2 sitios,
`pedido-detalle-view.tsx` ×2, `cotizacion-detalle-view.tsx`, `corte-view.tsx`,
`produccion-view.tsx`, `produccion-detalle-view.tsx`, `bobina-detalle-view.tsx`) cortaban un
timestamp con `.slice(0, 10)`, que lo lee en UTC — Lima va cinco horas detrás, así que lo
ocurrido después de las 19:00 locales se mostraba fechado al día siguiente. Las nueve pasan a
`formatTimestampDate` (zona `America/Lima`, ya existía desde la corrección de comprobantes).

Un décimo sitio, no listado en M-4 porque ahí el timestamp cortado no se mostraba sino que se
usaba como valor por defecto de un formulario: `tipo-cambio-view.tsx` ofrecía registrar el
tipo de cambio de "hoy" con `new Date().toISOString().slice(0, 10)`, y después de las 19:00
"hoy" ya era mañana en UTC. Corregido con `businessToday()` de `@ayr/shared`.

Regla ESLint nueva (`packages/eslint-config/next.mjs`, `no-restricted-syntax`) que bloquea
`x.algoAt.slice(0, 10)` y `toISOString().slice(0, 10)` de acá en adelante, con el mensaje de
qué usar en su lugar — para que este defecto no vuelva a aparecer pantalla por pantalla.

### Paginación server-side (D-113)

10 endpoints envueltos en `PaginatedResult<T> = { items, total, page, pageSize }`
(`packages/shared/src/schemas/pagination.ts` centraliza el contrato): `/customers`, `/coils`,
`/sales/orders`, `/sales/quotations`, `/dispatches`, `/purchases`, `/invoicing/documents`,
`/invoicing/receivables` (+ `/invoicing/receivables/summary` **nuevo**, totales agregados para
las tarjetas de resumen de /cobranzas, que de otro modo solo hubieran sumado la página visible),
`/inventory/movements` (modo mezclado), `/imports`.

Patrón: `page`/`pageSize` 1-based en el query, `page` con tope `MAX_PAGE=10_000` y `pageSize`
con tope `MAX_PAGE_SIZE=200` (el segundo ya estaba, el primero lo agregó la auditoría de
seguridad — ver §3). Tres filtros derivados (`pendingOnly` en comprobantes, `onlyWithBalance`
en compras, `receivables()` entero) no se pueden expresar en SQL sin duplicar la fórmula del
saldo (D-075): usan `paginateInMemory` + `DERIVED_FILTER_FETCH_CAP=5000` — SQL acota por lo
que sí es columna, se trae hasta 5000 filas, se filtra y pagina en memoria. Cuatro selectores
tipo autocompletado (cliente en venta/mostrador, pedidos facturables/despachables, compras de
bobina vinculables, bobinas abiertas para orden de corte) usan `fetchAllForPicker` (pide
`pageSize=200`, no pagina de verdad). El kardex de un ítem (`itemId` en la query) tampoco
pagina — necesita el historial completo para el saldo corrido.

Web: hook `usePagination` + componente `<PaginationBar>` (página/tamaño, "Mostrando X–Y de Z")
en las 10 vistas correspondientes. Se descartó adoptar `@tanstack/react-table` (declarada sin
usar) por el riesgo de reescribir diez tablas ya probadas justo antes de la entrega.

### Tablas: encabezado fijo, columnas responsive (revertido el contenedor de scroll — D-115)

Se implementó `<TableScrollArea>` (max-height 55vh + scroll interno) en las tablas de listado,
en el preview de importación (`import-dialog.tsx`) y en el picker de bobinas de una nueva
orden de corte. **El dueño pidió revertirlo antes del deploy** (desaprovechaba espacio de
pantalla): las 30 vistas vuelven a `<div className="rounded-lg border">` sin tope de alto, y
el componente `TableScrollArea` se borró. El encabezado `<TableHeader className="sticky top-0
z-10 bg-background">` **se mantuvo** — sigue funcionando sin el contenedor de scroll propio
(se pega al techo del viewport en vez de al de un contenedor propio). Columnas secundarias con
`hidden md:table-cell` / `lg:table-cell` / `sm:table-cell` en las tablas más anchas (bobinas 10
columnas, despachos, compras, comprobantes, kardex, cobranzas, pedidos, cotizaciones,
clientes) quedaron intactas — no dependían del contenedor.

Siete tablas Card-envueltas se habían revisado y dejado sin el tratamiento de scroll interno a
propósito (acotadas por regla de negocio, no por volumen); con el revert esa distinción ya no
aplica — ninguna tabla lleva contenedor de scroll ahora.

### Afordancia de link unificada (D-114)

`LINK_CLASSNAME` (`apps/web/src/lib/utils.ts`): `text-primary underline-offset-4
hover:underline`, la misma combinación que ya trae `variant="link"` de `Button`/`Badge`.
Reemplaza ~50 sitios que tenían tres variantes distintas escritas a mano (subrayado solo al
pasar el mouse sin color, subrayado fijo sin color, o un `<button>`/`<Link>` con `underline`
a secas) — en una tabla con texto plano al lado, un link que no cambia de color no se
distinguía de una etiqueta hasta que el usuario ya estaba encima con el mouse.

### Barrido general

Loading (`Skeleton`) y estados vacíos con mensaje ya eran consistentes en casi toda la app; se
agregó el estado vacío que faltaba en `margenes-view.tsx`. Los mensajes de error de dominio ya
seguían el patrón `err instanceof ApiError ? err.message : 'mensaje genérico'` de forma
consistente — el detalle técnico de un error no controlado nunca llega a la UI. Títulos de
página consistentes (`text-2xl font-semibold` en las 46 vistas revisadas). `/planta` y `/pos`
verificados en un viewport de 375px real (Playwright headless + captura, login vía API sin
exponer credenciales en el proceso): sin overflow horizontal, botones e inputs a ancho
completo, estados vacíos legibles. El badge "N" de Next.js dev que aparece en las capturas es
del modo desarrollo, no de producción.

**Breadcrumbs: no existen en la app, y no se construyeron en esta fase.** Sería una feature
nueva (navegación jerárquica), fuera del alcance explícito de "pulido, no features". La app
depende de un sidebar persistente que cubre bien el caso de escritorio; una vista de detalle
en móvil con el sidebar colapsado se queda sin más "volver a la lista" que el botón atrás del
navegador. Queda anotado para Fase 8 si se decide agregar un link "← Volver" liviano en las
vistas de detalle — no un sistema de breadcrumbs completo.

## 3. Decisiones tomadas

- **D-112** — Toda fecha de un timestamp en el web pasa por `formatTimestampDate`, nunca por
  `slice(0, 10)` sobre el ISO. Lint que lo hace cumplir.
- **D-113** — Paginación server-side `page`/`pageSize` envuelta en `PaginatedResult<T>`, con
  el patrón híbrido para filtros derivados y `fetchAllForPicker` para selectores. Detalle
  largo (con las alternativas descartadas) en `docs/DECISIONES.md`.
- **D-114** — Afordancia de link en una sola constante (`LINK_CLASSNAME`), no caso por caso.
- **D-115** — Revertido el contenedor de scroll interno de tabla (pedido del dueño); queda el
  encabezado `sticky`, la paginación y las columnas responsive.

## 4. Deploy y verificación en producción

### Incidente: `e2e:prod` corrido antes de deployar (resuelto, sin efecto en el resultado final)

Antes del deploy real, se corrió `pnpm e2e:prod` una primera vez por error de secuencia
(cada fase anterior de esta bitácora deploya y recién después corre E2E contra producción; esa
vez se invirtió el orden). Contra la API vieja (sin `PaginatedResult`), el helper nuevo de E2E
`getItems` (que hace `.items` sobre la respuesta) leía `.items` de un array plano y devolvía
`undefined`: 64 de 155 pruebas fallaron en cascada con `TypeError`. No era un defecto del
código de esta fase — era incompatibilidad esperada entre E2E nuevos y API vieja.

La corrida sí alcanzó a crear datos reales en producción antes de fallar. Se detectó que la
prueba de paginación de clientes en `fase7d.spec.ts` no tenía limpieza para producción (las
otras dos sí, vía `deactivateTrail`) — corregido agregando soporte de `customerIds` a
`deactivateTrail` (`e2e/helpers/production.ts`) y el `finally` correspondiente en el test. Se
purgó lo creado antes de continuar.

### Deploy real

Con el revert de D-115 ya commiteado y con CI verde en ambos pushes (`f52f37e` y `3eef29a`):

- `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app` → mismo servicio Cloud
  Run de siempre, `/health` en verde.
- `pnpm deploy:web` **falló** (`403 invalidToken`): el token del CLI de Vercel venció, el mismo
  bloqueo ya documentado en `docs/handoff/fase-7.md`. No importó: el proyecto Vercel está
  ligado al repo de GitHub, así que cada push a `main` ya dispara su propio deploy —
  confirmado con `gh api repos/.../commits/3eef29a.../status` (`Vercel` → `success`,
  "Deployment has completed") y con el web respondiendo 200 en `/login`. El dueño sigue
  teniendo pendiente un `vercel login` para dejar `pnpm deploy:web` operativo fuera de un push
  (ver `docs/handoff/fase-7.md` §4), pero no bloquea nada de esta fase.

### `pnpm e2e:prod` real, contra el código de esta fase

**119/119 pruebas pasaron** (38 saltadas por la compuerta de D-081, cero fallidas), incluidas
las 3 de `fase7d.spec.ts`. Es la corrida que de verdad prueba esta fase — la anterior había
probado código viejo.

### Purga y residuo final (no bloqueante, explicado)

Por primera vez la suite entera llegó al final sin que nada la cortara antes, y expuso un tipo
de residuo que ninguna corrida parcial anterior había llegado a crear: dos órdenes de
producción con planchas ya vendidas (movimiento `OUT SALE`) y dos recepciones de corte con
flejes ya mermados (movimiento `SCRAP`). `pnpm prod:purge-e2e` (corrido dos veces; la segunda
terminó de limpiar clientes, proveedores, productos y las órdenes de corte pendientes que la
primera pasada había dejado a medias) **no pudo revertirlas**, con el mismo mensaje que le
daría a un administrador desde la UI: _"ya se movieron (OUT SALE/SCRAP): anula ese movimiento
antes"_. No es un defecto de la purga ni de esta fase — es §3.2 (append-only) funcionando
exactamente como debe: vender o mermar algo no se deshace sin revertir esa venta o esa merma
primero, y escribir esa reversa nueva sería un cambio de dominio, fuera del alcance de esta
fase de pulido.

Residuo final, confirmado con `node scripts/prod-e2e-leftovers.mjs`:

- 2 órdenes de producción (`OP-000319`, `OP-000320`) y 2 recepciones de corte, bloqueadas por
  ventas/mermas ya hechas — sin esto no se puede llegar a cero.
- 3 colores de prueba, cada uno atado a 1 bobina todavía abierta (consecuencia de lo anterior).
- 5 productos de prueba con stock remanente (12 a 40 unidades cada uno).
- Todo lo demás — clientes, proveedores, productos sin stock trabado, compras, cotizaciones,
  pedidos, despachos, comprobantes — en cero activos o revertido.

Todo marcado con prefijo `E2E`/`BOB`, sin mezclarse con costos ni cantidades reales, invisible
desde cualquier pantalla que use un cliente real (proveedores/clientes/productos de prueba
quedan desactivados). Es el mismo tipo de residuo estructural que cualquier corrida completa
de esta suite iba a dejar contra producción desde que existen Fase 6 y Fase 7b juntas — no es
nuevo de esta fase, es la primera vez que se corre completa y se ve.

### Hallazgos de revisión, ya corregidos (no quedan pendientes)

- **revisor (alto):** búsqueda de pedidos/cotizaciones perdió el filtro por código al mover la
  búsqueda al servidor. Corregido: se extrae el número de `search` y se agrega `seq` al `OR`.
- **revisor (alto):** `customer-picker.tsx` (mostrador) usaba `fetchAllForPicker` sin `search`;
  un cliente fuera de los primeros 200 alfabéticos quedaba invisible antes de darlo de alta.
  Corregido pasando el documento tecleado como filtro.
- **auditor-seguridad (bajo):** `page` sin cota superior permitía un `OFFSET` arbitrariamente
  grande. Corregido con `MAX_PAGE=10_000`.

### Nada más queda anotado de esta fase

El resto de lo revisado (paginación de los 10 endpoints, ocultamiento de costos por rol,
Decimal/dinero, kardex append-only, secretos, dependencias) no tuvo hallazgos.

## 5. Cómo verificar

```
pnpm turbo lint typecheck test build   # verde
pnpm exec playwright test e2e/tests/fase7d.spec.ts   # 3 pruebas nuevas, verde en local
```

Para repetir el barrido visual de `/planta` y `/pos` en 375px sin exponer credenciales: un
script Playwright que hace login vía API con `adminApi()`/credenciales de `.env` (nunca
impresas) y transfiere las cookies de sesión a un contexto de navegador con
`viewport: {width: 375, height: 812}` — no quedó ningún archivo de este tipo en el repo (se
usó y se borró), pero el patrón está en el historial de esta sesión si hace falta repetirlo.

La verificación contra producción ya está hecha (§4): `pnpm e2e:prod` (119/119) y
`pnpm prod:purge-e2e`.

## 6. Siguiente sesión

1. Si se quiere cero residuo absoluto en producción (no bloqueante): revertir a mano, desde la
   UI, la venta que consumió las planchas de `OP-000319`/`OP-000320` y anular las mermas
   (`SCRAP`) de los dos flejes que bloquean sus recepciones de corte — recién ahí la purga
   puede terminar de desactivar los 3 colores y limpiar los 5 productos con stock. Es trabajo
   manual de administrador, no de agente (son las mismas acciones que un dueño real haría).
2. `vercel login` sigue pendiente para dejar `pnpm deploy:web` operativo fuera de un push (no
   bloquea nada: el deploy real sale del push a `main` vía la integración de GitHub).
3. Fase 8 (Auditoría, reportes, UAT) — primera candidata pendiente de este documento: decidir
   si vale la pena un link "← Volver" en las vistas de detalle (§2, breadcrumbs).
4. `/imports` sigue sin pantalla en el web (nadie la pidió; el endpoint ya pagina por si
   algún día la hay).
