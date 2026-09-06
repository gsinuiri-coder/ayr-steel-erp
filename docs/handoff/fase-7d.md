# Handoff — Fase 7d, pulido UI/UX pre-entrega al cliente — 2026-09-06

## 1. Resumen

Fase de pulido, no de features: la app queda presentable y operable para UAT con el cliente,
sin tocar dominio ni schema salvo lo estrictamente listado. Tres decisiones nuevas,
**D-112..D-114**.

Cuatro tareas: **fechas** (el pendiente de nueve pantallas que dejó la Sesión M-4, más un
décimo hallazgo nuevo), **paginación server-side** en las diez tablas que crecen sin techo,
**tablas contenidas** (scroll interno + encabezado fijo) y **afordancia de link unificada**, y
un **barrido general** de estados vacíos, loading, errores y viewport móvil.

Estado del código: `pnpm turbo lint typecheck test build` en verde; E2E local verde (suites
existentes reparadas + 3 nuevos). **Pendiente: deploy de API y web, y recién entonces un
`pnpm e2e:prod` real** — ver §4, incluye un incidente de esta sesión (corrida prematura contra
producción vieja) ya resuelto y con producción confirmada en cero rastros.

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

### Tablas contenidas y columnas responsive

`<TableScrollArea>` (max-height 55vh + scroll interno + `<TableHeader className="sticky
top-0 z-10 bg-background">`) en las tablas de listado y en el preview de importación
(`import-dialog.tsx`) y el picker de bobinas de una nueva orden de corte — la página ya no
scrollea entera en una laptop de 13". Columnas secundarias con `hidden md:table-cell` /
`lg:table-cell` / `sm:table-cell` en las tablas más anchas (bobinas 10 columnas, despachos,
compras, comprobantes, kardex, cobranzas, pedidos, cotizaciones, clientes) para priorizar
columnas clave en pantallas angostas antes que forzar scroll horizontal.

Siete tablas Card-envueltas se revisaron y se dejaron sin este tratamiento a propósito: están
acotadas por regla de negocio (líneas de un solo documento, servicios de un solo corte, filas
de un formulario) y no por volumen de transacciones — envolverlas hubiera sido ruido visual
sin beneficio.

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

## 4. Bloqueos / pendientes

### Deploy pendiente, y por qué se dejó así a propósito

El código de esta fase no está desplegado — ni API (Cloud Run) ni web (Vercel) llevan los
cambios. Es la única fase de esta bitácora que cierra sin `pnpm deploy:api`/`deploy:web`: se
decidió dejarlo explícito para que el dueño confirme el momento, en vez de que la sesión
deployara sola justo después de un efecto secundario real en producción (ver abajo). Cuando se
decida:

```
pnpm deploy:api
pnpm deploy:web
pnpm e2e:prod        # recién ahí prueba código nuevo de verdad
pnpm prod:purge-e2e
```

### Incidente de esta sesión: `e2e:prod` corrido antes de deployar (ya resuelto)

Se corrió `pnpm e2e:prod` como parte de la verificación de la fase **antes** de deployar —
error de secuencia, no de datos: cada fase anterior de esta bitácora deploya y recién después
corre E2E contra producción, y esta vez se invirtió el orden. Contra la API vieja (sin
`PaginatedResult`), el helper nuevo de E2E `getItems` (que hace `.items` sobre la respuesta)
leía `.items` de un array plano y devolvía `undefined`: 64 de 155 pruebas fallaron en cascada
con `TypeError`, incluidas las 3 nuevas de `fase7d.spec.ts` (esperable: production no tiene la
UI de paginación desplegada todavía). No es un defecto del código de esta fase.

La corrida sí alcanzó a crear datos reales en producción antes de fallar. Se detectó que la
prueba de paginación de clientes en `fase7d.spec.ts` no tenía limpieza para producción (las
otras dos sí, vía `deactivateTrail`) — corregido agregando soporte de `customerIds` a
`deactivateTrail` (`e2e/helpers/production.ts`) y el `finally` correspondiente en el test.

Limpieza ejecutada y verificada:

1. `pnpm prod:purge-e2e` — anuló compras/pagos/bobinas de proveedores `E2E …`, desactivó
   clientes, productos, proveedores, acabados y colores de prueba.
2. `node scripts/prod-e2e-leftovers.mjs` — confirmó **cero activos** en despachos, órdenes de
   producción, pedidos, cotizaciones, órdenes de corte, clientes, productos, proveedores,
   acabados y colores marcados como prueba. `reservas ACTIVAS en toda la base: 0`.

**Producción queda como estaba antes de la corrida: cero rastros activos.** El registro
histórico de compras/bobinas de E2E de fases anteriores (miles de filas, todas ya
canceladas/desactivadas) sigue ahí por diseño — el kardex es append-only y no se borra
(§3.2), igual que en todas las fases previas.

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

Después del deploy, la verificación real de esta fase es `pnpm e2e:prod` seguido de
`pnpm prod:purge-e2e` — ver §4.

## 6. Siguiente sesión

1. Deploy de API y web con el dueño enterado del momento; `pnpm e2e:prod` real; purga.
2. Fase 8 (Auditoría, reportes, UAT) — primera candidata pendiente de este documento: decidir
   si vale la pena un link "← Volver" en las vistas de detalle (§2, breadcrumbs).
3. `/imports` sigue sin pantalla en el web (nadie la pidió; el endpoint ya pagina por si
   algún día la hay).
