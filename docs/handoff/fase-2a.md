# Handoff — Fase 2a (Kardex, compras y alta de bobinas) — 2026-09-03

## 1. Resumen

Fase 2a según `docs/ARQUITECTURA.md` §3.7 (D-041): **cerrada**. Se entregaron el kardex append-only con promedio ponderado, el módulo de compras completo (cuatro tipos, recepción, pagos parciales, saldo y estado de cuenta por proveedor) y el alta de bobinas por las tres vías (compra manual, XML UBL 2.1 del proveedor, planilla), con sus vistas web.
Estado: `pnpm turbo lint typecheck test` en verde (83 unit); 17/17 E2E en local y en CI (corrida 33693141624); migración aplicada en Neon `production`, API redesplegado en Cloud Run, web desplegado por push a `main`, y `pnpm e2e:prod` en 16/16 contra producción.
Revisado por `revisor` (API y web, en dos pasadas) y `auditor-seguridad`: 1 bloqueante y 9 altos corregidos, incluido uno de seguridad preexistente al diff de la fase.

## 2. Hecho

1. **Decisiones y requisitos** — `docs/ARQUITECTURA.md` §0.2 (D-035..D-042), §3.7 partida en 2a/2b, §4.2 con RF-15 recuperado, §4.8 reescrita como los cinco reportes de D-036, §5 con P-11 nueva y resuelta y P-08 cerrada del todo. Contexto largo en `docs/DECISIONES.md`.
2. **Investigación previa** — `docs/referencias/ubl21-factura.md`: rutas XPath de la factura electrónica peruana (cabecera, líneas, `PaymentTerms`, totales), catálogos SUNAT 01/03/06, fixture de ejemplo y análisis de parseo seguro. La produjo el subagente nuevo `investigador` (`.claude/agents/investigador.md`) delegando en `agy`; marca explícitamente lo que no pudo verificar contra fuente oficial de SUNAT.
3. **Kardex (punto 1)** — `apps/api/src/inventory/`. `inventory_movements` es append-only también en la base (trigger anti-UPDATE/DELETE y `CHECK qty > 0`); `inventory_balances` guarda cantidad y costo promedio ponderado (D-028). `InventoryService.record` es el **único** escritor de ambas tablas, exige el `tx` del llamador para escribir en la misma transacción que la operación que lo origina, bloquea el saldo con `INSERT ... ON CONFLICT` + `SELECT ... FOR UPDATE`, y devuelve `null` como no-op explícito en líneas `NOOP` (§2.2). `GET /inventory/{balances,movements}` es solo lectura.
4. **Compras (punto 2)** — `apps/api/src/purchases/`. `purchases`/`purchase_items`/`supplier_payments` con los cuatro tipos de D-030. La recepción crea bobinas (COIL), mueve el producto de catálogo (FINISHED_GOOD) o no toca inventario (SERVICE/EXPENSE), todo en una transacción y con el cambio de estado condicionado a `DRAFT`. El saldo y el estado de cuenta se calculan, nunca se almacenan (D-039). La aritmética vive aparte en `purchase-math.ts` para poder probarla sola.
5. **Bobinas (punto 3)** — `apps/api/src/coils/`. Código RF-13 con correlativo por proveedor resuelto con un `UPDATE ... RETURNING` atómico, `typeKey` RF-14 y SKU D-037 (`BOB{finishCode}{thicknessMm}`), que se crea como producto de `trading` al dar de alta la primera bobina de ese tipo. Tres vías de alta: compra manual (RF-10), XML UBL 2.1 (RF-11, `invoice-xml.ts` con `fast-xml-parser`) y planilla (RF-12, `imports/adapters/coils.adapter.ts`).
6. **Web (punto 4)** — `/compras` (lista filtrable por línea, tipo, estado, saldo y texto), `/compras/nueva?tipo=` (formulario único que cambia de forma por tipo), `/compras/[id]` (recepción, importes, cuenta por pagar y pagos), `/proveedores/[id]/estado-cuenta`, `/bobinas` (RF-23), `/bobinas/nueva-xml` (RF-11) y `/bobinas/importar` (RF-12). Los proveedores ganan su código corto en el alta, la lista y la búsqueda.
7. **Tests (punto 5)** — 83 unit: promedio ponderado con tres entradas, salida al promedio vigente, NOOP, validaciones y bloqueo del saldo (`inventory.service.spec.ts`); códigos RF-13/RF-14/D-037 y el correlativo atómico (`coils.service.spec.ts`); parser XML con dos fixtures anonimizados y los rechazos de DOCTYPE, ZIP, no-UBL, vacío y moneda no soportada (`invoice-xml.spec.ts`); totales, vencimiento, conversión de moneda y saldo con pagos parciales (`purchase-math.spec.ts`). E2E: `e2e/tests/fase2a.spec.ts` con los cinco escenarios exigidos.
8. **Revisión (punto 6)** — `revisor` sobre el API y sobre el web, `auditor-seguridad` sobre el API, `qa` sobre los E2E. Hallazgos y correcciones en `docs/PROGRESO.md`; los cuatro que cambiaron el diseño están abajo.
9. **Deploy (punto 7)** — `pnpm db:prod`, `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app`, push a `main` (el web sale solo), `pnpm e2e:prod` 16/16.

## 3. Decisiones tomadas

- **D-035** (cierra P-11) — Costo de producción = materia prima + servicios directos + `overheadPerKg` por línea, campo nuevo en `pricing_settings`, solo ADMINISTRADOR. La columna ya existe; su consumo real es de Fase 4.
- **D-036** (cierra P-08) — Los reportes de v1 son exactamente cinco: inventario valorizado por línea, kardex por producto/bobina, ventas por período, cuentas por pagar por proveedor y cola de producción. §4.8 reescrita; cae el reporte de compras como reporte propio (lo cubre la lista central) y el RF de exportación genérica (pasa a ser una propiedad de cada reporte).
- **D-037** (supersede D-027) — El SKU de bobina es `BOB{finishCode}{thicknessMm}`, sin ancho ni guiones, uno por `typeKey`. Con el ancho dentro, cada ancho comprado creaba un producto distinto y un partido (RF-15) cambiaba el producto al que pertenece el stock.
- **D-038** — El costo con el que una bobina entra al kardex es el valor de compra **sin IGV**; el IGV va aparte en la compra. Es crédito fiscal, no costo del material.
- **D-039** — Cuentas por pagar con N pagos parciales por compra; el saldo se calcula (total − pagos), nunca se almacena, y el estado de cuenta por proveedor lista compras con saldo, antigüedad y total adeudado.
- **D-040** — La merma es un movimiento `OUT` con `refType=SCRAP` valorizado al costo promedio vigente; anularla es un movimiento inverso con `reversalOfId`. Se implementa en 2b; en 2a solo queda el valor reservado en el enum.
- **D-041** — Fase 2 se ejecuta en dos sesiones: 2a (esta) y 2b.
- **D-042** — El kardex se lleva **siempre en soles**; el documento conserva su moneda y su tipo de cambio. Nació de un hallazgo del `revisor`: sin esto, comprar el mismo ítem en USD y en PEN promediaba dos escalas y el valorizado sumaba monedas distintas.

**RF-15 recuperado.** El docx original saltaba de RF-14 a RF-16 y D-031 ya lo había señalado como faltante. Por el contenido de RF-16 solo puede ser el partido: **RF-15 — Partir una bobina en hijas por ancho, conservando trazabilidad a la madre.** Se implementa en 2b; `coils.parentCoilId` ya existe (siempre `null`) para no migrar dos veces la tabla.

## 4. Bloqueos / pendientes

Ninguno que requiera al dueño. Nada quedó a medias del alcance de 2a.

**Hallazgos de diseño que cambiaron el código (detalle completo en `docs/PROGRESO.md`):** un pago en soles contra una compra en dólares resolvía el tipo de cambio de la moneda del pago y cancelaba el saldo con la cifra equivocada; el kardex mezclaba monedas (→ D-042); `receive` y `addPayment` validaban fuera de la transacción y admitían duplicar movimientos o sobrepagar; una compra de stock sobre una línea `NOOP` creaba bobinas que el kardex descartaba en silencio.

**Hallazgo de seguridad preexistente, corregido en esta fase.** El tracker del rate limit tomaba el primer salto de `X-Forwarded-For`, que el cliente controla y que Cloud Run _añade_ en vez de reemplazar: rotando esa cabecera se anulaba el límite de 10/min de `/auth/login`. Ahora usa `req.ip` (Express con `trust proxy`) y, en el login, el correo. **Queda para Fase 7** el bloqueo temporal de cuenta tras N intentos fallidos, que el auditor recomendó junto con esto.

**Diferido, con su motivo:**

- Anular una compra ya **recibida** y revertir sus movimientos es de Fase 2b (`cancel` hoy solo acepta `DRAFT` sin pagos). Por eso los E2E contra producción dejan una compra COIL recibida con sus 2 bobinas y una EXPENSE recibida que no se pueden deshacer.
- `receive` hace N+1 dentro de la transacción (proveedor, acabado y línea por cada línea) mientras mantiene el lock del correlativo del proveedor. Con compras de pocas líneas no molesta; conviene precargar antes del bucle cuando 2b agregue más operaciones sobre bobinas.
- `previewFromXml` sube el XML a R2 antes de que el usuario confirme: cada preview abandonado deja un objeto huérfano bajo `purchases/xml/`. Va junto con la limpieza de `imports/` ya anotada para Fase 7 (regla de expiración en R2).
- `.xml` dentro de un `.zip` no se soporta: el parser lo detecta por los bytes `PK` y pide extraerlo. Añadir descompresión implica otra dependencia y otro vector de zip bomb; se evalúa si el dueño lo pide.
- `InventoryRefType` tiene `SALE`, `PRODUCTION`, `SPLIT`, `SCRAP`, `CUTTING` y `ADJUSTMENT` reservados sin emisor todavía, y `InventoryMovementType.ADJUST` no lo emite `record` (es de 2b, RF-20). Están en el enum para no migrarlo en cada fase.

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm turbo lint typecheck test              # exit 0 (83 unit)
pnpm format:check                           # exit 0
pnpm e2e                                    # 17 E2E locales contra Neon dev
pnpm e2e:prod                               # auth (6) + fase1 (5) + fase2a (5) contra producción (D-024)
node scripts/prod-e2e-leftovers.mjs         # solo lectura: qué dejaron los E2E en producción
gh run list --limit 3                       # CI en main
pnpm audit --prod --audit-level=high        # sin vulnerabilidades
curl -s https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app/health
curl -s https://ayr-steel-erp-web.vercel.app/api/health
```

Producción:

- Web: https://ayr-steel-erp-web.vercel.app
- API: https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app
- DB: Neon rama `production`, con la migración `20260903120000_fase2a_kardex_compras_bobinas`.

Para redesplegar tras un cambio: el web sale solo con el push a `main`; el API con `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app`. Si se añade una migración, aplicarla primero con `pnpm db:prod`.

## 6. Siguiente sesión

**Fase 2b** (§3.7, D-041): partido de bobina (RF-15, RF-16), merma (RF-17, RF-18), cierre (RF-19), edición (RF-20), anulación (RF-21, RF-22) y las vistas de inventario de bobinas por línea (RF-23).

Primera tarea concreta: **implementar la reversa de movimientos en `InventoryService`**, que es la pieza de la que cuelga todo lo demás de 2b. Hoy `record` solo emite `IN` y `OUT`; falta un `reverse(tx, movementId, actor)` que emita el movimiento inverso apuntando al original con `reversalOfId` (el índice único de esa columna ya garantiza que un movimiento se anule una sola vez) y un `ADJUST` para RF-20, hoy reservado en el enum pero sin emisor. Con eso resuelto, el partido (RF-15) es una salida de la madre más una entrada por hija al mismo costo promedio, la merma (RF-17, D-040) es una salida `refType=SCRAP` y su anulación (RF-18) es la reversa; anular una compra recibida —hoy bloqueado con un mensaje que dice justamente que es de 2b— sale gratis después.

Ojo al empezar: `coils.parentCoilId` ya existe y siempre está en `null`, así que el partido no necesita migrar la tabla; y la línea `services` es `NOOP`, por lo que cualquier operación nueva sobre stock tiene que pasar igual por `InventoryService.record` para heredar ese no-op (regla dura 2 de `CLAUDE.md`).
