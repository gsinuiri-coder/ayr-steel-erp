# Comprobantes con líneas sin despacho — inventario de solo lectura (2026-09-29)

## Alcance y método

Se consultó **Neon `demo`**, clon de producción del 28-09, por última vez el 2026-09-29 a las 14:14 UTC (09:14 Lima). Ninguna consulta de este inventario se ejecutó contra `production`. El subcomando `inspect:undispatched-invoices` usa `runApiCli`, rechaza cualquier argumento de ejecución o reversa antes de conectarse, no levanta `AppModule` ni jobs y envuelve todas las lecturas en una transacción `READ ONLY`. Usa Prisma ORM y los servicios de dominio `InvoiceDispatchService.buildPlan` y `planPurchaseReceivedDates`; el único SQL explícito fija la transacción en modo de solo lectura. No guarda planes ni archivos de salida.

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

## Recomendaciones, sin implementar

1. **D-nnn propuesto: excluir `ANNULLED`/`VOIDED` de cualquier barrido «sin despacho».** Una anulación no es una venta pendiente. El plan D-285 de esta rama ya los excluye; el conteo vivo de producción permitirá comprobar si el síntoma procede de otro lector.
2. **Bloqueante para reutilizar el tool de fechas:** agregar una prueba de regresión con movimientos reales de un lote execute→undo que compruebe que las reversas del propio lote no bloquean la guarda y que una `SALE` ajena posterior sí. El PR #58 ya tiene el unitario de la exclusión de IDs de reversa propia (`d4f5eee`), pero no esa prueba de la secuencia completa. También hay que decidir explícitamente cómo reclasificar compras ya aplicadas y deshechas antes de proponerlas otra vez.

## Comando exacto para el dueño: número vivo de producción

En PowerShell, desde la raíz del worktree `C:\Users\User\Documents\workspace\ayr\ayr-fechas`:

```powershell
$env:AYR_ENV_SETUP='C:\Users\User\Documents\workspace\ayr\ayr-steel-erp\.env.setup'
pnpm inspect:undispatched-invoices --branch production --confirm-production
```

El comando devuelve el conteo por estado, con `ANNULLED` y `VOIDED` explícitos, y la tabla de comprobantes no anulados pendientes con líneas, veredicto y compras a mover cuando corresponde. **No contiene `--execute` ni `--undo`.** `runApiCli` exige `--confirm-production` incluso para esta lectura. Esta sesión **no lo ejecutó contra producción**.
