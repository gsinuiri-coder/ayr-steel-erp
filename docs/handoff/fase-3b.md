# Handoff — Fase 3b (Reversa de recepción de corte tercerizado) — 2026-09-03

## 1. Resumen

Fase 3b según `docs/ARQUITECTURA.md` §3.7 (D-051, D-052): **cerrada**. Se entregó `CuttingService.reverse()` — deshace la recepción de una bobina de una orden de corte tercerizado (RF-41 a la inversa), simétrico a RF-16 (revertir un partido interno). Cierra el hueco que Fase 3 dejó documentado ("no existe una reversa de recepción de corte").
Estado: `pnpm turbo lint typecheck test build` en verde (121 unit); 41/41 E2E en local y **40/40 contra producción**; migración aplicada en Neon `production`, API redesplegado en Cloud Run, web desplegado por push a `main`, CI verde. `pnpm prod:purge-e2e` extendido y corrido: producción queda con **0 bobinas abiertas con saldo** de prueba.
Revisado por `revisor`, `auditor-seguridad` y `qa` en paralelo: 1 hallazgo alto (corregido antes de commitear), 1 medio (cobertura E2E ampliada) y 1 bajo (dato disponible sin usar en la UI).

## 2. Hecho

1. **Decisiones (punto 1)** — `docs/ARQUITECTURA.md` §0.2 (D-051: Fase 3b se intercala entre 3 y 4; D-052: guardrails de `reverse()`), §3.7 gana la fila "3b". Contexto largo en `docs/DECISIONES.md`.
2. **Prisma (punto 2)** — `cutting_order_coils.reverted_by_id`/`reverted_at`. Migración `20260904130000_fase3b_reversa_recepcion_corte`, **escrita a mano** (no vía `prisma migrate dev`: el shadow database falla al reproducir el historial completo por un problema preexistente de orden de nombres de carpeta entre las migraciones de Fase 3 y Fase 2a/2b — detalle en `docs/PROGRESO.md`, sección "Notas operativas"). Aplicada con `prisma migrate deploy` (`pnpm db:deploy`/`pnpm db:prod`), que no usa shadow database.
3. **`CuttingService.reverse()` (punto 3)** — `apps/api/src/cutting/cutting.service.ts` + `POST /cutting/:id/coils/:coilId/reverse` en `cutting.controller.ts`. Mismo patrón "todo o nada" que RF-16 sobre los flejes; guardrail propio (D-052) sobre la bobina madre: debe estar `OPEN`/`CLOSED` (nunca `IN_THIRD_PARTY` de otro envío, nunca `CANCELLED`) y sin movimientos posteriores a la recepción que se revierte. Si pasa, la fila vuelve a `SENT` y la madre a `IN_THIRD_PARTY` — el envío queda vivo por construcción.
4. **Fix retroactivo (punto 4)** — `revertSplit` (RF-16, `coil-operations.service.ts`) no bloqueaba `IN_THIRD_PARTY`: mismo hueco que Fase 3 ya había cerrado en `registerScrap`/`cancel`/`setStatus`/`PurchasesService.cancel`, pero que no existía todavía cuando se escribió `revertSplit`. Corregido.
5. **Web (punto 5)** — botón "Revertir" en `/corte/[id]` para filas `RECEIVED`, reusa `ReasonDialog` (mismo componente que RF-16/RF-21/RF-18).
6. **Revisión (punto 6)** — `revisor`, `auditor-seguridad` y `qa` en paralelo. Detalle abajo y en `docs/PROGRESO.md`.
7. **Tests (punto 7)** — sin unit tests nuevos (mismo patrón que RF-16/`receive`/`cancel`: la lógica transaccional se cubre por E2E, no por Jest). `e2e/tests/fase3b.spec.ts`: 6 escenarios.
8. **Deploy (punto 8)** — `pnpm db:prod`, `pnpm deploy:api --web-origin …`, push a `main` (el web sale solo), `pnpm e2e:prod` 40/40.
9. **Purga de producción (punto 9)** — `scripts/prod-e2e-purge.mjs` ganó un paso previo que revierte toda recepción de corte E2E `RECEIVED`/`PARTIALLY_RECEIVED` (revirtiendo antes cualquier partido local posterior sobre la madre) antes de cancelar lo pendiente y anular compras/bobinas.

## 3. Decisiones tomadas

- **D-051** — Fase 3b se intercala entre Fase 3 y Fase 4: cierra el hueco de la reversa de recepción de corte antes de que Fase 4 (producción) empiece a consumir flejes, mismo criterio de secuenciación que D-041 (2a/2b).
- **D-052** — Guardrails de `CuttingService.reverse()`: la bobina madre debe estar `OPEN`/`CLOSED` y sin movimientos posteriores a la recepción que se revierte (D-050 permite reenviar una bobina a otra orden sin dejar rastro de kardex, algo que RF-16 nunca tuvo que contemplar). Con ambos guardrails en verde, el resultado es siempre `IN_THIRD_PARTY` — no existe hoy un camino de código donde la reversa termine en un "disponible" ambiguo; si algo lo haría ambiguo, ya bloqueó antes.

## 4. Bloqueos / pendientes

Ninguno que requiera al dueño.

**Hallazgos que cambiaron el código:**

- **Alto (`revisor`).** `reverse()` armaba la lista de flejes de una recepción con una consulta sin filtrar por `status`, mezclando los `CANCELLED` de una recepción anterior (recibir → revertir → recibir de nuevo) con los vivos de la actual, tanto en el audit log como en el detalle que ve la UI. Corregido: los flejes de la generación actual se derivan de los movimientos de kardex vivos, y `findOne()` excluye `CANCELLED` de la relación `strips`. `qa` agregó un E2E dedicado que reproduce el ciclo completo y confirma que no se mezclan.
- **Medio (`revisor`).** Cobertura E2E ampliada con los dos guardrails propios de D-052 (madre reenviada a otra orden, madre con movimiento posterior) que no estaban probados.
- **Bajo (`revisor`).** El DTO expone `revertedAt` pero la UI todavía no lo muestra. No bloqueante, queda como mejora futura si hace falta.

**Diferido, sin motivo para atenderlo ahora:**

- El nombre de la carpeta de migración de Fase 3 (`20260903031603_fase3_corte_flejes`) rompe el shadow database de `prisma migrate dev` para siempre reproducir el historial desde cero (ver punto 2). Arreglarlo implica renombrar una migración ya aplicada en `production`, una operación de riesgo que no se intentó sin autorización explícita del dueño. Mientras tanto, cualquier migración nueva debe escribirse a mano y aplicarse con `prisma migrate deploy`.
- `F001-403036715` (compra `SERVICE RECEIVED` de prueba con un pago registrado) sigue sin poder anularse en producción — mismo límite ya documentado en el cierre de Fase 2a, no relacionado a corte tercerizado.

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm turbo lint typecheck test build      # exit 0 (121 unit)
pnpm format:check                         # exit 0 (salvo .claude/settings.json, ajeno a esta sesión)
pnpm e2e                                  # 41 E2E locales contra Neon dev
pnpm e2e:prod                             # auth+fase1+fase2a+fase2b+fase3+fase3b contra producción
pnpm prod:purge-e2e --dry-run             # qué dejaría limpio; sin la bandera, lo anula/revierte
node scripts/prod-e2e-leftovers.mjs       # solo lectura: qué dejaron los E2E en producción
gh run list --limit 3                     # CI en main
curl -s https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app/health
```

Producción:

- Web: https://ayr-steel-erp-web.vercel.app (`/corte/[id]` gana el botón "Revertir" en filas `RECEIVED`)
- API: https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app
- DB: Neon rama `production`, con la migración `20260904130000_fase3b_reversa_recepcion_corte`.

Para redesplegar tras un cambio: el web sale solo con el push a `main`; el API con `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app`. Si se añade una migración, escribirla a mano (ver punto 2 de "Hecho") y aplicarla con `pnpm db:prod` antes de desplegar el API.

## 6. Siguiente sesión

**Fase 4** (§3.7, D-047/D-048): producción drywall + terminal `/planta` (RF-32..35, RF-38, RF-39), con el consumo de materia prima ya decidido en D-047 (kg teórico por dimensiones × `densityFactor`, override de kg real, diferencia como merma automática).

Primera tarea concreta: **modelar la corrida de producción de drywall** consumiendo flejes (`coils kind=STRIP`, construidos en Fase 3). Lo que Fase 3b deja listo y no hay que rehacer:

- **Ya no hay hueco de reversa.** Si producción de Fase 4 recibe mal un fleje o necesita deshacer un consumo, el patrón de `CuttingService.reverse()` (revertir lo más reciente primero, con guardrail de "sin movimientos posteriores") es directamente reusable para lo que necesite deshacerse ahí; no hay que reinventar el criterio.
- **El patrón OUT+IN con `InventoryService.record` y `CoilsService.lockCoil`** sigue siendo el que va a usar el consumo de producción; `refType=PRODUCTION` ya está reservado en el enum desde Fase 2a.
- **D-047 ya resolvió la pregunta de diseño** (kg teórico vs. real): la corrida de producción calcula el teórico, permite el override, y la diferencia sale como `SCRAP`, mismo mecanismo que la merma de bobina (D-040).

Ojo al empezar: la migración de Fase 3 (`20260903031603_fase3_corte_flejes`) sigue rompiendo el shadow database de `prisma migrate dev`; cualquier migración de Fase 4 necesita el mismo flujo manual + `prisma migrate deploy` documentado en el punto 2 de "Hecho" arriba.
