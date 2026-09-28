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

## 2. Reabrir la OP devuelve la bobina sola — pendiente

Corre el dueño, una sola vez, contra la rama de ensayo `ensayo-c06-20260928` (clon de demo, se borra
al cierre), no contra demo. Acá se anotan la cotización, el pedido, la OP y la bobina que consuma, y
los tres estados de la bobina (cerrada → `CLOSED 0.000`, reabierta → `OPEN` con sus kilos, cerrada
otra vez → `CLOSED`), para que nadie los lea como operación real del cliente.
