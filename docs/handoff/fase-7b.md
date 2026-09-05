# Handoff — Fase 7b, punto de venta de mostrador (RF-60) — 2026-09-05

## 1. Resumen

Segundo tramo de la Fase 7. El primero (`docs/handoff/fase-7.md`) entregó la cola de
producción; este entrega el **punto de venta de mostrador** (RF-60). De la fila de la Fase 7
en §3.7 queda sin construir solo la importación de comprobantes ya emitidos (RF-11, RF-71,
RF-72). Siete decisiones nuevas, **D-098..D-104**.

Modelo en una línea: **el POS no es un camino paralelo de stock** (D-099). `PosService.sell`
compone en **una sola transacción** los cuatro servicios que ya existían desde la Fase 5b
—pedido con su reserva, despacho, comprobante con su correlativo y cobro— y guarda una fila
que dice que los cuatro nacieron juntos. El módulo `pos` **no importa `InventoryModule`**: no
escribe kardex, no toca reservas y no comprueba disponible por su cuenta. Esa dependencia
ausente es la prueba estructural de que no se abrió un segundo camino, y de ahí salen gratis
la invariante `disponible ≥ reservado`, el kardex append-only y la contingencia de D-073.

Estado: `pnpm turbo lint typecheck test build` en verde (**236 unit**, 15 nuevos); **12 E2E
nuevos**; **6 pasados y 6 saltados contra producción, sin fallos** (los saltados emiten y
D-081 los apaga); cinco migraciones aplicadas en `dev` y `production`; API redesplegado.
`prod:purge-e2e` deja producción con **0 productos con saldo, 0 reservas activas, 0 despachos
vivos, 0 comprobantes E2E, 0 cobros vigentes y 0 turnos de caja**. **El web queda pendiente de
desplegar** — el token del CLI de Vercel sigue vencido (§4); llega con el push a `main`.

Lo que más importa de la fase, otra vez, no estaba en el plan: la anulación de una venta
destapó que **la reversa de un despacho con boleta era imposible desde la Fase 5b**. El
guardrail de D-074 bloqueaba por el estado del comprobante, y una boleta no se da de baja de
forma individual —su único camino es la nota de crédito, que la deja `ACCEPTED` para
siempre—, así que el propio mensaje de error ofrecía una salida que no desbloqueaba nada.

## 2. Hecho

1. **Tarea 0 — el defecto de `prod:purge-e2e` del tramo 1, corregido en el guion** (commit
   propio). El bloque de órdenes de producción abría el script, así que `reverseReport` se
   topaba con la salida del despacho —bloquea si el producto tuvo movimientos posteriores
   vivos que no sean `IN`— y la orden quedaba reabierta a medias con saldo fantasma. Se movió
   **después** del ciclo fiscal y logístico y **antes** de los pedidos, que es lo único que
   exigía tenerlo antes. Con el despacho ya revertido, reabrir → revertir el reporte → anular
   pasa en una corrida. No hizo falta enseñarle al guion a distinguir materia prima de
   producto terminado: bastaba el orden.
2. **Decisiones (D-098..D-104)** en `docs/ARQUITECTURA.md` §0.2, con contexto largo en
   `docs/DECISIONES.md` (el patrón `*InTx`, el hueco de la boleta y las dos fronteras
   conocidas). RF-60 y §3.7 al día.
3. **Prisma**: `cash_sessions` y `pos_sales`, `PaymentMethod` += `CARD`/`WALLET`,
   `TransferMode` += `PICKUP`. Tres migraciones (el `ALTER TYPE` va solo en la suya: Postgres
   no admite usar un valor de enum recién agregado en la misma transacción). Seis `CHECK` de
   forma nuevos y los dos de `dispatches` reescritos.
4. **El patrón `*InTx` (D-099)**: `createDirectInTx`, `DispatchesService.createInTx`,
   `InvoicingService.createInTx`/`assignInTx` y `ReceivablesService.addPaymentInTx`. El
   método público abre la transacción y delega; el `*InTx` recibe la del llamador, devuelve
   el id y no llama a `findOne`. El envío al PSE queda **fuera**, como manda D-073.
5. **`apps/api/src/pos/`**: `PosService` (contexto, buscador, venta, anulación, lecturas) y
   `CashSessionsService` (apertura, cierre con arqueo, lock del turno dentro de la venta).
6. **La corrección de Fase 5b** (`declaringDocument` en `dispatches.service.ts`): un
   comprobante bloquea la reversa del despacho mientras a alguna de sus líneas sobre ese
   despacho le quede algo **sin acreditar**. No es una excepción para el POS.
7. **`TransferMode.PICKUP` (D-103)**: recojo en mostrador, sin transporte y sin peso porque
   no genera guía. `issueDispatchNote` lo rechaza y el tipo del puerto
   (`Exclude<TransferMode, 'PICKUP'>`) impide que compile mandarlo al PSE. `/despachos/nuevo`
   lo ofrece: sirve a cualquier recojo en tienda fuera del POS.
8. **Web**: `/pos` es una sola pantalla mobile/tablet-first (buscar → tocar → medio → cobrar,
   **dos toques** entre el carrito armado y la venta cerrada) y `/pos/caja` abre, cierra y
   lista el turno con su arqueo. Aviso permanente de contingencia (D-102). "Mostrador" abre
   el grupo Comercial del menú.
9. **E2E**: `fase7b.spec.ts` (6, todos emiten) y `fase7b-bordes.spec.ts` (6, ninguno emite).
   `cleanup-e2e-users.ts` borra los turnos de caja de los usuarios efímeros y se planta si
   alguno tuviera ventas **vivas**; `e2e-leftovers.ts` los reporta.
10. **Revisión (`revisor` + `auditor-seguridad`)**: un bloqueante, tres altos, seis medios y
    ocho bajos, todos corregidos salvo dos anotados para Fase 8. El detalle está en
    `docs/PROGRESO.md`; lo que más cambió el diseño fue el estado `VOIDING` (ver §3).

## 3. Decisiones tomadas

- **D-098** — El mostrador vende stock del **propio producto**, y la regla vive en la forma
  del contrato: el esquema no tiene `reserveFromCoilId` ni `pieces`. A cambio se salta
  `quotation_required`, que es una aproximación más gruesa a la misma idea.
- **D-099** — El POS no es un camino paralelo: una transacción, cuatro servicios existentes,
  cero dependencias de inventario.
- **D-100** — Anular es la cadena de reversas que ya existe, en orden, solo en el turno
  abierto y solo con el comprobante aceptado. Incluye la corrección del hueco de la boleta.
  La revisión le agregó dos piezas que no estaban en el plan y que resultaron esenciales:
  la venta se **reclama** en un estado nuevo, `VOIDING`, bajo el lock de su turno y antes del
  primer paso —desde ahí deja de contar para el arqueo, un cierre de caja no puede colarse en
  el medio y una segunda anulación no puede emitir una nota de crédito duplicada—, y la
  cadena **consulta la baja al PSE** cuando queda en trámite, porque un comprobante en
  `VOID_PENDING` sigue declarando el traslado (D-074) y bloquea el despacho.
- **D-101** — Caja v1: un turno abierto por usuario (candado en la base), arqueo **solo del
  efectivo**, esperado congelado al cerrar, diferencia con motivo y rol de ADMINISTRADOR.
- **D-102** — El PDF de 5b alcanza; ticket de 80 mm diferido; contingencia avisada en
  pantalla mientras producción corra sin PSE.
- **D-103** — `TransferMode.PICKUP`: recojo en mostrador, sin guía y sin código de SUNAT.
- **D-104** — Una venta de mostrador es de una sola línea de negocio.

## 4. Bloqueos / pendientes

**Sin bloqueos técnicos abiertos sobre el mostrador.**

**Frontera conocida — con el PSE en contingencia una venta de mostrador no se anula.** Sin
credenciales (D-080) el comprobante queda `ISSUED`/`SEND_ERROR`: ni la baja ni la nota de
crédito existen sobre él, así que la cadena de D-100 no puede empezar y el API lo rechaza
diciendo el estado concreto. Revertir "por dentro" dejando el comprobante quieto se descartó
a propósito: el job de D-073 seguiría enviando después el comprobante de una venta que ya no
existe. Desaparece sola con el pase a la cuenta real de Nubefact.

**Frontera conocida — el mostrador no entra a `prod:purge-e2e`, a propósito.** Una venta a
público en general no lleva ninguna marca de prueba: su pedido y su despacho salen a nombre
del cliente sembrado de D-077, igual que una venta real. Enseñarle a la purga a reconocerlas
arriesgaría anular una venta de mostrador **real** contra producción. No hace falta: todas
las ventas de mostrador emiten y D-081 fuerza `E2E_FISCAL_EMISSION=0` en `e2e:prod`, así que
contra producción esa mitad de la suite se salta. Lo que la otra mitad deja ya lo cubren los
filtros de siempre, y los turnos de caja los borra `cleanup-e2e-users.ts`.

**Ojo operativo — una boleta no llega a `ACCEPTED` en el entorno demo.** SUNAT las resuelve
por resumen diario, así que se quedan `ISSUED` aunque el envío entre. Por eso el escenario
de anulación principal usa **factura** (síncrona, camino de baja) y el de boleta —el que
ejercita la corrección de la nota de crédito— se salta con su motivo cuando el entorno no
puede aceptarla. No es un defecto del mostrador.

**Bloqueo, por la regla dura 9 — la suite local completa no se pudo terminar.** Dos
intentos: el primero avanzó 12 de 136 tests en 85 minutos; el segundo, acotado a las ocho
suites que tocan lo que la fase cambió, no completó ninguno en 20. Es del entorno y no del
código —la rama `dev` de Neon quedó degradada tras las corridas del día, y procesos de Chrome
huérfanos de las corridas interrumpidas saturaron la máquina—, y la prueba es que la misma
suite acotada corre **contra producción en menos de un minuto**. La suite entera queda en
manos de **CI**, que la ejecuta en cada push contra la rama `ci` de Neon. Detalle en
`docs/PROGRESO.md`.

**Dos defectos de las herramientas, corregidos.** `scripts/e2e-prod.mjs` tiene la lista de
suites escrita a mano y **no incluía las de Fase 7b**: la primera corrida contra producción
ejecutó 123 tests y ninguno era del mostrador. Se agregaron, y el guion pasa ahora cualquier
bandera extra a Playwright (`pnpm e2e:prod --grep "Fase 7b"`) — con el cuidado de
entrecomillar los argumentos con espacios, porque `shell: true` partía `--grep "Fase 7b"` en
dos y la corrida "acotada" ejecutaba 121 de 135.

**Ojo operativo — el resumen final de `prod:purge-e2e` tarda más de una hora.** Consulta el
saldo de cada producto E2E uno por uno contra Cloud Run y ya hay 443 acumulados; la limpieza
en sí es rápida. `node scripts/prod-e2e-leftovers.mjs` da el mismo cuadro leyendo la base, en
segundos.

**Anotado para Fase 8 (hardening), sin corregir en esta fase.** Dos hallazgos bajos de la
auditoría: el buscador de cliente del mostrador se trae el maestro completo y filtra en el
navegador (hace falta un `search` en `GET /customers`, que es API de otro módulo), y el
override de precio del vendedor no tiene piso — es D-068 heredado, pero en mostrador el
arqueo nunca lo detecta, porque el efectivo esperado se deriva del total de la propia venta.

**Diferido, con motivo:** importación de comprobantes ya emitidos (RF-11, RF-71, RF-72),
ticket térmico de 80 mm (D-102), venta a medida en mostrador y multi-caja por usuario.
Sigue pendiente el pase a la cuenta real del PSE (checklist en `docs/handoff/fase-5b.md` §4)
y el `vercel login` para dejar `pnpm deploy:web` operativo fuera de un push.

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm turbo lint typecheck test build   # exit 0
pnpm e2e --grep "Fase 7b"              # solo esta fase (12 tests)
pnpm e2e:prod --grep "Fase 7b"         # solo esta fase, contra producción (D-024, D-081)
pnpm e2e:prod                          # la suite entera contra producción
pnpm prod:purge-e2e --dry-run          # qué dejaría limpio
node scripts/prod-e2e-leftovers.mjs    # el residuo, leyendo la base (segundos)
```

**No correr dos suites de Playwright a la vez**: comparten `test-results/`.

Un recorrido a mano que prueba la fase entera:

1. `/pos` → "Abrir caja" con S/ 100.
2. Buscar un producto con saldo, tocarlo, elegir **Efectivo** y "Cobrar". Sale la boleta a
   público en general con su número y su PDF.
3. `/inventario` → el saldo bajó; `/pedidos`, `/despachos` y `/comprobantes` muestran los
   tres documentos que la venta creó.
4. `/pos` otra vez → "Identificar" con un RUC: el lookup de D-067 lo completa y la venta sale
   con **factura**.
5. Carrito de más de S/ 700 sin identificar → bloqueo suave; identificar al cliente lo
   levanta.
6. `/pos/caja` → esperado, ventas por medio de pago, y cierre contando de menos: pide motivo
   y exige ADMINISTRADOR.
7. Como ADMINISTRADOR, "Anular" una venta del turno abierto: cobro, comprobante, despacho y
   pedido se deshacen en cadena y la caja vuelve a su esperado.

Producción:

- Web: <https://ayr-steel-erp-web.vercel.app> — el deploy llega con el push a `main`.
- API: <https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app> — rutas nuevas bajo `/pos`.
- DB: Neon rama `production`, con las tres migraciones de Fase 7b aplicadas.

## 6. Siguiente sesión

**Fase 7, tramo 3**: importación de comprobantes ya emitidos (RF-11, RF-71, RF-72). No
depende del mostrador ni el mostrador de ella.

Lo que esta fase deja listo y no hay que rehacer:

- **El patrón `*InTx`.** Cualquier operación futura que tenga que componer dos módulos en
  una transacción ya tiene el molde: el público abre y delega, el `*InTx` recibe y devuelve
  un id, y lo que habla con el exterior queda fuera.
- **`declaringDocument`** es el criterio correcto de "este documento todavía declara esta
  salida", y sirve a cualquier reversa futura que tenga que preguntárselo.
- **`TransferMode.PICKUP`** cubre cualquier recojo en tienda, no solo el del POS.
- **La caja** (`CashSessionsService`) es independiente del mostrador: si algún día hay que
  arquear otra cosa que entre por caja, el turno ya existe.
