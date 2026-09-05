# Handoff — Fase 6 (producción de coberturas metálicas y maestro de colores) — 2026-09-04

## 1. Resumen

Fase 6 según `docs/ARQUITECTURA.md` §3.7, que **se renumeró en esta sesión** (D-082): la `5c`
que D-070 había creado pasa a ser la 6, la importación de comprobantes a la 7 y auditoría/UAT
a la 8. Entregado: el ciclo completo de una cobertura metálica contra pedido —cotización con
subítems de largo → pedido con reserva de materia prima → orden de producción con el plan de
corte copiado → bobina filtrada por espesor y color → largos reales → cierre con merma de
despunte → despacho y comprobante— más el maestro de colores del que depende el filtro. Diez
decisiones nuevas (D-082..D-091).

Estado: `pnpm turbo lint typecheck test build` en verde (**213 unit**); **11 E2E nuevos**;
**101 pasados y 13 saltados contra producción, sin fallos**; dos migraciones aplicadas en
`dev` y `production`; API redesplegado y web por push a `main`. `pnpm prod:purge-e2e` deja
producción con **0 bobinas con saldo, 0 productos con saldo, 0 reservas activas, 0 despachos
vivos y 0 proveedores, acabados, productos, clientes o colores de prueba activos**.

Lo que más importa de la fase no estaba en el plan: **corrige un hueco de Fase 5b**. El
despacho sacaba del kardex las coordenadas congeladas del pedido, que en una cobertura son la
bobina; como la orden de producción ya había sacado esos kilos al reportar, despachar los habría
sacado por segunda vez. En perfiles y trading el defecto es invisible, así que habría esperado a
la primera cobertura real (D-088).

## 2. Hecho

1. **Decisiones (punto 1)** — `docs/ARQUITECTURA.md` §0.2 gana D-082..D-091, §3.7 se renumera y
   §4.3/§4.5/§4.6 actualizan RF-30..RF-33, RF-36, RF-39, RF-54, RF-60, RF-63, RF-64 y RF-73.
   Contexto largo en `docs/DECISIONES.md`.
2. **Prisma (punto 2)** — `colors`; `color_id` en `products`, `coils` y `purchase_items`;
   `product_boms.kind` con las tres columnas de drywall en nullable y un `CHECK` que las exige
   ahí; `production_orders.kind`/`consumed_kg` con `CHECK` de "cobertura contra pedido";
   `production_order_items`, `production_report_pieces`, `quotation_item_pieces`,
   `sales_order_item_pieces`; y `reservations` deja de ser única por línea de pedido y pasa a
   `(línea, itemType, itemId)`. Dos migraciones, `20260904180000_*` y `20260904181000_*`.
3. **Modelo de producto (D-083)** — conviven la plancha de catálogo (`NIU`, largo fijo en la
   receta) y la cobertura a medida (`MTR`, el largo lo trae el pedido). La unidad del producto
   es lo que las separa, y el kardex ya prohibía mezclar unidades en un saldo.
4. **Color (D-085, D-086)** — `apps/api/src/colors/`, con baja lógica y el bloqueo de
   desactivación mientras un producto activo o una bobina viva lo use. El filtro de bobina de la
   OP compara `colorId` por **igualdad estricta, `null` incluido**, y el espesor con tolerancia
   de 0.02 mm (`ROOFING_THICKNESS_TOLERANCE_MM`, override por entorno, sin UI).
5. **La orden (D-084, D-087)** — `RoofingProductionService` opera una tabla
   `production_orders` compartida con drywall vía `kind`; `production-shared.ts` tiene la mitad
   idéntica (lock, estados, restauración de reserva) y las consultas se delegan a
   `ProductionService`, así que `/produccion` lista las dos clases.
6. **El traslado de la reserva (D-088)** — al reportar largos, la reserva de bobina se descuenta
   por los kilos consumidos y **nace una reserva sobre los metros fabricados**: las planchas a
   medida nacen reservadas para el pedido que las encargó. El despacho lee las coordenadas de la
   reserva viva y una línea que se fabrica contra el pedido no vuelve nunca al insumo.
7. **La merma (D-089)** — planta declara los kilos que la bobina consumió de verdad y la
   diferencia contra el teórico sale como despunte; **el resto del rollo vuelve al almacén**, que
   es donde esta fase se separa de D-057.
8. **Reversas** — reversa del reporte de largos (devuelve kilos y promesa), reapertura del
   cierre y anulación de la orden, todas con motivo y falla completa.
9. **Web (punto 9)** — paleta en `/catalogo`, color en producto, bobina y línea de compra con
   muestra visual; editor de subítems en la cotización con la cantidad derivada de los largos;
   rama de coberturas en `/planta`, mobile-first; `/produccion` con filtro por clase de orden.
10. **Revisión (punto 11)** — `revisor` sobre el API y otra pasada sobre el web, más
    `auditor-seguridad`. Tres bloqueantes y tres altos corregidos; detalle en
    `docs/PROGRESO.md`.
11. **E2E (punto 12)** — `e2e/tests/fase6.spec.ts` (5) y `fase6-bordes.spec.ts` (6), con
    `e2e/helpers/roofing.ts`.

## 3. Decisiones tomadas

- **D-082** — La fase se numera **6** y §3.7 se renumera; la cola de producción (RF-37, RF-38) y
  el punto de venta (RF-60) salen de su alcance y pasan a la 7.
- **D-083** — Dos productos de cobertura conviven; el a medida se lleva en **metros lineales**
  porque en un saldo de piezas dos planchas de largo distinto compartirían promedio ponderado.
- **D-084** — La OP nace **siempre** del pedido y copia sus largos como plan editable.
- **D-085** — El color es un maestro y un id; el SKU lo refleja pero nadie lo parsea. Igualdad
  estricta con `NULL` incluido.
- **D-086** — Filtro de bobina: abierta, con saldo, espesor ±0.02 mm y color idéntico; montarla
  es custodia, exactamente D-060.
- **D-087** — Una sola tabla con `kind`, dos servicios. Evaluado contra el código real de Fase 4.
- **D-088** — La reserva se traslada del insumo al producto terminado; el despacho lee la reserva
  viva. Corrige el hueco de 5b.
- **D-089** — Merma por despunte con consumo declarado; el sobrante vuelve al almacén.
- **D-090** — Rolado con máquina propia: D-056 sin variantes, overhead en cero.
- **D-091** — UPVC es compra-venta pura en v1; una futura producción entraría como otro `kind`.

## 4. Bloqueos / pendientes

**Sin bloqueos técnicos abiertos.**

**Diferido, con motivo:**

- **La cola de producción (RF-37) y su indicador (RF-38)**, y el **punto de venta** (RF-60),
  pasan a Fase 7 por D-082: no dependen de coberturas y sí de decisiones de UI que esta fase no
  tomó.
- **Mano de obra y overhead** siguen en cero y explícitos (D-090), como hook de D-035.
- **Producción de UPVC** no se construye (D-091); queda dicho por dónde entraría.
- **La paleta no se siembra**: `colors` nace vacía y el administrador carga los colores reales
  de la empresa desde `/catalogo` → Colores. Sembrar colores inventados en producción habría
  sido meterle datos que el cliente no pidió.
- **Un reporte sale de una sola bobina.** RF-30 admite varias por orden y la OP las monta, pero
  cada reporte declara de cuál salieron sus planchas: el kilo teórico depende del ancho y el
  espesor de **esa** bobina (D-047), y repartir un mismo reporte entre dos geometrías daría un
  consumo que no es el de ninguna.

**Ojo operativo — el color no se puede desactivar mientras se use.** Es deliberado (un color
desactivado en el filtro sería un rollo que planta ve y no puede elegir en ninguna pantalla),
pero significa que la purga de E2E tiene que desactivar los colores **al final**, después de los
productos y las bobinas. `pnpm prod:purge-e2e` ya lo hace en ese orden.

**Ojo operativo — la tolerancia de espesor falla abierta si se configura mal.** Por eso
`ROOFING_THICKNESS_TOLERANCE_MM` se valida al arrancar (número entre 0 y 0.5 mm, o vacío): un
valor alto anulaba el filtro en silencio, que es lo peor que puede hacer un control que existe
para que no se role la bobina del calibre equivocado.

**Ojo operativo — el cupo de la cuenta demo del PSE.** Los dos tests de Fase 5b que emiten
fallan **en local** con _"No puedes enviar mas de 50 documentos en una cuenta DEMO"_. Es lo que
ya avisaba `docs/handoff/fase-5b.md`: son 50 documentos, no se liberan anulándolos —hay que
borrarlos en el panel de Nubefact— y una corrida completa gasta unos veinte. Esta sesión corrió
la suite varias veces mientras se aplicaban las correcciones de la revisión, así que el cupo se
agotó. **No bloquea el cierre**: `e2e:prod` no emite nunca (D-081).

**Tres defectos latentes de los helpers de E2E**, corregidos acá porque los despertó esta fase y
en los tres el síntoma apunta a cualquier parte menos a la causa: `createInvoiceableCustomer`
reusaba el cliente por RUC sin mirar si la purga lo había desactivado —así que **toda** corrida
contra producción posterior a una purga moría en cuatro tests de 5b—; `today()` partía de UTC
mientras el API valida contra el día de Lima, así que a partir de las 19:00 hora local cualquier
documento fechado "hoy" se rechazaba por futuro (la lección de D-069, que el API ya había
aprendido y los helpers no); y los códigos de acabado y los RUC de proveedor chocaban de vez en
cuando, reventando un test que no tenía nada que ver.

**Y la purga no desactivaba productos, proveedores ni acabados.** Eso lo hacía cada spec en su
`finally`, así que lo que sobrevivía a un test caído quedaba **activo** en el catálogo y en los
maestros, a la vista del cliente. `pnpm prod:purge-e2e` ahora los cierra, en el único orden que
el API permite: productos → proveedores y acabados → colores.

**Lo que la revisión enseñó, y vale para la próxima fase.** Los tres bloqueantes tienen la misma
forma: **una promesa que se mueve entre ítems obliga a revisar cada punto donde alguien la lee o
la descuenta**, y es fácil arreglar la mitad. Ninguno lo habría atrapado un test de aritmética
pura; los encontró leer el **orden de las operaciones** —promesa primero, kardex después— y los
confirmó el E2E del ciclo completo. Detalle en `docs/DECISIONES.md`, sección D-082..D-091.

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm turbo lint typecheck test build   # exit 0 (213 unit)
pnpm format:check                      # exit 0
pnpm e2e                               # suite completa, incluidos los 11 de Fase 6
pnpm e2e --grep "Fase 6"               # solo esta fase
pnpm e2e:prod                          # contra producción (D-024, D-081)
pnpm prod:purge-e2e --dry-run          # qué dejaría limpio; sin la bandera, lo deshace
node scripts/prod-e2e-leftovers.mjs    # solo lectura: qué dejaron los E2E en producción
node scripts/migrations-status.mjs --branch production
gh run list --limit 3
```

**No correr dos suites de Playwright a la vez**: comparten `test-results/`, que Playwright
limpia al arrancar, y el síntoma no se parece a la causa.

Un recorrido a mano que prueba la fase entera, en el orden en que la usaría la empresa:

1. `/catalogo` → **Colores** → crear el color. Después el producto de cobertura con ese color,
   unidad `MTR`, origen Fabricado, y su **Receta** (acabado + espesor; sin largo).
2. `/compras/nueva?tipo=COIL` → una bobina de ese espesor y color.
3. `/cotizaciones/nueva` → línea de esa cobertura: el detalle de largos aparece solo, la
   cantidad se calcula sola en metros, y hay que elegir de qué bobina salen los kilos. Emitir y
   confirmar.
4. `/planta` → **Coberturas por fabricar** → crear la orden del pedido; el plan viene copiado.
   Montar la bobina (solo aparece si el color y el espesor coinciden), reportar los largos y
   cerrar declarando los kilos consumidos.
5. `/pedidos/[id]` → despachar y facturar: la descripción de la línea lleva los largos.

Producción:

- Web: https://ayr-steel-erp-web.vercel.app — `/catalogo` gana la pestaña **Colores**;
  `/planta` gana la rama de coberturas; `/produccion` filtra por clase de orden.
- API: https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app — rutas nuevas `/colors` y
  `/production/roofing/*`.
- DB: Neon rama `production`, con las dos migraciones de Fase 6.

Para redesplegar: el web sale solo con el push a `main`; el API con
`pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app`. Con migración nueva,
`pnpm db:prod` **antes** de desplegar el API.

## 6. Siguiente sesión

**Fase 7** (§3.7, renumerada por D-082): cola de producción (RF-37) y su indicador de menú
(RF-38), punto de venta directo (RF-60), e importación de comprobantes ya emitidos (RF-11,
RF-71, RF-72).

Primera tarea concreta: **la cola**. Ahora sí tiene de dónde salir — un pedido de coberturas
confirmado es exactamente "esperando producción" hasta que su reserva de bobina se consume, y el
DTO de la reserva ya expone la OP viva que la atiende (fue uno de los arreglos de esta fase). El
indicador del menú cuenta esa misma lista.

Lo que Fase 6 deja listo y no hay que rehacer:

- **El traslado de la reserva está construido y probado de punta a punta.** Cualquier flujo
  futuro que convierta un ítem en otro —una producción de UPVC, un reempaque— reusa
  `upsertItemReservation` / `reduceReservation` sin inventar nada.
- **El despacho ya sabe distinguir el insumo prometido del producto fabricado**, así que vender
  desde el punto de venta un producto hecho contra pedido no necesita lógica nueva.
- **La OP admite otro `kind` sin tocar tabla, correlativo, estados ni auditoría** (D-087).
- **El maestro de colores y su filtro** están cerrados: una línea nueva que necesite color solo
  agrega la columna y reusa `ColorSelect`.

**Sigue pendiente de acción humana** el pase a la cuenta real del PSE (checklist en
`docs/handoff/fase-5b.md` §4, retomado en `docs/handoff/m-3.md`): el dueño decidió seguir en
demo/contingencia hasta nuevo aviso, y esta fase no lo toca.
