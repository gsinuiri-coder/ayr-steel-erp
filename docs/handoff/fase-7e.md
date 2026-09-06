# Handoff — Fase 7e, venta de bobinas + catálogo estructurado + cotización — 2026-09-06

## 1. Resumen

Cinco decisiones del dueño (A-E), más dos ajustes de alcance pedidos en su revisión local
(D-121) y uno diseñado pero diferido (D-122): **D-116..D-121** implementados y desplegados;
**D-122** documentado, no implementado, para el tramo **7e-ii**. Una lección de proceso nueva,
**D-123**, sobre por qué el primer push llegó verde en local y encontró 25 fallas reales en CI.

Estado: `pnpm turbo lint typecheck test build` en verde. CI verde (dos corridas: la primera
encontró las 25 fallas de D-123, la segunda —tras corregirlas— pasó 159/159, 9 saltadas).
**Deployado y verificado contra producción real**: `pnpm e2e:prod` 119/119 (38 saltadas por
D-081), `pnpm prod:purge-e2e` corrido — ver §4 para el residuo, del mismo tipo estructural no
bloqueante que Fase 7d ya documentó.

## 2. Hecho

### A — Venta de bobina completa (D-116)

Una bobina `COIL` `OPEN` o `CLOSED` (nunca `IN_THIRD_PARTY`/`CANCELLED`) se vende **siempre por
su saldo vivo completo**, en Drywall o Metallic Roofing por igual. Línea nueva
(`salesItemInputSchema.saleCoilId`): el API resuelve el producto (SKU `trading` de D-037) y la
cantidad (el disponible real al resolver la línea) — nunca lo que el formulario tipee. Reusa el
ledger de reservas (D-054/D-066): confirmar = custodia, cancelar libera, despachar consume al
costo real. Único cambio de guardrail: `createReservations` acepta `CLOSED` cuando el producto
reservado no tiene receta activa (venta directa), sigue exigiendo `OPEN` cuando sí la tiene
(materia prima). Selector nuevo `GET /sales/sellable-coils`.

### C — Defaults de bobina (D-117)

Toda bobina nueva nace `CLOSED` salvo que el formulario elija `OPEN` explícitamente (una hija
de partido o un fleje de corte siguen naciendo `OPEN`, sin cambios). El selector de línea de
negocio de una compra `COIL`/planilla ofrece solo `drywall`/`metallic-roofing`
(`COIL_BUSINESS_LINES`). `CoilDto.equivalentMeters` expone el metro lineal equivalente del
saldo, compartiendo `kgPerMeter`/`equivalentMeters` con `roofing-math.ts`.

### B — Catálogo estructurado (D-118)

`products` gana `thicknessMm`/`widthMm` (obligatorios en Metallic Roofing) y
`widthMm`/`lengthMm`/`pieceWeightKg` (obligatorios en Drywall). `ProductDto.theoreticalKgPerUnit`
sale de `thicknessMm × widthMm × densityFactor` de la receta (`null` sin receta activa o sin los
dos campos). Drywall declara `pieceWeightKg` directo, sin fórmula. **Hallazgo de revisor
corregido en la misma sesión**: el chequeo era `!p.bom` en vez de `!p.bom?.isActive`, así que un
BOM desactivado seguía contando para el teórico.

### D — Cotización multi-línea y duplicar (D-119)

`quotations`/`sales_orders` pierden `business_line_id`: cada línea trae la suya, la de su propio
producto. `resolveSalesLines` ya no recibe ni valida una línea compartida del documento.
`businessLines` se expone como arreglo derivado de los ítems. **Bug real encontrado y corregido
en el mismo tramo, antes de que un test lo confirmara**: `createReservations` y
`dispatches.service.ts` usaban `order.businessLineId` para el kardex, que es falso en cuanto
producto (`trading`) e ítem físico (una bobina de Drywall/Metallic Roofing) son de líneas
distintas. Fix: `InventoryService.resolveItemBusinessLineId(tx, itemType, itemId)` — la línea se
resuelve **del ítem**, nunca del documento — usado también en `production.service.ts` (guardrail
de reserva-vs-producto) y `dispatches.service.ts`. **Duplicar** (`POST
/sales/quotations/:id/duplicate`) crea un BORRADOR desde una cotización en cualquier estado,
revalidando cliente/productos/bobinas contra el catálogo y el kardex de hoy — no una copia
literal.

### E — Corte tercerizado solo Drywall (D-120)

`CuttingService.send` rechaza una bobina que no sea Drywall. El formulario web deja de pedir el
ancho a mano: se elige el SKU del perfil (con receta activa) y el ancho sale de
`product_boms.input_width_mm`, con los kg teóricos del plan mostrados de forma informativa.

### D-121 — Dos ajustes de alcance pedidos en la revisión local del dueño

- **(a)** `/bobinas` gana pestañas: **Disponibles** (default), **En corte**, **Agotadas**,
  **Todas** (única con el `<select>` de Estado). Filtros nuevos en `GET /coils`: `statusNe` y
  `availability` (subconsulta a `inventory_balances`). Nada se borra — una bobina anulada cae en
  "Agotadas" porque su reversa ya la deja en cero.
- **(b)** La terminal de planta y el detalle de OP muestran "Piezas teóricas" =
  `assignedKg / kgPerPiece` sin redondear, comparado contra lo reportado. Solo Drywall.

Verificado por un subagente `qa` con Playwright contra la app local (2 tests nuevos,
`e2e/tests/fase7e-ajustes-d121.spec.ts`), aprobados por el dueño antes del push.

### D-122 — Sacar el `ProductBom` de coberturas (diseñado, diferido a 7e-ii)

El dueño señaló en la revisión que coberturas todavía depende de un `ProductBom` en dos puntos
(`coilOptions`/`mountCoil` comparan contra `bom.inputThicknessMm`; el teórico del catálogo exige
`p.bom?.isActive`) pese a que D-118 ya dejó `thicknessMm`/`widthMm`/`colorId` en `products` — dos
fuentes del mismo dato. Diseño completo en `ARQUITECTURA.md` (D-122): `products` gana `finishId`,
`coilOptions`/`mountCoil` pasan a filtrar contra `product.thicknessMm`, `ProductBom` queda
exclusivo de Drywall, `production_orders.bom_id` pasa a nullable. Implicaciones: migración con
backfill, `ProductionOrderDto.bom` nullable, reescribir el e2e "plancha de catálogo con receta".
**No implementado esta sesión** — el dueño autorizó explícitamente diferirlo si el contexto no
alcanzaba para cerrarlo con la misma verificación que el resto de la fase.

### D-123 — Lección de proceso: un cambio de regla no aditivo se verifica contra la suite completa

El primer push (A-E + D-121) llegó verde en local (specs nuevos de la fase + una muestra de
fases pasadas) y CI encontró **25 fallas reales** en 9 specs de fases anteriores
(fase1/2b/3/3b/5a/5a-bordes/6-bordes/7b-bordes/7d): ninguna era del código nuevo, todas asumían
el comportamiento que D-117/D-118/D-120 cambiaron (catálogo con campos ahora obligatorios,
bobina que ahora nace `CLOSED`, corte ahora exclusivo de Drywall, compra de bobina ahora
restringida por línea). La corrida completa local (`pnpm e2e`) se había cortado a las 2+ horas
en la misma sesión por tardar demasiado, y la muestra que la sustituyó no tocaba ninguno de esos
9 archivos. Las 9 specs se corrigieron (segundo push, CI verde: 159/159, 9 saltadas). Detalle y
la lección completa en `ARQUITECTURA.md` (D-123).

## 3. Verificación

```
pnpm turbo lint typecheck test build   # verde
pnpm exec playwright test --list        # 168 tests, 27 archivos, sin errores de sintaxis
```

- Revisión de `revisor` y `auditor-seguridad`: sin bloqueantes (hallazgos menores corregidos en
  el mismo tramo — ver B arriba).
- 8/8 E2E nuevos de la fase (`fase7e.spec.ts`, `fase7e-bordes.spec.ts`) + 2/2 de D-121
  (`fase7e-ajustes-d121.spec.ts`).
- CI: primera corrida falló por D-123 (25 fallas, ninguna de código nuevo); segunda corrida
  159 pasaron, 9 saltadas, 0 falladas.

## 4. Producción

1. `pnpm db:prod` — 3 migraciones aplicadas (`fase7e_coil_status_purchase_item`,
   `fase7e_catalogo_estructurado`, `fase7e_cotizacion_multi_linea`), seed reaplicado.
2. `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app` — desplegado en
   `https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app`.
3. `pnpm deploy:web` **falló** con `403 invalidToken` — el token del CLI de Vercel local sigue
   expirado (blocker ya documentado en fases anteriores). No bloqueó nada: la integración
   Vercel-GitHub ya había desplegado el web automáticamente con cada push (confirmado vía
   `gh api repos/.../commits/<sha>/status`, check "Vercel" en success).
4. `pnpm e2e:prod` — **119 pasaron, 38 saltadas (D-081), 0 falladas.**
5. `pnpm prod:purge-e2e` — residuo final, mismo tipo estructural no bloqueante que Fase 7d
   documentó (ventas/mermas/producción ya movidas que el append-only no deshace sin una reversa
   de dominio nueva):
   - 4 órdenes de producción E2E vivas (`OP-000358`, `OP-000357`, `OP-000320`, `OP-000319`) —
     bloqueadas por piezas ya vendidas o la orden ya cerrada.
   - 5 de 10 recepciones de corte E2E no se pudieron revertir — flejes con movimientos
     posteriores (`SCRAP`/`PRODUCTION`).
   - 4 colores de prueba atados a bobinas todavía abiertas.
   - 3 productos de prueba con saldo remanente (12-40 unidades cada uno).
   - Bobinas abiertas con saldo tras la limpieza: **0**. Reservas activas: **0**.
   - Todo con prefijo `E2E`, sin mezclarse con datos reales, invisible para un cliente real
     (proveedores/clientes/productos de prueba con actividad quedan desactivados).

## 5. Siguiente sesión — tramo 7e-ii

1. **D-122** — sacar el `ProductBom` de coberturas (diseño completo en `ARQUITECTURA.md`):
   `products.finish_id` nuevo + backfill, `coilOptions`/`mountCoil` a `product.thicknessMm`,
   `production_orders.bom_id` nullable, DTO y frontend actualizados, reescribir el e2e "plancha
   de catálogo con receta".
2. Si se quiere cero residuo absoluto en producción (no bloqueante, trabajo manual de
   administrador): revertir desde la UI las ventas/mermas que bloquean las 4 OP y las 5
   recepciones de corte listadas en §4.
3. `vercel login` sigue pendiente para dejar `pnpm deploy:web` operativo fuera de un push (no
   bloquea nada: el deploy real sale de la integración de GitHub).
4. Fase 8 (Auditoría, reportes, UAT) sigue pendiente.
