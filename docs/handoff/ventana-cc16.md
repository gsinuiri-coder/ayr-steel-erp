# Ventana cc16 — D-381: traer FFA1-00001389 a PED-000056

## Ejecutada el 2026-10-03/04 (hora de Lima): sin incidencias

Cada paso sensible tuvo el OK explícito del dueño (D-251/D-232).

| Qué                                  | Resultado                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI del PR #87                        | Corrida 37164000717 en `ff5fd2b`: E2E 497 pasados y 3 saltados; smoke Neon `ci` 36 pasados; lint, typecheck, unitarios y Sonar en verde                                                                                                                                             |
| UAT                                  | Confirmado por el dueño en demo (`dev:demo` desde `../ayr-cc16` en 3100/3101, sin `db:demo`). La demo de cc15b se cerró con autorización explícita del dueño                                                                                                                        |
| Revisión API anterior (vuelta atrás) | `ayr-steel-erp-api-00078-pg7`, `git-sha=5bd99ba`                                                                                                                                                                                                                                    |
| Paso 1: deploy de la API             | **`ayr-steel-erp-api-00079-gwg`**, al 100 %, `git-sha=ff5fd2b`, `/health` 200, `smoke:prod` 7/7 con la web vieja                                                                                                                                                                    |
| Paso 2: merge del #87                | `main` = **`6da0154`**, diff de runtime vacío contra `ff5fd2b`, Vercel `success`, `smoke:prod` 8/8 en `vercel.app` y 8/8 en `v2.mareliac.pe`                                                                                                                                        |
| Foto `READ ONLY` previa              | 2026-10-04 00:48 UTC (`local-data/cc16/foto-production-2026-10-04T0048.json`). FFA1-00001389 `ANNULLED`, sin cobros, notas de crédito ni despachos; PED-000044 `CANCELLED`; PED-000056 con **0 comprobantes (el borrador ya no estaba)**, 7 líneas, total 6438 y 7 reservas activas |
| Respaldo Neon                        | `respaldo-pre-cc16-20261003` (`br-late-poetry-aewbwyl6`), hija de `production`, `ready`                                                                                                                                                                                             |
| Paso por la interfaz (dueño)         | 2026-10-04 01:13 UTC: «Traer comprobante anulado» con el motivo «faltaba un item»                                                                                                                                                                                                   |
| Despacho (dueño)                     | 2026-10-04 01:15 UTC: «Despachar a la fecha del comprobante». Resultado: **DES-000056 fechado el 27/09/2026**, no el 20/08, con las 7 líneas y enlazado a 1389. PED-000056 quedó `FULFILLED`                                                                                        |
| Foto `READ ONLY` posterior           | 2026-10-04 02:47 UTC (`local-data/cc16/foto-posterior-2026-10-04T0247.json`)                                                                                                                                                                                                        |

**Foto posterior:**

- FFA1-00001389 está `ACCEPTED` en PED-000056. Conserva número, fecha de emisión (20/08), crédito con
  vencimiento 20/10 y cliente. Gravada 5455.94, IGV 982.06, total **6438.00**. Sin cobros ni notas de
  crédito.
- Las 6 filas originales conservan su id y ahora apuntan a las líneas 2 a 7 de PED-000056. La fila 7,
  `UPVC6MT` × 42, apunta a la línea 1.
- Auditoría: `invoicing.document.move-to-order`, `sales.order.document-moved-out` (PED-000044) y
  `sales.order.document-moved-in` (PED-000056), y después `invoicing.dispatch-at-issue-date`.
- Kardex: 7 salidas `SALE` del 27/09/2026. Los saldos actuales de esos productos no son negativos.
  Las reservas de PED-000056 quedaron `CONSUMED`; las de PED-000044 siguen `RELEASED`.
- El vendedor es el de PED-000056, como decidió el dueño.

**Decisiones del dueño al cierre (2026-10-04):**

- **DES-000056 se queda el 27/09/2026**, por la convención de D-374: es la primera fecha válida del
  plan, no la del papel. No se corrige.
- **El respaldo `respaldo-pre-cc16-20261003` se conserva 7 días**, hasta el 2026-10-11. No se borra
  antes, y después, solo con el OK del dueño por nombre (`AGENTS.md` §3.3).

**Queda abierto:**

1. D-383, la protección de la anulación de pedidos: PR #90 con la CI en verde, en espera del UAT
   del dueño, que va después del de cc15b.
2. Proponer el borrado del respaldo a partir del 2026-10-11.

---

Runbook de la ventana de cc16. Cada paso marcado **[OK]** espera el OK explícito del dueño
(D-251/D-232): el agente propone el comando exacto y espera.

- PR: #87 (rama `cc16/traer-comprobante`).
- **Sin migración.** El deploy no escribe datos. Los datos se tocan en el paso 7, que el dueño
  hace **por la interfaz**, con los servicios de dominio.
- Diseño y decisiones: `docs/analisis/comprobante-a-otro-pedido-2026-10-03.md` y D-381 en
  `docs/ARQUITECTURA.md` §0.2.
- Manual: caso 6 (`docs/manual/corregir-comprobante-manual.md` §8).

**Datos confirmados por el dueño (2026-10-03):**

- el papel de FFA1-00001389 es por **las 7 líneas**, total **S/ 6,438.00**;
- el vendedor correcto es el de PED-000056;
- el borrador de factura de PED-000056 **ya se eliminó**. Se confirma en la foto del paso 2.

**Orden:** reacomodar y CI → foto `READ ONLY` → D-232 → API → smoke → merge (web) → smoke →
respaldo → paso por la interfaz → despacho (decisión aparte) → foto posterior.

**La API nueva convive con la web vieja.** Agrega tres rutas que la web vieja no llama:

- `GET /invoicing/orders/:id/movable-annulled-documents`;
- `GET /invoicing/documents/:id/move-to-order/:targetOrderId/preview`;
- `POST /invoicing/documents/:id/move-to-order`.

También cambia algo en D-378: `planOrderLines` ahora escribe `salesOrderItemId` en las filas que
actualiza. En D-378 es la misma línea de antes, así que su resultado no cambia, y sus unitarios
siguen en verde.

## 0. Reacomodar sobre `main` y CI [agente]

```sh
git fetch
git -C ../ayr-cc16 rebase origin/main
git -C ../ayr-cc16 push --force-with-lease
gh pr checks 87 --watch
```

cc15b también toca `docs/PROGRESO.md` y la tabla de decisiones de `docs/ARQUITECTURA.md` §0.2. Los
conflictos esperables son esos dos archivos.

## 1. Antes de empezar [agente]

```sh
gh pr checks 87
git rev-parse origin/cc16/traer-comprobante     # = <SHA>
git diff --name-only origin/main origin/cc16/traer-comprobante -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
```

La revisión vigente de Cloud Run, su `git-sha` y su tráfico se leen con un `.mjs` en el
scratchpad que use `scripts/lib.mjs#run` (desde un worktree no se usa `cmd /c gcloud`). Esa
revisión es la vuelta atrás y se anota acá.

## 2. Foto `READ ONLY` antes de la ventana [OK]

Es una transacción `READ ONLY` contra `production`, con OK del dueño por la conexión (D-251). El
JSON queda en `local-data/cc16/`; acá va solo el resumen. Es la misma foto de
`local-data/d381/foto-production-2026-10-03.json`, repetida.

| Qué se mira                                          | Esperado                                                                                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| FFA1-00001389                                        | `ANNULLED`, `MANUAL`, FACTURA, pedido PED-000044, 6 líneas, emisión 2026-08-20, crédito con vencimiento 2026-10-20, sin detracción |
| Cobros y notas de crédito de 1389 (cualquier estado) | ninguno                                                                                                                            |
| Despachos con `invoice_id` = 1389                    | ninguno                                                                                                                            |
| PED-000044                                           | `CANCELLED`, sin despachos vigentes                                                                                                |
| PED-000056                                           | `CONFIRMED`, mismo cliente que 1389, 7 líneas, total 6438.0000, 7 reservas `ACTIVE`                                                |
| **Borradores y comprobantes vivos de PED-000056**    | **ninguno**: el borrador del intento de reingreso ya no está                                                                       |
| Despachos de PED-000056                              | ninguno                                                                                                                            |

Si algo no coincide, se para y se le muestra al dueño.

## 3. Resumen de D-232 y OK del dueño [OK]

Incluye:

- los commits;
- la CI de la última corrida;
- qué se despliega: API y web, sin migración;
- el riesgo: un cambio de una línea en D-378 y la ruta nueva;
- las revisiones: la autorrevisión y la del segundo modelo, en `docs/revision/cc16-*.md`.

## 4. Deploy de la API [OK]

```sh
git checkout --detach <SHA>
pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
git checkout main
```

Si se despliega desde el worktree, se usa `AYR_ENV_SETUP` apuntando al `.env.setup` del checkout
principal. Hay que verificar el `git-sha`, que la revisión esté al 100 % y que `/health` responda 200. Después se corre `pnpm smoke:prod` desde un worktree en `<SHA>`, con la salida a un archivo.

## 5. Merge a `main`: publica la web [OK]

```sh
AYR_OWNER_PUSH=1 gh pr merge 87 --merge
```

Hay que comprobar que el diff de runtime contra `<SHA>` sale vacío y que Vercel terminó en
`success`. Después se corre `smoke:prod` contra `vercel.app` y contra
`--base-url https://v2.mareliac.pe`.

## 6. Respaldo antes de tocar datos [OK]

El paso 7 reescribe las líneas y el pedido de un comprobante real. El antes completo queda en la
auditoría, pero volver atrás no es automático. Se toma un respaldo Neon
`respaldo-pre-cc16-<fecha>` con el procedimiento de cc08, justo antes del paso 7.

## 7. FFA1-00001389 → PED-000056, por la interfaz [dueño, administrador]

1. Abrir **PED-000056** y elegir **⋯ → «Traer comprobante anulado»**.
2. En la lista, **FFA1-00001389** (pedido PED-000044, anulado: «mal ingreso»). Elegirlo si no viene
   elegido.
3. Revisar lo que muestra el diálogo:
   - **Pedido:** PED-000044 → PED-000056;
   - **Vendedor:** el de PED-000044 → el de PED-000056 (decisión del dueño);
   - **Fecha del papel:** 20/08/2026, anterior al pedido (01/10/2026). Es un aviso y no bloquea;
   - **Antes:** 6 líneas;
   - **Después:** las 6 mismas, cada una con su descripción del papel y apuntando a las líneas 2 a 7
     del pedido, más `UPVC6MT` × 42 como línea 7 del comprobante, marcada **«Agregada»**.
     **Ninguna fila debe decir «Cambia de producto»**; si alguna lo dice, parar;
   - **Total después: S/ 6,438.00.**
4. **Total del papel vigente:** `6438.00`.
5. Motivo, por ejemplo «Pedido PED-000044 con datos erróneos; el correcto es PED-000056». Marcar la
   casilla y elegir **«Traer comprobante»**.
6. Se abre el detalle de FFA1-00001389: **Aceptado**, PED-000056, total S/ 6,438.00 y saldo
   S/ 6,438.00.

## 8. Despacho: decisión aparte [dueño]

Traer el comprobante **no despacha** y, a diferencia de D-378, **no abre** el despacho a la fecha
del comprobante. «Despachar a la fecha del comprobante» usaría el **20/08/2026**. Antes de
despachar, el dueño responde:

- **¿Cuándo salió de verdad la mercadería de PED-000056?**
  - **Si salió en agosto, con el papel:** se despacha a la fecha del comprobante y se siguen las
    reglas de D-374, línea por línea:
    1. un ítem de la carga inicial con el comprobante anterior a ella → `BEFORE_OPENING`, que
       entrega sin salida de kardex. Hoy la carga inicial está fechada el 01/08, así que no debería
       pasar;
    2. si a esa fecha había stock, la salida va el 20/08;
    3. si no había porque la compra se recibió con la fecha en que se digitó, primero se corrige la
       fecha de recepción (`fix:purchase-received-dates`: dry-run, respaldo y OK por compra);
    4. si aun así no alcanza, se despacha en la **primera fecha válida posterior** que sugiere el
       plan. **Nunca se fuerza un negativo.**
  - **Si todavía no salió:** no se despacha ahora. Se despacha cuando salga, con «Despachar» del
    pedido y la fecha real. Las reservas de PED-000056 siguen activas hasta entonces.

Un `REVIEW` en el plan de despacho se deja sin tocar y se le muestra al dueño.

## 9. Verificación [agente, foto `READ ONLY` con OK del dueño]

- FFA1-00001389: `ACCEPTED`, mismo `number`, `correlative`, `issue_date`, `customer_id`,
  `payment_terms` y `due_date` que en el paso 2, y `sales_order_id` = PED-000056;
- 7 filas: las 6 originales conservan su id y apuntan a las líneas 2 a 7 de PED-000056; la nueva
  apunta a la línea 1;
- `total_pen` = 6438.0000; saldo = total, sin cobros;
- hay un evento `invoicing.document.move-to-order` en 1389, uno
  `sales.order.document-moved-out` en PED-000044 y uno `sales.order.document-moved-in` en
  PED-000056;
- el kardex y las reservas están igual que en el paso 2, salvo los despachos del paso 8 si se
  hicieron;
- PED-000044 sigue `CANCELLED` y ya no tiene comprobantes.

## Vuelta atrás

- **Código:** con la web vieja, volver el tráfico a la revisión anotada en el paso 1. Con la web
  publicada, abrir un PR de revert, mergearlo y desplegar después la API.
- **Datos del paso 7:**
  - el comprobante se puede **anular internamente** otra vez, si no tiene cobros. Queda anulado en
    PED-000056;
  - no hay una acción para devolverlo a PED-000044: está anulado, y D-381 no trae un comprobante a
    un pedido anulado. La auditoría guarda el antes completo. Si hiciera falta deshacerlo, se decide
    con el dueño a partir del respaldo del paso 6;
  - un despacho del paso 8 se revierte desde su detalle (DES-…), con motivo.
