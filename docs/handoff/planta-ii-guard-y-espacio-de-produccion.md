# Handoff — Sesión Planta II — 2026-09-09

## 1. Resumen

Tres decisiones, y las tres nacen del mismo lugar: **el sistema le decía que no a la persona
que no podía resolverlo**. D-154 convierte el faltante de materia prima en aviso dentro de
producción y arregla dos defectos de cuenta que lo disparaban sin motivo; D-155 reemplaza la
tanda por el espacio de producción del pedido, con el ciclo completo por pestaña y guardado
por orden; D-156 saca el callejón de los campos que exigen elegir de un maestro.

`pnpm turbo lint typecheck test build` en verde (**291/291** unitarios) y
`pnpm exec prettier --check` limpio. E2E local: **8/8** de los specs nuevos y **27/27** de la
regresión de coberturas.

**Nada desplegado y sin push**; producción no se tocó ni para leer.

---

## 2. Hecho

### M0 — El guard de reservas de materia prima (D-154)

El síntoma que trajiste: planta montaba una bobina llena de material y el API la rechazaba con
_«la operación dejaría 0.000 kg libres de Bobina 0.45 mm ROJO y hay 150.000 kg prometidos a
PED-000003»_ — sobre **el pedido que estaba fabricando**. Eran **tres defectos superpuestos
detrás del mismo mensaje**, y solo uno de los tres era la severidad.

1. **El pedido se bloqueaba a sí mismo.** Un pedido de coberturas reserva una vez **por
   línea** y genera una OP por reserva (D-084/D-148), así que montar la bobina de la línea 1
   se comprobaba contra la promesa viva de la línea 2 del mismo pedido. Entra
   `exceptSalesOrderIds` y se exceptúa el pedido entero
   (`apps/api/src/sales/raw-material.ts`).
2. **Montar sacaba el rollo entero del agregado.** Planta monta los 5 000 kg del rollo para
   cortar los 200 que el pedido prometió. La causa era un **doble descuento**: una OP con
   pedido detrás ya tiene su compromiso contado como reserva genérica, y sumarle la custodia
   contaba dos veces el mismo kilo. `StripAssignment.heldKg` es ahora **cero** con reserva y
   `assignedKg − consumedKg` solo en corridas **a stock**
   (`apps/api/src/production/production-assignments.ts`).
3. **La severidad.** `mountCoil`, `report` y `close` usan `findRawMaterialShortfalls`, que
   **devuelve** los faltantes en vez de lanzarlos: viajan en
   `ProductionOrderDto.rawMaterialWarnings`, van al `audit_log` y se persisten en
   `production_reports.raw_material_warning`. **Fuera de producción no cambia nada**: ventas,
   corte, bobinas y kardex siguen recibiendo el 400 de siempre.

De paso cayó el tope duro de D-146 sobre el **kg declarado**: pasa a aviso de desviación
(`roofingConsumptionDeviation` en `packages/shared/src/schemas/production.ts`, banda de ±10 %
más el aviso de acumulado sobre el plan), calculado con la misma función en el API y en la
pantalla. **El tope de metros del plan sigue siendo duro.**

Migración: `20260909100000_d154_aviso_de_materia_prima_en_el_reporte` (aditiva, `TEXT`
nullable).

### M1 — El espacio de producción del pedido (D-155)

`apps/web/src/app/(app)/planta/producir/producir-view.tsx`. Una pestaña por orden —lista
lateral master-detail por encima de `MAX_ORDER_TABS = 6`— con indicador **sin bobina / lista /
reportada**, y adentro el ciclo completo: montar o cambiar la bobina con el mismo selector y
los mismos endpoints que el detalle de la orden, ML plan / reportado / restante / kg teórico,
e inputs de salida y kg consumido. Barra de progreso arriba.

**El guardado es por orden**, y cada uno sigue siendo atómico del lado del API (reporte +
kardex en una transacción vía `InventoryService.record()`).
`POST /production/roofing/batch` se eliminó junto con `reportBatch`, `splitBatchRow` y sus
schemas; el `GET` queda y suma `reservationId` y, por bobina, `consumptionId` y `consumedKg`.
`/planta/tanda` quedó como **redirección** conservando `?pedido=`.

Enlaces: el detalle del pedido gana **Producir (N)**, el detalle de la orden el enlace a sus
hermanas, y `/planta` cambia «Reportar en tanda» por «Producir un pedido». El sidebar
(`apps/web/src/lib/nav.ts`) pasa a **Órdenes de producción**, **Producir un pedido** y
**Terminal de planta**.

Una orden con unidad `NIU` —plancha de catálogo a stock, D-140— captura **planchas** y no
metros: la terminal ya distinguía las dos unidades y capturar siempre metros habría hecho que
escribir `3` reportara **una** plancha sin ningún error.

### M2 — El importador de cotizaciones (D-156)

`apps/web/src/app/(app)/cotizaciones/importar/importar-view.tsx`. Acordeón por comprobante
—número, cliente, total y estado de validación en la cabecera; las líneas al expandir, y se
abre solo lo que llegó con algo sin resolver—. Junto a cada campo que exige elegir de un
maestro hay un botón **crear** que abre **el mismo formulario de alta**
(`apps/web/src/components/express-create.tsx`, sobre `CustomerDialog` y `ProductDialog`
movidos a `components/` con `initial` y `onCreated`): mismas validaciones, mismo endpoint, y
**el estado del preview no se pierde**. Los desplegables de más de 50 opciones pasan a un
modal de búsqueda con tabla y filtro (`apps/web/src/components/search-select-modal.tsx`).

### M3 — Auditoría «campo sin opción = callejón»

Tabla completa en `docs/PROGRESO.md`. Resuelto en los de mayor uso —las dos puntas del
formulario de cotización y pedido (`components/sales/sales-document-form.tsx`) y las dos del
importador—; el resto (compra, orden de corte, alta de bobina, comprobante nuevo) queda
anotado. El mostrador ya tenía «Crear y usar».

### M4 — Entorno

`pnpm dev:preview` (`scripts/dev-preview.mjs`) levanta api `:4000` + web `:4001` contra
`ayr_local` —**nunca** contra `ayr_local_e2e`, que la suite vacía en cada corrida—. Es
**regla dura 15** de `CLAUDE.md`: el agente no usa ni mata esos puertos. Usa el `run` de
`scripts/lib.mjs` en vez de armar su mensaje de error con `args.join(' ')`, que es la forma
que la regla dura 5 nombra como el escape de D-128.

---

## 3. Decisiones tomadas

| ID        | Una línea                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D-154** | En producción de coberturas el faltante de materia prima avisa y nunca bloquea, y la promesa del propio pedido —todas sus líneas— no cuenta nunca en contra. |
| **D-155** | El espacio de producción del pedido: una pestaña por orden con el ciclo completo adentro y guardado por orden. Retira la tanda de D-147.                     |
| **D-156** | Ningún campo obligatorio es un callejón: si falta la opción se crea desde ahí, con el alta de siempre y sin perder lo cargado.                               |

RF actualizados: RF-31 (el faltante avisa), RF-39 (`/planta/producir` reemplaza a la tanda) y
RF-52 (acordeón y alta express en el importador). `CLAUDE.md` gana la **regla dura 15**.

---

## 4. Bloqueos y pendientes

### Lo que necesita acción tuya

- **Dar el OK para desplegar.** Está commiteado en local y **sin push**.
- **Mirar el nombre de los tres sitios de producción en el menú** —«Órdenes de producción»,
  «Producir un pedido», «Terminal de planta»—: la propuesta es que el sustantivo diga el
  objeto (una orden se gestiona, un pedido se produce) en vez del sitio. Si preferís otros,
  es un cambio de una línea en `apps/web/src/lib/nav.ts`.
- **Los servidores de `pnpm dev:local` quedaron abajo**; `pnpm dev:preview` es tuyo cuando lo
  quieras.

### Anotado, no hecho

- **La bobina montada ahora cuenta como material disponible para prometer.** Es la
  consecuencia visible de D-154 y conviene que la veas: el panel de stock de un rollo de
  1 000 kg montado en una OP con 48 kg prometidos pasa de mostrar `0.000` a `952.000`. Es
  correcto —esos kilos vuelven al almacén cuando la orden cierre— y el `0.000` anterior era
  el bug mirado desde la pantalla de ventas, que decía que no había material sobre un rollo
  intacto. La restricción que **sí** sigue viva es de agenda y no de material: mientras esté
  montada, ninguna otra OP puede montar esa bobina (`assertStripsNotAssigned`).
- **El aviso del agregado no distingue "falta hoy" de "falta cuando venza".** Dice qué pedidos
  quedan cortos y por cuántos kilos, pero no mira fechas prometidas: un pedido para dentro de
  un mes pesa igual que uno de mañana. Si el aviso empieza a aparecer seguido, la cola de
  D-094 ya tiene el semáforo de fecha para ordenarlos.
- **`apps/api/prisma/reset-test-db.ts` no vacía `production_orders`, `sales_orders`,
  `quotations`, `products` ni `customers`** (sí el kardex, las bobinas, las compras y los
  usuarios). Los demás specs no lo notaban porque filtran por sus propios ids; `/planta/producir`
  sin `?pedido=` es la primera pantalla que muestra **todo** lo abierto, así que es la primera
  donde la basura acumulada entre corridas se ve —el spec de UI se topó con seis órdenes
  huérfanas—. No se tocó en esta sesión: cambiar qué trunca el reset puede romper specs que
  hoy dependen de que algo sobreviva, y eso se mira con la suite completa delante.
- **Las series manuales, la corrección de un manual y `7f`** siguen igual que en el handoff
  anterior; ninguna se tocó.
- **`docs/analisis/e2e-velocidad.md`** es tuyo y quedó sin commitear (solo se le pasó
  Prettier para que no rompa `format:check` si algún día entra).

---

## 5. Cómo verificar

```bash
pnpm turbo lint typecheck test build     # verde (291/291 unitarios)
pnpm exec eslint e2e
pnpm exec prettier --check apps packages docs CLAUDE.md scripts e2e

# **Antes de correr E2E**: matar cualquier servidor viejo en :3000/:3001 — `reuseExistingServer`
# reusa el que encuentre y el síntoma es `Login admin falló: 401`. NO tocar :4000/:4001.
netstat -ano | grep LISTENING | grep ":300"

pnpm e2e planta-producir planta-producir-avisos planta-producir-ui   # D-154 y D-155
pnpm e2e fase6 fase6-bordes fase7final-op-a-stock fase7-consolidada  # regresión de coberturas
```

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126).

### Checklist de deploy — sin correr, esperando tu OK

```bash
pnpm turbo lint typecheck test build && pnpm format:check && pnpm exec eslint e2e
pnpm db:prod     # incluye 20260909100000_d154_aviso_de_materia_prima_en_el_reporte
pnpm deploy:api
# Web: por push a main (integración Vercel-GitHub)
pnpm smoke:prod  # solo lectura (D-126)
```

**La migración va primero, pero esta vez no es crítica**: es aditiva y nullable, así que el
API viejo contra la base migrada funciona igual. Lo que **sí** rompe es el API nuevo contra la
base sin migrar, porque `report` escribe `raw_material_warning`. Siguen pendientes además las
migraciones de las tres sesiones anteriores (D-145, D-146 y las dos de D-153).

---

## 6. Siguiente sesión

1. **Usar lo que se construyó**: cargar agosto con el importador de cotizaciones (D-152),
   registrar sus comprobantes con el modo manual (D-153) y producir esos pedidos desde
   `/planta/producir`. Es el ciclo completo que estas cuatro sesiones vinieron a habilitar, y
   la primera vez que las tres decisiones nuevas se van a ver juntas contra datos reales.
2. **Fase 8 — auditoría, reportes y UAT**, la siguiente según §3.7.
3. **7f sigue sin alcance escrito**, arrastrado desde hace cuatro handoffs.
