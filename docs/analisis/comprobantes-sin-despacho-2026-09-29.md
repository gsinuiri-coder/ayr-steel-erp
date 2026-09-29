# Comprobantes con líneas sin despacho — inventario de solo lectura (2026-09-29)

## Alcance y método

Se consultó **Neon `demo`** el 2026-09-29 a las 13:44 UTC (08:44 Lima). La rama es el clon de producción del 28-09, no una foto viva de producción. Todas las consultas se ejecutaron dentro de `SET TRANSACTION READ ONLY`; no hubo `execute`, `undo` ni escritura en `demo` o `production`.

Para el conjunto operativo se usó **`InvoiceDispatchService.buildPlan(tx, {})`**, el mismo plan de D-278/D-285 que distribuye lo facturado neto entre despachos ya emitidos (`allocateUndispatched`) y decide cada línea con `firstNegativeDate`. No se infirió «sin despacho» solo a partir de `dispatch.invoiceId`: una salida del pedido puede cubrir la línea aunque no esté declarada en ese comprobante. Se consultaron aparte todas las facturas y boletas no archivadas, incluidos estados anulados, para medir el conjunto físico de documentos con líneas de pedido y sin despacho declarado. El clasificador de compras fue **`planPurchaseReceivedDates(tx)`** de la rama del PR #58, sin copiar sus reglas.

## Conteo por estado en demo

| Estado del comprobante | Comprobantes | Con líneas en el plan D-285 pendientes de despacho | Con líneas de pedido y ningún despacho declarado | Con alguna línea sin despacho emitido del pedido |
| --- | ---: | ---: | ---: | ---: |
| `ACCEPTED` | 33 | 0 | 0 | 0 |
| `ANNULLED` | 0 | **0** | **0** | **0** |
| `VOIDED` | 0 | **0** | **0** | **0** |
| Otros estados de factura/boleta | 0 | 0 | 0 | 0 |
| **Total** | **33** | **0** | **0** | **0** |

No hay versiones archivadas de facturas o boletas en este clon. Los 33 comprobantes son `ACCEPTED` y tienen sus cantidades de pedido cubiertas por despachos `ISSUED`; el plan de D-285 devuelve `[]`. **El conteo de anulados/void sin despacho es cero en demo:** esta foto no prueba el defecto observado después en producción. `FFA1-00001389`, anulado y con seis líneas, apareció después del clon y no está en demo. Además, el `buildPlan` actual filtra explícitamente estados vivos y versiones no archivadas; por ese camino un anulado no dispara el aviso. Si otro barrido lo incluye en producción, hay que localizar ese lector concreto antes de cambiarlo.

## No anulados pendientes y veredicto

| Comprobante | Fecha | Líneas sin despacho | Veredicto | Compras a mover |
| --- | --- | --- | --- | --- |
| **Ninguno en demo** | — | 0 | — | — |

Resultado por las cuatro clases solicitadas: **DESPACHABLE ya: 0; BLOQUEADO-FECHA-COMPRA: 0; BLOQUEADO-APERTURA: 0; BLOQUEADO-RECOSTEO: 0**. No hubo una línea pendiente sobre la que simular una nueva salida. Por tanto, este clon no ofrece un conjunto de compras para volver a ejecutar la herramienta. La fecha efectiva de las 18 entradas de apertura `IMPORT` fue movida a 2026-08-01 por D-285; «apertura 15-09» describe la fecha original de carga, no la fecha efectiva actual del kardex.

Como comprobación adicional, el clasificador de compras devuelve nueve candidatas y **cero seguras en el estado actual de demo**. `E001-262` y `F013-942` siguen excluidas por salidas posteriores. Las otras siete (`NF1-1`, `F001-00043612`, `E001-1731`, `E001-261`, `E001-1766`, `E001-2427`, `F001-00043848`) fueron aplicadas y deshechas durante el ensayo anterior en demo: sus reversas append-only hacen que `planPurchaseReceivedDates` las marque ahora «movimientos mixtos o fecha ya corregida» y «la compra ya tiene reversas». No se debe leer este cero como permiso para reutilizar el lote anterior ni saltarse la guarda.

## Recomendaciones, sin implementar

1. **D-nnn propuesto: excluir `ANNULLED`/`VOIDED` del barrido «sin despacho».** Una anulación no es una venta pendiente. En esta rama el plan D-285 ya aplica ese filtro; contrastar el número vivo de producción y ubicar cualquier otro lector que siga señalando FFA1-00001389 antes de asignar e implementar la decisión.
2. **Bloqueante para reutilizar el tool de fechas:** agregar una prueba de regresión con movimientos reales de un lote execute→undo que demuestre que las reversas del propio lote no bloquean la guarda, y que una `SALE` ajena posterior sí la bloquea. El PR #58 ya contiene un unitario de la exclusión de IDs de reversa propia (`d4f5eee`); falta esa prueba de la secuencia completa. Reutilizar el tool también requiere un clasificador que trate de manera explícita compras ya aplicadas y deshechas, sin relajar por inferencia las exclusiones actuales.

## Consulta reproducible para el número vivo de producción

Desde PowerShell, en el worktree `ayr-fechas`, el dueño puede correr **este mismo lector**. `tsc` solo genera el JS local ignorado; la transacción Neon es `READ ONLY`. La salida JSON contiene `counts`, `plan` por línea y `purchaseCases` del clasificador existente. No se invoca ninguna ruta de ejecución de despacho, execute ni undo.

```powershell
Set-Location 'C:\Users\User\Documents\workspace\ayr\ayr-fechas\apps\api'
$env:AYR_ENV_SETUP='C:\Users\User\Documents\workspace\ayr\ayr-steel-erp\.env.setup'
pnpm exec tsc -p tsconfig.cli.json
$report = Get-Content -LiteralPath '..\..\docs\analisis\comprobantes-sin-despacho-2026-09-29.md' -Raw
$query = [regex]::Match($report, '(?s)<!-- QUERY_START -->\s*```js\r?\n(.*?)\r?\n```\s*<!-- QUERY_END -->').Groups[1].Value
if (-not $query) { throw 'No se encontró la consulta del informe' }
$query | node --input-type=module - production
```

La consulta incrustada, idéntica para `demo` y `production` salvo el argumento final:

<!-- QUERY_START -->
```js
import { createRequire } from 'node:module';
import prismaPackage from '@prisma/client';
import { neonConnectionString } from '../../scripts/lib.mjs';

const require = createRequire(import.meta.url);
const { InvoiceDispatchService } = require('./dist-cli/src/invoicing/invoice-dispatch.service.js');
const { planPurchaseReceivedDates } = require('./dist-cli/src/purchases/purchase-received-date-fix.js');
const { PrismaClient, Prisma } = prismaPackage;
const branch = process.argv.at(-1);
if (branch !== 'demo' && branch !== 'production') throw new Error('Rama no permitida');
const db = new PrismaClient({ datasources: { db: { url: neonConnectionString(branch, { pooled: true }) } } });

try {
  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const service = new InvoiceDispatchService(db, null, null, { historicalLoadStart: '2026-08-01' });
    const plan = await service.buildPlan(tx, {});
    const purchases = await planPurchaseReceivedDates(tx);
    const docs = await tx.fiscalDocument.findMany({
      where: { docType: { in: ['FACTURA', 'BOLETA'] } },
      select: {
        id: true, number: true, status: true, archivedAt: true, issueDate: true,
        dispatchesInvoiced: { select: { status: true } },
        items: { where: { salesOrderItemId: { not: null } }, select: { salesOrderItemId: true } },
      },
    });
    const ids = [...new Set(docs.flatMap((d) => d.items.map((i) => i.salesOrderItemId)).filter(Boolean))];
    const dispatched = await tx.dispatchItem.groupBy({
      by: ['salesOrderItemId'],
      where: { salesOrderItemId: { in: ids }, dispatch: { status: 'ISSUED' } },
      _sum: { qty: true },
    });
    const byItem = new Map(dispatched.map((d) => [d.salesOrderItemId, d._sum.qty?.toString() ?? '0']));
    const rows = docs.map((d) => ({
      id: d.id, number: d.number, status: d.status, archived: d.archivedAt !== null,
      issueDate: d.issueDate.toISOString().slice(0, 10),
      lines: d.items.length,
      declared: d.dispatchesInvoiced.some((x) => x.status === 'ISSUED'),
      uncoveredOrderLines: d.items.filter((i) => new Prisma.Decimal(byItem.get(i.salesOrderItemId) ?? '0').isZero()).length,
    }));
    const statuses = [...new Set([...rows.map((r) => r.status), 'ANNULLED', 'VOIDED'])].sort();
    return {
      snapshotUtc: new Date().toISOString(), branch,
      counts: statuses.map((status) => ({
        status,
        documents: rows.filter((r) => r.status === status && !r.archived).length,
        archived: rows.filter((r) => r.status === status && r.archived).length,
        noDeclaredDispatch: rows.filter((r) => r.status === status && !r.archived && r.lines > 0 && !r.declared).length,
        noOrderDispatch: rows.filter((r) => r.status === status && !r.archived && r.uncoveredOrderLines > 0).length,
      })),
      noDeclaredDispatchDocs: rows.filter((r) => !r.archived && r.lines > 0 && !r.declared),
      plan: plan.invoices.map((d) => ({
        number: d.number, issueDate: d.issueDate,
        lines: d.lines.map((l) => ({ sku: l.sku, qty: l.qty.toString(), action: l.action,
          operationDate: l.operationDate, itemKey: l.itemKey, reason: l.reason })),
      })),
      purchaseCases: purchases.map((p) => ({ document: p.document, purchaseId: p.purchaseId,
        currentDate: p.currentDate, destinationDate: p.destinationDate, safe: p.safe,
        items: p.items.map((i) => i.key), reasons: p.reasons })),
    };
  }, { timeout: 60_000 });
  console.log(JSON.stringify(result, null, 2));
} finally { await db.$disconnect(); }
```
<!-- QUERY_END -->
