# Comprobantes con líneas sin despacho — inventario de solo lectura (2026-09-29)

## Alcance y método

Se consultó **Neon `demo`**, clon de producción del 28-09, por última vez el 2026-09-29 a las 14:14 UTC (09:14 Lima). Con autorización del dueño, el subcomando se ejecutó también contra **`production` el 2026-09-29 a las 14:58 UTC**, solo lectura. El subcomando `inspect:undispatched-invoices` usa `runApiCli`, rechaza cualquier argumento de ejecución o reversa antes de conectarse, no levanta `AppModule` ni jobs y envuelve todas las lecturas en una transacción `READ ONLY`. Usa Prisma ORM y los servicios de dominio `InvoiceDispatchService.buildPlan` y `planPurchaseReceivedDates`; el único SQL explícito fija la transacción en modo de solo lectura. No guarda planes ni archivos de salida.

El plan de D-278/D-285 distribuye lo facturado neto entre despachos emitidos (`allocateUndispatched`) y simula cada salida con `firstNegativeDate`. Para comprobar que mover compras **seguras** desbloquearía un comprobante, el subcomando vuelve a correr ese mismo plan con las fechas de las entradas proyectadas en memoria; no edita movimientos. Las compras seguras/excluidas vienen del clasificador existente. Si un caso no cabe en las cuatro causas pedidas, el comando falla con la causa concreta en vez de atribuirle una causa falsa.

## Conteo por estado en demo

| Estado     | Comprobantes | Pendientes en el plan D-285 | Con líneas de pedido y sin despacho declarado |
| ---------- | -----------: | --------------------------: | --------------------------------------------: |
| `ACCEPTED` |           33 |                           0 |                                             0 |
| `ANNULLED` |        **0** |                       **0** |                                         **0** |
| `VOIDED`   |        **0** |                       **0** |                                         **0** |
| Otros      |            0 |                           0 |                                             0 |
| **Total**  |       **33** |                       **0** |                                         **0** |

No hay versiones archivadas de facturas o boletas en este clon. Los 33 comprobantes `ACCEPTED` tienen sus líneas cubiertas por despachos `ISSUED`; el plan D-285 devuelve `[]`. **El conteo de anulados/void sin despacho es cero en demo:** esta foto no reproduce el caso `FFA1-00001389` observado después en producción. El plan D-285 ya filtra estados vivos; si otro aviso incluye anulados en producción, hay que localizar ese lector concreto antes de cambiarlo. La columna «sin despacho declarado» es una comprobación separada: ausencia de `Dispatch.invoiceId` vigente en un documento con líneas de pedido; por D-205, no equivale por sí sola a pendiente operativo.

## No anulados pendientes y veredicto

| Comprobante         | Fecha | Líneas sin despacho | Veredicto | Compras a mover |
| ------------------- | ----- | ------------------- | --------- | --------------- |
| **Ninguno en demo** | —     | 0                   | —         | —               |

Resultado por clases: **DESPACHABLE: 0; BLOQUEADO-FECHA-COMPRA: 0; BLOQUEADO-APERTURA: 0; BLOQUEADO-RECOSTEO: 0**. No hay una línea pendiente sobre la que simular una salida. La apertura `IMPORT` se fechó efectivamente el 2026-08-01 en D-285; el 15-09 fue su fecha original de carga. La fecha de salida que usa D-285 es la más tardía entre emisión y último parte de producción; el detalle del comando muestra esa decisión cuando existe una línea pendiente.

Como comprobación adicional, `planPurchaseReceivedDates` devuelve nueve candidatas y **cero seguras en el estado actual de demo**. `E001-262` y `F013-942` siguen excluidas por salidas posteriores. Las otras siete (`NF1-1`, `F001-00043612`, `E001-1731`, `E001-261`, `E001-1766`, `E001-2427`, `F001-00043848`) fueron aplicadas y deshechas en el ensayo previo: sus reversas append-only hacen que el clasificador las marque ahora «movimientos mixtos o fecha ya corregida» y «la compra ya tiene reversas». No se debe leer el cero de pendientes como permiso para reutilizar el lote anterior.

## Foto de producción y decisión D-363

La lectura de producción del 29-09, antes de este cambio de código, devolvió: `ACCEPTED` 44 documentos, 2 pendientes D-285 y 1 sin despacho declarado; `ANNULLED` 7 documentos, 0 pendientes D-285 y 7 sin despacho declarado; `VOIDED` 0. Los dos pendientes vivos son `BBV1-00000341` (AUTOPERF10X1 100) y `BBV1-00000347` (AUTOPERF10X1 500 y AUTOPERF12X212 500), ambos `BLOQUEADO-RECOSTEO`. No se modificaron.

**Por qué 2 ≠ 1:** D-285 cuenta comprobantes con cantidad facturada aún sin cubrir, incluso si tienen un despacho declarado parcial; «sin despacho declarado» cuenta solo comprobantes sin ningún despacho declarado. **La métrica accionable es Pendientes D-285.**

El aviso visual en el detalle ya estaba acotado con `LIVE_DOCUMENT_STATUSES`. El bug encontrado por la lectura de producción estaba en `countUndispatchedByStatus`: contaba anulados en la métrica bruta «sin despacho declarado», aunque el plan operativo los excluía. D-363 aplica esa misma lista blanca a la métrica; los 7 anulados siguen visibles en «Comprobantes» por estado y pasan a 0 en «Sin despacho declarado». La prueba E2E fija que el aviso visual tampoco aparece al anular un comprobante. Esta cifra posterior es **la salida esperada por la prueba**, no una nueva lectura de producción: no se volvió a consultar producción en esta entrega.

## Recomendaciones y estado

1. **D-363 implementada:** el conteo «sin despacho declarado» excluye `ANNULLED`/`VOIDED` mediante `LIVE_DOCUMENT_STATUSES`, con unitario y E2E del aviso visual. Sin cambio de datos.
2. **Regresión del `--undo` agregada:** el unitario simula la reversa propia con ID posterior al reemplazo y confirma que no bloquea el undo; con una `SALE` ajena posterior, confirma que el lote se bloquea antes de escribir. No se modificó ni ejecutó el tool de fechas. Antes de proponer otro lote sigue pendiente decidir cómo reclasificar compras ya aplicadas y deshechas.

## Comando exacto para el dueño: número vivo de producción

En PowerShell, desde la raíz del worktree `C:\Users\User\Documents\workspace\ayr\ayr-fechas`:

```powershell
$env:AYR_ENV_SETUP='C:\Users\User\Documents\workspace\ayr\ayr-steel-erp\.env.setup'
pnpm inspect:undispatched-invoices --branch production --confirm-production
```

El comando devuelve el conteo por estado, con `ANNULLED` y `VOIDED` explícitos, y la tabla de comprobantes no anulados pendientes con líneas, veredicto y compras a mover cuando corresponde. **No contiene `--execute` ni `--undo`.** `runApiCli` exige `--confirm-production` incluso para esta lectura. Se ejecutó solo en la lectura autorizada de las 14:58 UTC, anterior a D-363; **no se re-ejecutó** después del cambio.
