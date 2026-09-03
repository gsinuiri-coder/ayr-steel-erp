# Handoff — Fase 4 (Producción de drywall y terminal `/planta`) — 2026-09-03

## 1. Resumen

Fase 4 según `docs/ARQUITECTURA.md` §3.7 (D-055..D-060): **cerrada**. Se entregó el módulo `production` — orden de producción de perfiles de drywall que consume flejes y produce piezas, con trazabilidad completa hasta la bobina madre — más la terminal de planta `/planta` (RF-39) y las vistas de administración `/produccion` y `/produccion/[id]`.
Estado: `pnpm turbo lint typecheck test build` en verde (137 unit); **57/57 E2E en local** y **56/56 contra producción**; migraciones aplicadas en Neon `dev` y `production`, API redesplegado en Cloud Run, web desplegado por push a `main`, **CI verde** (corrida 33786845045). `pnpm prod:purge-e2e` deja producción con **0 bobinas abiertas con saldo y 0 piezas de prueba en stock**.
Revisado por `revisor` (dos pasadas: API y web por separado), `auditor-seguridad` y `qa`: **1 bloqueante, 5 altos y 8 medios corregidos**, más un defecto preexistente de Fase 2b que `qa` encontró.

## 2. Hecho

1. **Decisiones (punto 1)** — `docs/ARQUITECTURA.md` §0.2 gana D-055..D-060; §3.2 corrige el listado de módulos; §3.7 anota que **RF-38 pasa a Fase 5** (el indicador cuenta cotizaciones, que todavía no existen) y que RF-32 sí queda cubierto para drywall vía la receta. Contexto largo en `docs/DECISIONES.md`.
2. **Prisma (punto 2)** — `product_boms`, `production_orders`, `production_order_consumptions`, `production_reports` y los enums `ProductionOrderStatus`/`ProductionReportStatus`. Migraciones `20260904140000_fase4_produccion_drywall` y `20260904141000_fase4_orden_de_reportes`.
3. **Módulo `production` (punto 3)** — `apps/api/src/production/`: `boms.service.ts` (receta, D-059), `production.service.ts` (OP, consumo, reportes parciales, cierre, reapertura, anulación), `production-math.ts` (+ `.spec.ts`), `production-assignments.ts` (guardrail), `production.controller.ts`.
4. **Guardrail D-060 (punto 4)** — `assertStripsNotAssigned` en `coil-operations.service.ts` (merma, anulación de merma, partido, reversa de partido, cierre, edición, anulación), `cutting.service.ts` (reversa de recepción) y `purchases.service.ts` (anulación de compra, landed cost, costo de corte). Vive como función suelta para no meter a esos tres módulos en un ciclo con `production`.
5. **Las tres reversas (punto 5)** — `reverseReport` (último reporte vigente), `reopen` (deshace merma y costeo del cierre) y `cancel` (sin reportes vigentes, libera los flejes sin tocar kardex).
6. **Web (punto 6)** — `apps/web/src/app/(app)/planta/` (captura de operario, mobile-first), `produccion/` y `produccion/[id]/`, `catalogo/bom-dialog.tsx` (receta en el maestro) y `src/lib/production-queries.ts`.
7. **Tests (punto 7)** — 12 unit nuevos en `production-math.spec.ts` (kilo teórico, reparto entre flejes, costeo, ajuste del cierre). 137 unit en total.
8. **Revisión (punto 8)** — `revisor` ×2, `auditor-seguridad` y `qa`. Detalle en `docs/PROGRESO.md`.
9. **E2E (punto 9)** — `e2e/tests/fase4.spec.ts` (5 escenarios de flujo) y `e2e/tests/fase4-bordes.spec.ts` (11 de bordes, escritos por `qa`), con el escenario compartido en `e2e/helpers/production.ts`.
10. **Deploy y purga (puntos 10-11)** — `pnpm db:prod`, `pnpm deploy:api --web-origin …`, push a `main` (el web sale solo), `pnpm e2e:prod` 56/56, `pnpm prod:purge-e2e`.

## 3. Decisiones tomadas

- **D-055** — La unidad primaria del producto terminado de drywall son las **piezas** (`NIU`); el kilo es derivado (`piezas × kgPerPiece`).
- **D-056** — Costo de la pieza en v1 = costo real de los flejes consumidos / piezas buenas; la merma la absorben las piezas. Sin mano de obra ni overhead: el término existe y vale cero, como hook de D-035.
- **D-057** — La merma de proceso sale sola al cerrar, por diferencia entre los kilos asignados y el teórico de las piezas buenas. Por encima del 10 % exige motivo escrito; no se anula por RF-18, se deshace reabriendo la orden.
- **D-058** — La OP reporta piezas en N eventos y se cierra explícitamente (patrón RF-41). Estados `DRAFT` → `IN_PROGRESS` → `CLOSED` | `CANCELLED`.
- **D-059** — La receta vive en el maestro de productos. El fleje **no tiene SKU** (D-049 lo hace una fila de `coils`): se identifica por acabado + espesor + ancho, el mismo trío con el que RF-42 agrupa el stock de flejes.
- **D-060** — Consumir un fleje es **asignarlo** y no mueve kardex (criterio de D-050); a cambio queda bloqueado para toda otra operación mientras la OP viva. Las tres reversas van en esta misma fase, no en una "4b".

## 4. Bloqueos / pendientes

Ninguno que requiera al dueño para seguir con Fase 5.

**Hallazgos que cambiaron el código** (detalle completo en `docs/PROGRESO.md`):

- **Bloqueante.** `cancelScrap` (RF-18) aceptaba la merma de proceso del cierre —misma firma que una merma de RF-17—, y anularla devolvía kilos **y** valor al fleje mientras las piezas conservaban el costo absorbido: valor creado de la nada. Se distinguen por `refId`.
- **Alto (ajeno a la fase).** El árbol de trabajo traía `.claude/settings.json` con el `deny` de `Read(./.env*)` eliminado y `Bash(sed:*)` agregado al `allow`: cualquier agente podía leer `.env.setup` sin permiso. Restaurado y ampliado a `Read(**/.env*)`. **El cambio venía de antes de esta sesión**; conviene revisar por qué se quitó.
- **Altos.** `reopen()` no exigía fleje `OPEN` y se saltaba el chequeo de movimientos posteriores para los flejes consumidos enteros; landed cost (D-043) y costo de corte (RF-41) recosteaban flejes de una OP viva sin pasar por el guardrail; el diálogo de receta congelaba el kilo por pieza de una geometría anterior (mismo patrón que el tipo de cambio heredado que fue bloqueante en Fase 2b) y no cubría el error de la consulta de acabados.
- **Defecto preexistente de Fase 2b (`qa`).** `split()` (RF-15) creaba las hijas sin `kind`, así que partir un **fleje** devolvía bobinas: ese material se caía del stock de flejes y no se podía perfilar nunca — y dejaba inalcanzable el guardrail que D-060 acababa de agregar a `revertSplit`. La hija ahora hereda la clase de la madre.

**Diferido, con motivo:**

- **Anular un pago a proveedor no existe.** D-039 lo dio por hecho para Fase 2b y nunca se construyó. Es lo único que impide dejar producción sin ningún rastro de pruebas: quedan **6 comprobantes de servicio con un pago registrado** (cinco en `DRAFT`, sin efecto en inventario). También significa que hoy un pago mal registrado no se puede corregir.
- La receta de la OP (`bomId`) apunta a la receta **viva**, no a una versión congelada: una OP cerrada puede mostrar un `kgPerPiece` distinto del que usó. Los datos reales están a salvo en `production_reports.theoreticalKg`.
- `MAX_ORDER_STRIPS` (20) y `MAX_ORDER_REPORTS` (200) y el orden por `seq` bajo concurrencia no tienen E2E: exigen escenarios grandes o carreras.

**Ojo operativo:** `prisma migrate dev` volvió a crear la carpeta con una fecha **anterior** a las migraciones ya aplicadas (el reloj de esta máquina), lo que habría roto el shadow database otra vez (D-053). Se detectó antes de commitear y se renombró a `20260904140000…`. **Revisar el nombre de la carpeta es ahora parte del flujo de cualquier migración nueva.**

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm turbo lint typecheck test build      # exit 0 (137 unit)
pnpm format:check                         # exit 0
pnpm e2e                                  # 57 E2E locales contra Neon dev
pnpm e2e:prod                             # auth+fase1+2a+2b+3+3b+4+4-bordes contra producción
pnpm prod:purge-e2e --dry-run             # qué dejaría limpio; sin la bandera, lo deshace
node scripts/prod-e2e-leftovers.mjs       # solo lectura: qué dejaron los E2E en producción
node scripts/migrations-status.mjs --branch production
gh run list --limit 3                     # CI en main
curl -s https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app/health
```

Si `pnpm e2e:prod` falla en el **primer** test de UI justo después de un deploy, reintentar antes de investigar: es arranque en frío de Vercel (pasó en esta sesión y la repetición quedó verde).

Producción:

- Web: https://ayr-steel-erp-web.vercel.app — nuevas rutas `/planta`, `/produccion`, `/produccion/[id]`, y el botón "Receta" en `/catalogo` para perfiles de drywall.
- API: https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app
- DB: Neon rama `production`, con `20260904140000_fase4_produccion_drywall` y `20260904141000_fase4_orden_de_reportes`.

Para redesplegar tras un cambio: el web sale solo con el push a `main`; el API con `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app`. Si se añade una migración, aplicarla con `pnpm db:prod` **antes** de desplegar el API.

## 6. Siguiente sesión

**Fase 5** (§3.7): cotizaciones + `production_orders` de coberturas + producción de coberturas + ventas (RF-30, RF-31, RF-36, RF-37, RF-38, RF-60..RF-69, RF-73), con el modelo de reserva ya decidido en **D-054**.

Primera tarea concreta: **el ledger de reservas de D-054** (tabla propia, estados `ACTIVA`/`CONSUMIDA`/`LIBERADA`, invariante `disponible ≥ reservado`), porque todo lo demás de la fase cuelga de él. Lo que Fase 4 deja listo y no hay que rehacer:

- **La OP ya está preparada para consumir contra una reserva.** `production_orders.reservation_id` existe y es nullable (D-054/D-060); Fase 5 solo tiene que llenarlo y conectarlo al ledger, sin migrar la tabla.
- **El patrón de guardrail transversal ya está construido y probado.** La invariante `disponible ≥ reservado` de D-054 tiene que bloquear anulación de compra o bobina, merma, envío a corte y consumo ajeno — exactamente los mismos sitios donde `assertStripsNotAssigned` ya se engancha. Copiar esa forma (función suelta, lock antes de aseverar, mensaje que nombra qué bloquea y qué hacer) evita repetir la ronda de hallazgos de esta fase.
- **La producción de coberturas comparte casi todo con la de drywall**: la receta (D-059) necesita otra forma —el largo lo fija el pedido, no el maestro—, pero el ciclo (asignar sin kardex → reportar parciales → cerrar con merma por diferencia → costear) y las tres reversas se reusan tal cual.
- **RF-38 (indicador del menú) y RF-37 (la cola) salen juntos** con las cotizaciones: se movieron a Fase 5 precisamente porque cuentan cotizaciones pendientes de fabricar.
- **Antes de empezar, decidir si se construye la anulación de pago a proveedor** (ver "Diferido"): es barata, cierra el último residuo de producción y Fase 5 va a tocar cuentas por cobrar de todos modos.
