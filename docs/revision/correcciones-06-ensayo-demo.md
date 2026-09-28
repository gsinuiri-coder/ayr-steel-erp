# Correcciones 06 — evidencia de los ensayos (D-360)

Resumen versionado de lo que quedó en `local-data/c06/` del worktree (el detalle no se versiona y
se va con el worktree; el resultado queda acá).

## 1. Terminación única y su reversa (`--undo`) sobre demo — 2026-09-28

Demo recién restablecida desde `production` (con OK del dueño; `db:reset-dev`, `env:demo`,
`db:demo`). Mismas 27 bobinas vigentes con saldo 0 que el dry-run de producción del PASO 0, 0
omitidas. Comandos (`AYR_ENV_SETUP` apuntando al `.env.setup` del checkout principal):

1. `pnpm terminate:zero-coils --branch demo` (dry-run): 27 a terminar, 0 omitidas.
2. `pnpm terminate:zero-coils --branch demo --execute` → **lote
   `27d117ad-46b4-49a9-b03d-1382565e41bc`** (06:31:32 UTC).
3. `pnpm terminate:zero-coils --branch demo --undo 27d117ad-… ` (dry-run): 27 a reabrir, 0 que no se
   tocan.
4. `pnpm terminate:zero-coils --branch demo --undo 27d117ad-… --execute`: 27 reabiertas.

Foto de solo lectura de las 27 (script de un solo uso, transacción `READ ONLY`) en tres momentos:

| Momento              | Hora (UTC) | Estado de las 27         | Movimientos de kardex de las 27 |
| -------------------- | ---------- | ------------------------ | ------------------------------- |
| Antes                | 06:29:50   | 27 vigentes (`OPEN`)     | **70**                          |
| Después del lote     | 06:31:50   | 27 terminadas (`CLOSED`) | **70**                          |
| Después del `--undo` | 06:33:30   | 27 vigentes (`OPEN`)     | **70**                          |

Comparadas bobina por bobina, las tres fotos coinciden en **saldo (0,000 kg), cantidad de
movimientos y id del último movimiento**; solo cambia el estado. Ni el lote ni su reversa escriben
kardex. Quedan en la auditoría de demo 54 filas: 27 `coils.close` con `autoTerminated: BATCH` y 27
`coils.open` con `autoReopened: BATCH`.

Archivos del detalle (no versionados): `terminar-cero-dry-run-demo.txt`,
`terminar-cero-execute-demo-27d117ad-….txt`, `terminar-cero-undo-dry-run-demo-27d117ad-….txt`,
`terminar-cero-undo-demo-27d117ad-….txt`, `verif-{antes,tras-lote,tras-undo}-demo.txt`.

## 2. Reabrir la OP devuelve la bobina sola — 2026-09-28, corrido por el dueño

Una sola corrida, contra la rama de ensayo **`ensayo-c06-20260928`** (`br-rough-firefly-ae7b7az7`,
hija de demo, se borra al cierre con OK del dueño por nombre), **no contra demo**: nada de esto
existe en demo ni en producción. Script de un solo uso `scripts/c06-ensayo.mjs` (borrado al
cierre), todo por servicios de dominio y por el camino real de D-171/D-186.

**Lo que consumió (en la rama de ensayo, rotulado «Ensayo C06 (D-360)»; no es operación del
cliente):**

- Cotización **`COT-000084`** (`bf5fe098-f0e4-43e3-8c2a-1a85c7c23805`), 1 plancha `PL030AZ6MT` a
  S/ 999, cliente «PROYECTOS R&B SERVICIOS GENERALES S.A.C.» (el primer cliente con RUC de demo).
- Pedido **`PED-000044`**, confirmado; la confirmación creó la OP.
- OP **`OP-000029`** (`d3a19b4f-b753-450c-afc2-32cf63e0d935`).
- Bobina **`IMPO-ALZ-AZUL-5002-0.28-4016-28`** (4 016 kg), agotada entera: la plancha y el despunte.

**Los estados de la bobina, paso a paso:**

| Paso                                                                   | Estado       | Saldo            |
| ---------------------------------------------------------------------- | ------------ | ---------------- |
| Montada                                                                | `OPEN`       | 4 016,000 kg     |
| Reportada 1 plancha                                                    | `OPEN`       | 3 999,711 kg     |
| **1)** Cierre de la OP consumiendo 4 016 kg (el despunte la deja en 0) | **`CLOSED`** | **0,000 kg**     |
| **2)** OP reabierta (vuelve el despunte)                               | **`OPEN`**   | **3 999,711 kg** |
| **3)** OP cerrada otra vez                                             | **`CLOSED`** | **0,000 kg**     |

**Auditoría:** dos `coils.close` «Terminada automáticamente: cierre de OP-000029 (D-360)», con
`autoTerminated: PRODUCTION_ORDER_CLOSE` y `zeroedBy` = la merma del despunte de esa OP (movimientos
369 y 373), `adjustment: null` (sin kardex propio); entre ellos, un `coils.open` «Reabierta
automáticamente: reapertura de OP-000029 (D-360)». El reporte de la plancha no la terminó: estaba
montada.
