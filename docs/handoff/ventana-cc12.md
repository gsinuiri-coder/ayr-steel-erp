# Runbook: ventana de cc12 (D-379, restaurar la reserva de lo fabricado)

**Estado: EJECUTADO el 2026-10-02, después de la ventana de cc11, sin incidencias.** Resultado:

| Qué                         | Valor                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Reacomodo y CI              | sobre `main` `1997518`; CI 36965763082 en `c7b2645`: unitarios 2117, E2E 479, smoke Neon `ci` 36                                                |
| Revisión API anterior       | `ayr-steel-erp-api-00074-wwq` (`git-sha=8bf9927`)                                                                                               |
| Revisión API nueva          | **`ayr-steel-erp-api-00075-9f9`**, 100 %, `git-sha=c7b2645`, `/health` 200, smoke 8/8 con la web vieja                                          |
| Merge del #76               | `main` = **`768903a`**, diff de runtime vacío; Vercel `success`; smoke 8/8 en los dos dominios                                                  |
| Disponible antes del paso 5 | 348 m, 300 reservados por PED-000001: **48 libres**; lo fabricado vivo de la línea 1, 48 m                                                      |
| Paso 5 (dueño)              | reserva restaurada (13:41 UTC, «se ha vuelto a reservar»); **DES-000054** al 29/09                                                              |
| Foto posterior `READ ONLY`  | reserva `CONSUMED`; DES-000054 enlazado a FFA1-00001382; salida 48 m (mov. 483) al 29/09; saldo 300, sin días negativos; PED-000011 `FULFILLED` |

Plan original:

Cada paso marcado **[OK]** espera el OK explícito del dueño (D-251/D-232). El agente propone el
comando exacto y espera.

- PR: `<PR>` (rama `cc12/restaurar-reserva`).
- **No hay migración** y el deploy no escribe datos. Los únicos datos que se tocan son los del
  paso 5, que el dueño hace **por la interfaz** con los servicios de dominio: restaurar la reserva
  y despachar.
- **Orden:** reacomodar sobre `main` → CI → resumen de D-232 y OK → API → smoke → merge (web) →
  smoke → pasos por la interfaz para FFA1-00001382.
- **La API nueva convive con la web vieja:** agrega una ruta (`POST /sales/reservations/:id/restore`)
  y dos campos de solo lectura (`restorable` en la reserva y `restorableReservation` en el plan de
  despacho), que la web vieja ignora. Hay un cambio de comportamiento: liberar a mano la reserva
  de lo fabricado de una línea contra pedido se rechaza.
- Nubefact no se toca.

## 0. Reacomodar sobre `main` y CI [agente]

```sh
git fetch
git -C ../ayr-cc12 rebase origin/main
git -C ../ayr-cc12 push --force-with-lease
gh pr checks <PR> --watch
```

Los conflictos esperables son docs (filas D-377 a D-379, PROGRESO). El manual
`docs/manual/corregir-comprobante-manual.md` entra con cc11; el caso de D-379 se le agrega en
este paso.

## 1. Antes de empezar [agente]

```sh
gh pr checks <PR>
git rev-parse origin/cc12/restaurar-reserva     # = <SHA>
git diff --name-only origin/main origin/cc12/restaurar-reserva -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

La revisión vigente antes del deploy es la vuelta atrás. Se anota acá al empezar.

## 2. Resumen de D-232 y OK del dueño [OK]

Commits, CI de la última corrida, qué se despliega (API y web, sin migración) y riesgo.

## 3. Deploy de la API [OK]

```sh
git checkout --detach <SHA>
pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
git checkout main
```

Verificar el `git-sha`, la revisión al 100 % y que `/health` responda 200. Después,
`pnpm smoke:prod` desde un worktree en `<SHA>`.

## 4. Merge a `main`: publica la web [OK]

```sh
AYR_OWNER_PUSH=1 gh pr merge <PR> --merge
```

Comprobar que el diff de runtime contra `<SHA>` sale vacío y que Vercel terminó en `success`.
Correr `smoke:prod` contra `vercel.app` y contra `--base-url https://v2.mareliac.pe`.

## 5. FFA1-00001382 por la interfaz [dueño, administrador]

Estado según la foto del 2026-10-01: la línea 1 de PED-000011 tiene 48 m de COB040ROJO fabricados
(OP-000015) y su reserva de producto está liberada a mano desde el 29/09. Hay 348 m en stock, de
los que PED-000001 reserva 300, así que quedan **48 m libres: alcanzan justo**. Si algo de eso
cambió antes de la ventana, la restauración lo dice con el faltante y no escribe nada.

1. Abrir el comprobante **FFA1-00001382**. En la tarjeta «líneas facturadas sin despacho», la
   línea 1 dice «No se despacha — se fabrica contra el pedido…» y debajo: «La reserva de esta
   línea se liberó a mano. **Restaurar reserva**». Hacer clic en el enlace.
   - Otra vía: abrir **PED-000011** y, en la línea 1, menú **⋯ → Restaurar reserva**.
2. En el diálogo «Restaurar la reserva de COB040ROJO», escribir el motivo (por ejemplo, «Reserva
   liberada por error el 29/09; se repone para despachar FFA1-00001382») y confirmar.
   - Resultado: «Reserva restaurada: la línea ya se puede despachar». En «Reservas de material»,
     la de COB040ROJO vuelve a **Activa con 48 m**.
3. Volver a **FFA1-00001382**. La línea 1 ahora dice «Sale del almacén».
4. En **Fecha de despacho**, escribir **29/09/2026**.
   - **No usar el 22/09** (la fecha que se propone por el último parte de producción). La salida
     vieja de DES-000049, del 22/09, se revirtió con fecha 29/09 y sigue contando hasta ese día:
     despachar el 22/09 deja el kardex en **−48 m** entre el 22/09 y el 28/09, y la línea vuelve
     a «No se despacha» con «Primera fecha válida: 29/09/2026».
5. **Despachar en la fecha seleccionada.** Resultado: «1 línea(s) despachada(s) en la fecha
   seleccionada». El despacho queda **enlazado al comprobante** y PED-000011 pasa a atendido.

**Verificación [agente, foto `READ ONLY` con OK del dueño]:**

- la reserva de producto de la línea 1 está `CONSUMED` y hay un evento `sales.reservation.restore`
  con los campos de la liberación del 29/09;
- hay un despacho `ISSUED` con `invoice_id` = FFA1-00001382, fecha 29/09 y una salida de 48 m de
  COB040ROJO con `operation_date` 29/09;
- el saldo de COB040ROJO es 300 m (los de PED-000001), sin días negativos;
- PED-000011 está `FULFILLED`.

## Vuelta atrás

- **Código:** con la web vieja, volver el tráfico a la revisión anotada en el paso 1. Con la web
  publicada, abrir un PR de revert, mergearlo y después desplegar la API.
- **Datos del paso 5:** el despacho se revierte desde su detalle (DES-…) con motivo. La reversa
  devuelve los 48 m al kardex y la reserva vuelve a `ACTIVE`.
  - Desde D-379, esa reserva ya **no se libera a mano** mientras cubra lo fabricado. Si hiciera
    falta soltarla, la única vía es anular el pedido, que no se recomienda con un comprobante vivo.
  - La reversa sale con la fecha de hoy: entre el 29/09 y la fecha de la reversa el kardex muestra
    la salida (es el hueco H3 del manual).
- **Respaldo:** no hay uno previsto, porque el deploy no tiene migración ni escribe datos. Si el
  dueño quiere uno antes del paso 5, se hace con el procedimiento de cc08
  (`respaldo-pre-cc12-<fecha>`).
