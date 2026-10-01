# Runbook — deploy de cc08 (D-375, restaurar bobina anulada) y restauración de IMPO-ALZ-AZUL-5002-0.28-4150-23

**Estado: EJECUTADO el 2026-10-01, de día** (el cliente no usaba la app). Resultado:

| Qué                        | Valor                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Respaldo Neon              | `respaldo-pre-cc08-20261001` (`br-proud-glade-aev4qddf`, hija de `production`), `ready`                    |
| Revisión API anterior      | `ayr-steel-erp-api-00071-bll` (`git-sha=3bf6de5`)                                                          |
| Revisión API nueva         | **`ayr-steel-erp-api-00072-hgh`**, 100 %, `git-sha=a54b6ed`, smoke 8/8 con la web vieja                    |
| Merge #70                  | `main` = **`5f19a25`**, diff de runtime vacío; Vercel `success`; smoke verde en `vercel.app` y `v2`        |
| Dry-run                    | 9 bobinas EN_SU_FECHA; lote congelado `1cf26c13-75f5-4402-be61-fd6c841d5b39` solo con la AZUL              |
| Execute                    | AZUL → **EN_SU_FECHA 28/09**, movimiento **468** (4150 kg a 2,6938, compra 118-315630)                     |
| Foto posterior (READ ONLY) | `OPEN`, film sellado; 4150 kg continuos desde el 14/08; sin días negativos; ningún otro movimiento escrito |

Undo, si hiciera falta: `pnpm restore:cancelled-coils --branch production --confirm-production --undo 1cf26c13-75f5-4402-be61-fd6c841d5b39 --execute --reason "<motivo>"`.

---

Plan original. Cada paso marcado **[OK]** espera el OK explícito del dueño
(D-251/D-232). El agente propone el comando exacto y espera.

- PR: https://github.com/gsinuiri-coder/ayr-steel-erp/pull/70 (reemplaza al #60).
- **Sin migración.**
- **Orden: respaldo → API → smoke → merge (web) → smoke → dry-run del lote → [OK] → execute →
  foto posterior.**
- **La API nueva funciona con la web vieja:** solo agrega dos rutas. Hay un cambio de
  comportamiento: el guard que rechaza salidas de bobina con fecha anterior a su primer ingreso
  vivo.

## 0. Antes de empezar [agente]

```sh
git fetch
gh pr checks <PR>
git rev-parse origin/cc08/desanular-bobina     # = <SHA>
git diff --name-only origin/main origin/cc08/desanular-bobina -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

## 1. Respaldo Neon `respaldo-pre-cc08-20261001` [OK]

`neonctl branches create --name respaldo-pre-cc08-20261001 --parent production --no-secrets
--output json`, con el proyecto del repo. Va por `scripts/lib.mjs#run` con `quiet: true` y solo
se leen del JSON el id y el nombre (`branches create` imprime credenciales, ver ENTORNOS). Se
verifica con `neonctl branches list --output json` que la rama esté `ready`.

## 2. Deploy de la API [OK]

```sh
git checkout --detach <SHA>
pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
git checkout main
```

Verificar el `git-sha`, la revisión al 100 % y `/health` 200. Después, `pnpm smoke:prod` desde
un worktree en `<SHA>`.

## 3. Merge a `main`, publica la web [OK]

```sh
AYR_OWNER_PUSH=1 gh pr merge <PR> --merge
```

Comprobar que el diff de runtime contra `<SHA>` sale vacío y que Vercel terminó en `success`.
Correr `smoke:prod` contra `vercel.app` y contra `v2.mareliac.pe`.

## 4. Restauración en producción

1. **Dry-run [agente]**, solo lectura, desde el worktree en `<SHA>` con `AYR_ENV_SETUP`:

   ```sh
   pnpm restore:cancelled-coils --branch production --confirm-production --only <id de IMPO-ALZ-AZUL-5002-0.28-4150-23> --reason "<motivo del dueño>"
   ```

   Imprime la tabla de las 9 bobinas y la seleccionada, con su modo y fecha. Lo esperado según
   la foto del 2026-10-01 15:08 UTC es **EN_SU_FECHA, 28/09 (fecha de su anulación), 4150 kg a 2,6938 PEN/kg**, compra
   118-315630 (RECEIVED). Guarda el plan con su `batchId` en `local-data/`.

2. **[OK del dueño con la lista] Execute:**

   ```sh
   pnpm restore:cancelled-coils --branch production --confirm-production --execute --batch <batchId>
   ```

   Reclasifica dentro de la transacción y aborta el lote si algo cambió desde el dry-run.

3. **Foto posterior [agente, `READ ONLY`]:**
   - la bobina está `OPEN` con 4150 kg;
   - su kardex tiene una sola entrada viva: 28/09, `PURCHASE`, 2,6938, y el saldo es 4150 kg
     todos los días desde el 14/08 (nunca 8300);
   - ninguna salida existente cambió de costo y no hay días negativos;
   - hay un evento `coils.restore` con el `batchId`.

## Vuelta atrás

- **Datos:**

  ```sh
  pnpm restore:cancelled-coils --branch production --confirm-production --undo <batchId> --execute --reason "<motivo>"
  ```

  Revierte la entrada en su misma fecha y deja la bobina anulada. Se niega si la bobina tuvo
  movimientos después de restaurarse.

- **Código:** sin la web publicada, volver el tráfico a la revisión anterior. Con la web
  publicada, PR de revert y después la API.
- **Último recurso:** la rama `respaldo-pre-cc08-20261001`.
