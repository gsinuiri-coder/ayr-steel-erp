# Handoff — Fase 7, tramo 1 (cola de producción) — 2026-09-05

## 1. Resumen

Fase 7 según `docs/ARQUITECTURA.md` §3.7 (D-082), atacada en dos tramos por decisión del dueño:
esta sesión entrega **solo la cola de producción** (RF-37, RF-38) sobre coberturas metálicas
contra pedido. El punto de venta directo (RF-60) y la importación de comprobantes (RF-11,
RF-71, RF-72) quedan en la misma Fase 7, para una sesión futura. Seis decisiones nuevas
(D-092..D-097).

Modelo en una línea: **la cola no es una tabla nueva**, es una vista derivada de `Reservation` +
`ProductionOrder` (D-093) — un pedido está `EN_COLA` cuando tiene una reserva `ACTIVE` de bobina
sobre un producto con receta de coberturas y ninguna OP viva, y `EN_PRODUCCION` en cuanto esa OP
existe. Encima, `fechaEntregaPrometida` (D-096) con semáforo, y prioridad manual excepcional de
ADMINISTRADOR (D-094) que reordena por delante del FIFO.

Estado: `pnpm turbo lint typecheck test build` en verde (**221 unit**, 8 nuevos); **9 E2E
nuevos** (7 + 2 de borde); **110 pasados y 13 saltados contra producción, sin fallos**; una
migración aplicada en `dev` y `production`; API redesplegado. **El web queda pendiente de
desplegar** — token del CLI de Vercel vencido, ver §4. `pnpm prod:purge-e2e` deja producción con
**0 bobinas con saldo, 0 productos con saldo, 0 reservas activas** — después de remediar a mano
un residuo que la propia purga dejó (ver §4, no es un defecto de esta fase).

Lo que más importa de la fase, otra vez, no estaba en el plan: `revisor` encontró que **la
reserva de bobina de una cobertura nunca se drenaba sola** si el vendedor reservó de más o si
planta montó un rollo distinto al reservado (D-086 lo permite). Sin el arreglo, un pedido
despachado entero seguía apareciendo `EN_COLA` para siempre — el defecto exacto que la cola
existe para no tener.

## 2. Hecho

1. **Decisiones (punto 1)** — `docs/ARQUITECTURA.md` §0.2 gana D-092..D-097, §3.7 anota que
   Fase 7 se ataca en dos tramos, RF-37/RF-38 se reescriben para describir la vista derivada.
   Contexto largo en `docs/DECISIONES.md`.
2. **Prisma (punto 2)** — `sales_orders` gana `promised_delivery_date`, `priority_at`,
   `priority_by_id`, `priority_reason`. Una migración, `20260905090000_fase7_cola_prioridad_fecha_prometida`.
3. **La señal de la cola (D-093)** — `SalesOrdersService.findProductionQueue()` y
   `computeQueueStatus()` reusan la señal de "se fabrica contra el pedido" de
   `resolveDispatchTarget` (D-088: receta activa, no subítems), con `kind: ROOFING` agregado
   (D-097) para no confundir una reserva de bobina de otra línea.
4. **`derivePiecesPlan` (D-093)** — extraída de `RoofingProductionService.create()` a
   `roofing-math.ts`, pura, reusada por la cola para mostrar los mismos subítems antes de que la
   OP exista.
5. **Prioridad y fecha prometida (D-094, D-096)** — `PATCH /sales/orders/:id/priority` y
   `PATCH /sales/orders/:id/promised-delivery-date`, solo ADMINISTRADOR, con motivo obligatorio
   en los dos sentidos de la prioridad y auditoría antes/después.
6. **Semáforo (D-096)** — `queueSemaphore()` en `@ayr/shared`: `VENCIDO`/`PROXIMO`/`A_TIEMPO`/
   `SIN_FECHA` sobre `businessToday()` (D-069), nunca UTC.
7. **El saldo de reserva que sobraba al cerrar (D-097)** — `releaseRemainingReservation` en
   `reservation-guard.ts`: al cerrar la OP, lo que quede de la reserva de bobina del pedido se
   libera (`RELEASED`, no `CONSUMED`), sin reversa en `reopen()` a propósito.
8. **Web (punto 9)** — `apps/web/src/components/production-queue.tsx` (nuevo, compartido):
   `useProductionQueue`, `QueueEntrySummary`, `QueueAdminControls`. `RoofingPickerCard` en
   `/planta` reescrita sobre la cola; `/produccion` gana la sección de administración;
   `/pedidos/[id]` muestra el badge de cola y los mismos controles de prioridad/fecha;
   indicador de conteo en "Terminal de planta" del menú lateral (RF-38).
9. **Revisión (punto 9)** — `revisor` y `auditor-seguridad` en paralelo. Un ALTO (D-097,
   corregido), un MEDIO (filtro `kind`, corregido), un BAJO (auditoría sin `before`, corregido).
   Detalle en `docs/PROGRESO.md`.
10. **E2E (punto 6)** — `e2e/tests/fase7.spec.ts` (7) y `fase7-bordes.spec.ts` (2), con
    `queueOf`/`setPriority`/`setPromisedDeliveryDate`/`patchExpectingError` nuevos en
    `e2e/helpers/sales.ts`.
11. **Arreglo de plomería, no de esta fase pero desbloqueó el resto** —
    `ZodValidationPipe` trataba un body ausente (`req.body === undefined`, sin
    `Content-Type`) como error de validación. Al agregarle a `confirmQuotation` un body 100%
    opcional (`promisedDeliveryDate?`), el botón "Confirmar pedido" del web —que llama sin
    body— empezó a devolver 400 para **todo** pedido, no solo coberturas. Se arregló en el pipe
    (`value ?? {}`): un schema con campos obligatorios sigue fallando igual, uno sin ellos ahora
    también acepta un body ausente. Verificado contra los E2E completos de Fase 5a y Fase 6.

## 3. Decisiones tomadas

- **D-092** — v1 de la cola es solo coberturas contra pedido; reposición de catálogo/drywall
  queda diferida, con el hook de origen de demanda que D-093 deja explícito.
- **D-093** — La cola es una vista derivada, no una tabla ni un estado nuevo del pedido; reusa
  la señal de D-088 para "se fabrica contra el pedido".
- **D-094** — Orden: prioridad manual (ADMINISTRADOR, con motivo, auditada) > semáforo > FIFO
  por `createdAt`.
- **D-095** — Planta jala: la cola es la pantalla de entrada de `/planta`; crear la OP desde la
  tarjeta es el único punto de entrada al flujo de Fase 6, que queda intacto.
- **D-096** — `fechaEntregaPrometida` la fija el vendedor solo al confirmar/crear el pedido;
  después es de ADMINISTRADOR. Semáforo sobre `businessToday()`.
- **D-097** — El saldo de reserva de bobina que sobra al cerrar una OP se libera entero
  (`RELEASED`); la señal de la cola exige receta de coberturas (`kind: ROOFING`).

## 4. Bloqueos / pendientes

**Sin bloqueos técnicos abiertos sobre la cola misma.**

**Diferido, con motivo:**

- **Punto de venta directo (RF-60) e importación de comprobantes (RF-11, RF-71, RF-72)** siguen
  en Fase 7, sin construir: el dueño pidió esta sesión solo para la cola.
- **Reposición de catálogo/drywall** no entra a la cola en v1 (D-092); el hook de origen de
  demanda (D-093) es lo que evita rediseñar cuando se construya.

**Bloqueo operativo abierto — deploy del web.** El token del CLI de Vercel
(`%APPDATA%/xdg.data/com.vercel.cli/auth.json`) venció; `pnpm deploy:web` falla con
`403 invalidToken`. **No bloquea el cierre**: el proyecto Vercel está ligado al repo de GitHub,
así que el push de esta sesión a `main` dispara el deploy igual. Si se necesita un deploy fuera
de un push, el dueño tiene que correr `vercel login` antes.

**Ojo operativo — el residuo que la propia purga de E2E dejó (no es un defecto de esta fase).**
`pnpm prod:purge-e2e` revierte cualquier despacho E2E "para devolver el stock al almacén", sin
distinguir si el ítem despachado es materia prima o un producto terminado de SKU único que
nunca se vuelve a vender. Revertir el despacho de una cobertura ya cerrada puede reabrir su OP
a medias (el reporte no llega a revertirse) y dejar el kardex del producto con saldo fantasma.
Esta sesión lo destapó porque sus E2E fueron los primeros en despachar una cobertura dentro del
mismo `prod:purge-e2e` — el ciclo de Fase 6 nunca llegaba a despachar en su E2E. Se remedió a
mano (reabrir → revertir el reporte → anular, el mismo criterio "anula por API" del resto del
script) y la purga quedó en cero. **No se tocó `scripts/prod-e2e-purge.mjs`**: decidir cuándo
conviene revertir un despacho E2E amerita su propia revisión, no un parche a último momento.
Detalle completo en `docs/PROGRESO.md` → "Fase 7 — detalle".

**Ojo operativo — límite conocido, no nuevo.** Si planta monta una bobina **distinta** a la
reservada (D-086 lo permite), la reserva original nunca se decrementa por `report()` — queda
intacta hasta que D-097 la libera al cerrar. El kilo teórico que la cola muestra (`theoreticalKg`)
usa la geometría de la bobina **originalmente reservada**, no la que termine rolándose: es la
única identidad de bobina que existe antes de que la OP nazca. Documentado, no bloquea ningún
E2E exigido.

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm turbo lint typecheck test build   # exit 0 (221 unit)
pnpm e2e --grep "Fase 7"               # solo esta fase (9 tests)
pnpm e2e:prod                          # contra producción (D-024, D-081), incluye Fase 7
pnpm prod:purge-e2e --dry-run          # qué dejaría limpio; sin la bandera, lo deshace
gh run list --limit 3
```

**No correr dos suites de Playwright a la vez**: comparten `test-results/`.

Un recorrido a mano que prueba la fase entera:

1. `/cotizaciones/nueva` → línea de cobertura con subítems, reservando una bobina. Emitir y
   confirmar con una fecha prometida (opcional).
2. `/planta` → **Coberturas por fabricar**: la tarjeta muestra cliente, subítems, kg teóricos,
   fecha prometida y semáforo. "Iniciar producción" crea la OP (flujo de Fase 6 intacto).
3. `/produccion` → la misma cola, con controles de prioridad y fecha (solo ADMINISTRADOR).
4. `/pedidos/[id]` → badge de estado de cola y los mismos controles.
5. Menú lateral → "Terminal de planta" lleva el conteo de pedidos en cola.
6. Cerrar la OP y despachar: el pedido sale de la cola para siempre, incluso si el vendedor
   reservó más kilos de los que la corrida gastó.

Producción:

- Web: https://ayr-steel-erp-web.vercel.app — pendiente de recibir el deploy de esta fase (ver
  §4); llegará solo con el push a `main`.
- API: https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app — rutas nuevas
  `GET /sales/orders/queue`, `PATCH /sales/orders/:id/priority`,
  `PATCH /sales/orders/:id/promised-delivery-date`. Ya redesplegado.
- DB: Neon rama `production`, con la migración de Fase 7 aplicada.

Para redesplegar: el web sale solo con el push a `main` (o `pnpm deploy:web --api-url ...` tras
`vercel login`); el API con `pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app`.

## 6. Siguiente sesión

**Fase 7, tramo 2**: punto de venta directo (RF-60) e importación de comprobantes ya emitidos
(RF-11, RF-71, RF-72). No dependen de la cola ni la cola de ellos — pueden atacarse en cualquier
orden.

Lo que este tramo deja listo y no hay que rehacer:

- **La cola es una función, no una tabla.** Cualquier fila futura (reposición de catálogo, un
  segundo origen de demanda) es otra función que produce la misma forma de entrada, no una
  migración.
- **`releaseRemainingReservation`** (D-097) es el patrón a reusar si otra producción a medida
  (UPVC, si algún día se fabrica) necesita el mismo saneamiento de reserva al cerrar.
- **`QueueAdminControls`/`QueueEntrySummary`** en `apps/web/src/components/production-queue.tsx`
  están desacoplados de la cola misma (`QueueAdminTarget` es un tipo mínimo): un punto de venta
  que también necesite tocar prioridad de un pedido los reusa sin adaptarlos.
- **El pipe de validación tolera un body ausente** en schemas 100% opcionales: un endpoint
  nuevo con un body todo-opcional no necesita que el web mande `{}` a mano.

**Sigue pendiente** el pase a la cuenta real del PSE (checklist en `docs/handoff/fase-5b.md`
§4), sin tocar por esta fase, y el `vercel login` para dejar `pnpm deploy:web` operativo fuera
de un push.
