# Handoff — Fase 2b (Partido, merma, cierre, edición y anulación) — 2026-09-04

## 1. Resumen

Fase 2b según `docs/ARQUITECTURA.md` §3.7 (D-041): **cerrada**. Se entregaron la reversa de movimientos de kardex —la pieza de la que cuelga todo lo demás—, el partido de bobina y su reversa, la merma y su anulación, el cierre/apertura, la edición con recosteo, la anulación de bobina y de compra recibida, el landed cost (D-043) y las vistas `/inventario`, `/kardex` y `/bobinas/[id]`.
Estado: `pnpm turbo lint typecheck test` en verde (111 unit); 31/31 E2E en local y **30/30 contra producción**; migración aplicada en Neon `production`, API redesplegado en Cloud Run, web desplegado por push a `main`, CI verde (corrida 33707954677).
Revisado por `revisor` (API y web, en dos pasadas), `auditor-seguridad` y `qa`: 3 bloqueantes y 7 altos corregidos, uno de ellos encontrado por `qa` al escribir los E2E.

## 2. Hecho

1. **Decisiones y requisitos** — `docs/ARQUITECTURA.md` §0.2 (D-043..D-046), §4.2 con RF-22 anotado como Fase 3, §5 con P-12 nueva y resuelta. Contexto largo en `docs/DECISIONES.md`.
2. **Reversa de kardex (punto 1)** — `apps/api/src/inventory/inventory.service.ts`. `reverse` emite el movimiento inverso con `reversalOfId` bajo el mismo lock del saldo que `record`, arrastrando el **valor original** y no el promedio del momento: revertir un ingreso saca exactamente el costo que metió. Idempotente por el índice único de `reversal_of_id` (la carrera termina en 409, no en doble movimiento). `adjustCost` mueve costo sin mover cantidad, y `live-movements.ts` descarta los pares que se cancelan entre sí.
3. **Partido (punto 2)** — `apps/api/src/coils/coil-split-math.ts` (aritmética pura, probada sola) y `coil-operations.service.ts`. El peso se reparte por ancho **sobre el ancho de la madre**; lo que las hijas no cubren es pérdida de corte. `coil_splits` agrupa la salida de la madre y las entradas de las hijas para poder revertir el partido entero (RF-16), bloqueado si alguna hija ya se movió.
4. **Merma, cierre, edición y anulación (puntos 3 y 4)** — RF-17/18 como salida `SCRAP` al promedio vigente (D-040) y su reversa con motivo; RF-19 abrir/cerrar; RF-20 con el recosteo de D-045 (reversa + ingreso nuevo, nunca `UPDATE`); RF-21 anular con reversa del ingreso.
5. **Anulación de compra y landed cost (punto 5)** — `apps/api/src/purchases/purchases.service.ts`. `cancel` acepta compras recibidas, revierte sus movimientos vivos y nombra qué la bloquea. D-043: una compra `SERVICE` `FREIGHT`/`CUSTOMS`/`INSURANCE` vinculada por `relatedPurchaseId` reparte su costo sin IGV por kg entre las bobinas con saldo (`landed-cost.ts`), como `ADJUST` de costo.
6. **Web (punto 6)** — `/inventario` (tabs por línea, bobinas agregadas por `typeKey`, valorizado en soles), `/kardex?item=` (saldo corrido, motivo y anulaciones) y `/bobinas/[id]` (datos, partidos, hijas, kardex y las acciones por rol). `components/reason-dialog.tsx` centraliza la confirmación con motivo obligatorio.
7. **Tests (punto 7)** — 111 unit: reversa de IN/OUT/ADJUST, doble reversa, promedio tras `IN-IN-OUT-reversa`, ajuste de costo y su anulación (`inventory.service.spec.ts`); prorrateo del partido, validación de anchos y piso de aprovechamiento (`coil-split-math.spec.ts`); prorrateo de landed cost sin céntimos perdidos (`landed-cost.spec.ts`). E2E: `e2e/tests/fase2b.spec.ts` con 14 escenarios.
8. **Revisión (punto 8)** — `revisor` sobre el API y sobre el web, `auditor-seguridad` sobre el API (con segunda opinión de `agy`), `qa` sobre los E2E. Detalle en `docs/PROGRESO.md`; los que cambiaron el diseño están abajo.
9. **Deploy (punto 9)** — `pnpm db:prod`, `pnpm deploy:api --web-origin …`, push a `main` (el web sale solo), `pnpm e2e:prod` 30/30 y `pnpm prod:purge-e2e`.

## 3. Decisiones tomadas

- **D-043** (cierra P-12) — Landed cost: una compra `SERVICE` de flete, aduanas o seguro se vincula a una compra `COIL` y su costo sin IGV se prorratea **por kilo** entre sus bobinas, como `ADJUST` de costo en el kardex. Default por recomendación del agente; el dueño puede revertirlo antes de Fase 3 y el cambio sería dejar de crear el vínculo, sin migrar nada.
- **D-044** — RF-22 (cancelar el plan de corte) pasa a Fase 3: en 2b no existe todavía el plan de corte, así que no hay nada que cancelar.
- **D-045** — Editar la moneda, el tipo de cambio o el costo de una bobina solo se permite sin movimientos posteriores al ingreso, y recuesta ese ingreso vía reversa + movimiento nuevo. El kardex es append-only y el promedio ponderado es acumulativo: reescribir hacia atrás un ingreso ya consumido rompería operaciones que ya se valorizaron.
- **D-046** — Quién anula qué, precisando §3.4: el supervisor deshace lo que él mismo registra en planta (revertir partido, anular merma); anular una bobina o una compra y editar costos son de ADMINISTRADOR. Nació de una ambigüedad que señaló el `revisor` entre §3.4 y el controlador.

## 4. Bloqueos / pendientes

Ninguno que requiera al dueño. Nada quedó a medias del alcance de 2b.

**Lo único que espera decisión humana es D-043**, y no bloquea: está implementado con el default recomendado. Si el dueño prefiere tratar el flete como gasto del período, avisarlo antes de Fase 3.

**Hallazgos que cambiaron el código (detalle completo en `docs/PROGRESO.md`):**

- **Bloqueante.** Ninguna de las cuatro validaciones excluía los **pares movimiento+reversa**: una merma registrada y anulada dejaba la bobina y su compra sin poder anularse nunca, pidiendo anular algo que el usuario ya había anulado. Tres las corrigió el `revisor`; la cuarta —`cancel` de compra— la encontró `qa` al escribir los E2E de RF-20 y RF-21.
- **Bloqueante.** Cambiar una bobina de soles a dólares sin tipo de cambio recosteaba el kardex a un sexto de su valor, en el API (schema) y otra vez en el web (el diálogo mandaba el `1.0000` heredado).
- **Alto.** El partido prorrateaba el peso sobre `Σ anchos` en vez del ancho de la madre: una tira angosta se llevaba los kilos de toda la bobina y el recorte de borde desaparecía del kardex. Se corrigió el reparto y se agregaron un ancho mínimo por hija y un piso de aprovechamiento del 80 %, para que un partido no pueda usarse como baja encubierta.
- **Alto (seguridad).** El landed cost era alcanzable por SUPERVISOR_PLANTA: una factura de flete inventada movía el costo promedio del inventario sin tope y sin que él pudiera revertirlo. Ahora exige ADMINISTRADOR y la misma línea de negocio.
- **Medio (seguridad).** `/inventory/*` no declaraba roles y le mostraba los costos de compra a VENDEDOR. Los campos de costo viajan en `null` para su rol, que conserva la lectura de cantidades de §3.4.

**Diferido, con su motivo:**

- Los E2E operan el partido, la merma y las anulaciones **por API**; la UI se verifica en lectura. Encadenar los diálogos en Playwright agrega flakiness sin cubrir lógica nueva.
- `/kardex?item=` con filtro de fechas no tiene E2E; su saldo de apertura se verificó a mano contra `inventory_balances` en Neon `dev`.
- `findMovements` de un ítem lee hasta 10 000 movimientos para el saldo corrido. Con años de historia hay que paginar hacia atrás desde el saldo de apertura, que ya está implementado.
- Anular una compra de 200 líneas revierte 200 movimientos en una transacción (timeout subido a 120 s). Si el volumen crece, moverlo a un job de pg-boss con estado `CANCELLING`.
- El prorrateo de landed cost es siempre por kg. Si aparece un seguro que se cobra sobre el valor CIF, se agrega el criterio como campo de la compra.

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm turbo lint typecheck test              # exit 0 (111 unit)
pnpm format:check                           # exit 0
pnpm e2e                                    # 31 E2E locales contra Neon dev
pnpm e2e:prod                               # auth (6) + fase1 (5) + fase2a (5) + fase2b (14) contra producción (D-024)
pnpm prod:purge-e2e --dry-run               # qué dejaría limpio; sin la bandera, lo anula
node scripts/prod-e2e-leftovers.mjs         # solo lectura: qué dejaron los E2E en producción
gh run list --limit 3                       # CI en main
pnpm audit --prod --audit-level=high        # sin vulnerabilidades
curl -s https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app/health
```

Producción:

- Web: https://ayr-steel-erp-web.vercel.app
- API: https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app
- DB: Neon rama `production`, con la migración `20260904120000_fase2b_reversa_partido_merma_landed_cost`.

Tras `pnpm e2e:prod`, correr `pnpm prod:purge-e2e`: la suite deja bobinas con saldo que `/inventario` sumaría como stock real (S/ 113 000 la última vez). Después de la limpieza quedan 0 bobinas abiertas con saldo y el kardex conserva el rastro completo.

Para redesplegar tras un cambio: el web sale solo con el push a `main`; el API con `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app`. Si se añade una migración, aplicarla primero con `pnpm db:prod`.

## 6. Siguiente sesión

**Fase 3** (§3.7): corte tercerizado y flejes — RF-40 (enviar bobinas a un tercero con plan de anchos), RF-41 (recibir los flejes y prorratear el costo del servicio por peso), RF-42 (stock de flejes por ancho) y **RF-22** (cancelar el plan de corte), que D-044 movió a esta fase.

Primera tarea concreta: **modelar el plan de corte** (`cutting_plans` o similar) con sus anchos y su proveedor de corte, apoyándose en lo que 2b ya dejó construido. Las tres piezas grandes ya existen y no hay que rehacerlas:

- **El partido (RF-15) es el corte.** `planCoilSplit` ya reparte el peso por ancho sobre el ancho de la madre y `CoilOperationsService.split` ya crea las hijas con su código correlativo, su herencia de acabado/espesor/costo y su kardex. Un fleje recibido de un tercero es una bobina hija con otro `refType`; lo nuevo es el **envío** (una salida sin hijas todavía) y la **recepción** contra ese envío.
- **El prorrateo del costo del servicio ya está resuelto.** `prorateByWeight` (`apps/api/src/purchases/landed-cost.ts`) y `InventoryService.adjustCost` son exactamente lo que pide RF-41; el `serviceKind` `CUTTING` está reservado desde 2a y D-043 lo excluyó a propósito del landed cost porque prorratea contra los flejes, no contra las bobinas de la compra.
- **RF-22 sale casi gratis** con `reverse`: cancelar un plan de corte es revertir su salida, igual que `revertSplit`, bloqueado si los flejes ya se movieron.

Ojo al empezar: el costo del corte se ingresa **al recibir** los flejes, no antes (D-033), y varios proveedores pueden prestar el servicio a la vez (`suppliers.providesCuttingService`, que existe desde Fase 1 y todavía no lo consume nadie). Y la regla dura 2 sigue valiendo: cualquier movimiento de stock nuevo pasa por `InventoryService`, que es lo que le da a la línea `services` su no-op gratis.
