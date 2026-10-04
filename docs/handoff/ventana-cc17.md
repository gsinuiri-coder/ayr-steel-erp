# Ventana cc17 — D-385: importador de ventas (TONELADA y bobina sin stock)

Runbook. Cada paso marcado **[OK]** espera el OK explícito del dueño (D-251/D-232): el agente
propone el comando exacto y espera.

- PR: #94 (rama `cc17/importador-bobina`).
- **Sin migración.** El deploy no escribe datos. FFA1-1419 la importa el dueño **por la
  interfaz** (paso 7), con los servicios de dominio.
- Decisión: D-385 en `docs/ARQUITECTURA.md` §0.2. Guion UAT: `docs/uat/cc17.md`.
- Revisiones: `docs/revision/cc17-autorrevision.md` y `docs/revision/cc17-segundo-modelo.md`.

**Orden:** UAT en demo → reacomodar y CI → foto `READ ONLY` → D-232 → API → smoke → merge (web)
→ smoke → importar FFA1-1419 → (cuando llegue la bobina) confirmar.

**La API nueva convive con la web vieja.**

- `POST /sales/quotations/:id/confirm` acepta `coilAssignments` (opcional). La web vieja no lo
  manda, y solo lo necesita una cotización importada con una línea sin bobina, que antes de esta
  versión no podía existir.
- `GET /sales/quotations/:id/confirm-preview` suma `coilChoices` a cada línea y la acción
  `CHOOSE_COIL`. La web vieja muestra la etiqueta cruda en una línea así, que solo nace con el
  importador nuevo.
- El preview del importador suma `unitConversion` a cada fila y convierte toneladas a kilos. Con
  la web vieja la conversión ya se aplica (la hace la API), pero no se muestra el «→ kg».

Por eso el merge va **enseguida** del deploy de la API, y FFA1-1419 se importa **después** del
merge.

## 0. UAT en demo [dueño]

Cuando la ventana de D-383 libere el demo. `dev:demo` desde `../ayr-cc17` en 3100/3101; **sin**
`db:demo` salvo pedido del dueño. Guion: `docs/uat/cc17.md`.

## 1. Reacomodar sobre `main` y CI [agente]

```sh
git fetch
git -C ../ayr-cc17 rebase origin/main
git -C ../ayr-cc17 push --force-with-lease
gh pr checks 94 --watch
```

D-383 toca `docs/PROGRESO.md` y la tabla de §0.2: son los conflictos esperables. Si D-383 cambia
`SalesOrdersService.cancel` o `confirm`, se revisa el conflicto con el dueño antes de seguir.

## 2. Antes de empezar [agente]

```sh
gh pr checks 94
git rev-parse origin/cc17/importador-bobina     # = <SHA>
git diff --name-only origin/main origin/cc17/importador-bobina -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
```

La revisión vigente de Cloud Run, su `git-sha` y su tráfico se leen con un `.mjs` en el
scratchpad que use `scripts/lib.mjs#run`. Esa revisión es la vuelta atrás y se anota acá.

## 3. Foto `READ ONLY` [OK]

Transacción `READ ONLY` contra `production`, con OK del dueño por la conexión (D-251). JSON en
`local-data/cc17/`; acá solo el resumen.

| Qué se mira                                                 | Esperado / para qué                                                                                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cotizaciones con la marca `Factura externa: FFA1-1419`      | ninguna viva (si hay una, el importador la rechaza por D-368)                                                                                       |
| Producto `BOB030AZUL` activo en la línea de reventa         | **tiene que existir**. Si no existe, la fila queda en rojo («ni producto de venta BOB030AZUL en el catálogo»): no se crea solo. Se le dice al dueño |
| Bobinas AZUL de 0.30 abiertas, con saldo, sin reserva ni OP | lista con saldos: decide si FFA1-1419 entra con bobina o sin ella                                                                                   |
| Cliente de FFA1-1419 en el maestro                          | activo, o el padrón lo resuelve en el preview                                                                                                       |

Si algo no coincide, se para y se le muestra al dueño.

## 4. Resumen de D-232 y OK del dueño [OK]

Commits, CI de la última corrida, qué se despliega (API y web, sin migración), el riesgo (el
confirm de cotización con una rama nueva solo para importadas; el importador lee toneladas) y las
dos revisiones.

## 5. Deploy de la API [OK]

```sh
git checkout --detach <SHA>
pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
git checkout main
```

Desde un worktree, `AYR_ENV_SETUP` apunta al `.env.setup` del checkout principal. Verificar
`git-sha`, revisión al 100 % y `/health` 200. Después `pnpm smoke:prod` desde un worktree en
`<SHA>`, con la salida completa a un archivo.

## 6. Merge a `main`: publica la web [OK]

```sh
AYR_OWNER_PUSH=1 gh pr merge 94 --merge
```

Diff de runtime contra `<SHA>` vacío, Vercel `success`, `smoke:prod` contra `vercel.app` y contra
`--base-url https://v2.mareliac.pe`.

## 7. Importar FFA1-1419 [dueño, administrador]

**Cotizaciones → Importar** con `local-data/VENTAS SETIEMBRE.xlsx` (el archivo no se sube a git).

- Fila de FFA1-1419: **4192.000** kg con «4.192 TONELADA → 4,192 kg», valor de venta 12,789.15,
  total 15,091.20.
- Si la foto del paso 3 mostró una bobina libre de 4192 kg o más del pool, la fila se ata sola. Si
  no, «Sin bobina asignada» con su aviso, y la fila no bloquea.
- Confirmar la importación. La cotización nace emitida.

No escribe kardex ni reservas: una cotización no toca inventario (D-054).

## 8. Confirmar la cotización [dueño, cuando llegue la bobina]

Recién con la bobina recibida (saldo dentro de ±1 % de 4192 kg: entre 4150.08 y 4233.92 kg).
**Confirmar** → elegir la bobina en el selector → **Confirmar**. Reserva el saldo entero de esa
bobina; el pedido factura 4192 kg y S/ 15,091.20.

## 9. Verificación [agente, foto `READ ONLY` con OK del dueño]

- La cotización de FFA1-1419: `EMITTED`, sin vencimiento, una línea `BOB030AZUL`, `qty` 4192.000,
  subtotal 12789.1500, total 15091.2000; `reserve_item_type` ≠ `COIL` hasta el paso 8.
- Después del paso 8: pedido con la línea `COIL` sobre la bobina elegida, `reserve_qty` = su
  saldo, reserva `ACTIVE` por ese saldo; auditoría `sales.order.confirm` con `coilAssignments`.

## Vuelta atrás

- **Código:** con la web vieja, volver el tráfico a la revisión anotada en el paso 2. Con la web
  publicada, PR de revert, merge y después desplegar la API.
- **Datos:** la cotización importada se **anula** desde su detalle (con motivo); un pedido
  confirmado se anula y libera la reserva por el camino de siempre. No hay datos que corregir a
  mano: todo pasa por los servicios de dominio.
