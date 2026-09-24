# Handoff — Ventana de producción RF-S4b (2026-09-24, madrugada)

Agente: Claude Code, worktree `ayr-steel-erp-rf-s4b`. Runbook: `docs/handoff/rf-s4b.md`. Cada
comando contra production, Cloud Run y `main` corrió con el OK del dueño y el comando a la vista
(D-251). Las lecturas de production se hicieron sin pedir OK por comando, con autorización del
dueño para esta ventana.

## Qué quedó desplegado

|               |                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------- |
| Respaldo Neon | `respaldo-pre-rf-s4b-20260924` (`br-twilight-bar-aed9b0m7`), hijo de `production`, 00:06 Lima |
| Migración     | `20260923180000_rf_s4b_products_merged_into`, 20 s, **sin seed** (D-262). 0 pendientes        |
| API           | Cloud Run `ayr-steel-erp-api-00043-gr7`, 100 % del tráfico, `git-sha=e247f40`, `/health` ok   |
| Web           | `main` = `57b10c9` (fast-forward desde `f60ab6c`, 48 commits); Vercel Production `success`    |
| PR            | #14 MERGED                                                                                    |
| Normalización | 9 renombres, 2 uniones, 0 paradas; `BOB…` 14/0 → 11/3                                         |
| Barrido       | 36 documentos abiertos corregidos (28 cotizaciones y 8 pedidos, 92 líneas), 0 rechazados      |

`git diff --quiet e247f40 57b10c9 -- apps packages Dockerfile .gcloudignore package.json
pnpm-lock.yaml pnpm-workspace.yaml` → exit 0: el label de la API corresponde al runtime de `main`.

## Secuencia y resultados

1. **Paso 0.** `.env.setup` presente; HEAD = origin/rf-s4b = `78feb99`; CI de `e247f40` verde
   (run 35955313518); `e247f40..78feb99` solo documentación.
2. **Respaldo** creado y verificado (`ready`, padre = id de `production`).
3. **Migración.** `migrations-status`: solo la de RF-S4b pendiente. `migrations-diff`: el drift
   conocido exacto de AGENTS.md §8 (5 defaults de `operation_date`, 5 FK, 2 índices, 1
   renombre) más la columna, el índice y la FK de `merged_into_id`. **Al leer `db-prod.mjs` antes
   de correrlo apareció que también sembraba** (upsert del admin y una fila `seed.admin` en
   `audit_log`): el dueño decidió invertir el default (D-262, commit `57b10c9`). Después,
   `pnpm db:prod` aplicó solo la migración.
4. **Deploy API** desde `e247f40` en detached (el script etiqueta con el HEAD): 255 s, nombres de
   variables verificados, revisión y servicio con `git-sha=e247f40`.
5. **Smoke de solo lectura** con web viejo + API nueva: verde.
6. **Línea base** (`scripts/snapshot-reports.mjs`, nuevo): idéntica a la de demo al centavo —
   inventario S/ 1 108 105.2721, margen agosto S/ 304 394.4022, año S/ 308 419.8262, `BOB…` 14/0.
7. **Normalize.** Dry-run igual al de demo línea por línea (9 + 2, 0 no interpretables, abiertos
   COT-000002 y COT-000011, 63 bobinas y 204 371.418 kg, 0 paradas). Execute con
   `--ack-open-documents` en 60 s, terminado a las 00:37 Lima (desde acá, D-261). Reportes iguales al centavo, `BOB…` 11/3 e idéntico al
   normalizado de demo.
8. **Sweep.** Dry-run: 113 revisados; (a) 3, (b) 107, (c) 2. **36 abiertos en (b), 92 líneas**,
   diferencia máxima 0.0050 / 0.0055 / 0.0030 (COT-000032 l3), ningún comprobante en dos
   documentos abiertos, COT-000002 en 12 439.83 / 2 239.17 / 14 679.00. Contra demo: 28/8 en vez
   de 27/9, 113 en vez de 114 y 107 en vez de 108 — **la única diferencia es COT-000002 ↔
   PED-000042**: en el ensayo, COT-000002 se había confirmado (PED-000042) antes del dry-run del
   trío. Explicación aceptada por el dueño. Execute: 270 s, 36 corregidos. Reportes iguales.
9. **Merge a `main`** con `AYR_OWNER_PUSH=1` (`f60ab6c..57b10c9`), sobre la CI verde de
   `57b10c9` (run 35959589794: lint/typecheck/unit, E2E 14m41s, smoke Neon `ci`, Sonar y su gate,
   Vercel). Vercel publicó.
10. **`pnpm smoke:prod`** contra `ayr-steel-erp-web.vercel.app`: verde.
11. **Verificación de negocio, sin confirmar nada:**
    - **COT-000002:** EMITTED, 12 439.83 / 2 239.17 / **14 679.00**, línea `BOB038AZUL` 4194 kg
      atada a **SALDO-ALZ-AZUL-5002-0.38-4194-7**. Botón Confirmar habilitado.
    - **COT-000011 (FFA1-1355):** EMITTED, 11 715.25 / 2 108.75 / **13 824.00**, `BOB038ROJO`
      3840 kg atada a **SALDO-ALZ-ROJO-3020-0.38-3840-12**. Botón Confirmar habilitado.
    - Confirmarlas es del owner: crea el pedido y la reserva.

Listas, fotos y salidas: `local-data/rf-s4b/ventana/` (no se commitea).

## Lo que el siguiente tiene que saber

- **Punto sin vuelta atrás pasado.** La ventana terminó sin `--revert`. Desde que alguien opere,
  la corrección es hacia adelante (D-261).
- **Rollback de la API, registro histórico:** hasta el execute de normalize, el rollback era
  `cmd /c gcloud run services update-traffic ayr-steel-erp-api --project ayr-steel-erp --region
us-central1 --to-revisions ayr-steel-erp-api-00042-tdb=100` (revisión `0e1124b`). **Ya no
  vale**: la API vieja busca los SKU viejos.
- **«Atada» no es «reservada».** La línea de COT-000002 apunta a la bobina
  (`reserveItemType=COIL` en `quotation_items`), pero no hay reserva en el ledger ni reserva
  temporal: la reserva nace al confirmar (RF-61/RF-62). Lo que sí cambia desde el barrido
  (execute de 00:46 a 00:51 Lima) es que la bobina sale del **pool de venta** (`coilPoolFor`): el importador, el
  selector y «Cambiar bobina» no la ofrecen a otro documento. Stock disponible, OP y kardex no la
  ven tomada; si la planta la montara en una OP antes de confirmar, la confirmación la rechaza
  (revalidación de D-254).
- **La vista de la cotización no muestra la bobina atada**, solo el producto `BOB038AZUL`. El
  dato está en la API (`reserveItemLabel`). Anotado como deuda de UI, no corregido.

## Pendientes

- **COT-000053 y COT-000054 quedaron en (c), «editadas a propósito», para que el owner las
  revise.** Las dos están **anuladas**, y el barrido no las toca. Diagnóstico (solo lectura):
  - Papel: FFA1-1393 = 2000 **UNIDAD** de `PL030NT6M` (plancha de 6000 mm) por S/ 100 000 + IGV;
    FFA1-1394 = 1500 UNIDAD de `PL040NT6MT` por S/ 109 322.034 + IGV.
  - Importadas bien: 50.00 y 72.8814 por unidad.
  - El 22/09/2026 a las 00:32 y 00:33 el Administrador registró un cambio de precio: «S/ 59.00 →
    S/ 59.00 /m» y «S/ 86.00 → S/ 86.00 /m». El mismo número pasó de **por plancha** a **por
    metro** (D-161: unidad de negociación). Con planchas de 6 m, el unitario quedó en 300.00 y
    437.2884 por unidad: **×6 exacto**.
  - Esa misma noche se crearon **COT-000072** (FFA1-1393, 118 000.00, → PED-000017) y
    **COT-000073** (FFA1-1394, 129 000.00, → PED-000016), con los importes del papel; 053 y 054
    quedaron anuladas. El riesgo que queda es solo de lectura: dos anuladas con importes ×6.
- **`ADMIN_PASSWORD` de `.env.setup` da 401 contra production** (credencial vieja). La foto de
  reportes usó el admin efímero (`--ephemeral-admin`). Actualizarla es del dueño.
- **`smoke:prod --base-url https://v2.mareliac.pe` no corre**: el guard de dominio solo acepta
  `*.vercel.app` o un host con `ayr`. Deuda chica.
- **Respaldo `respaldo-pre-rf-s4b-20260924`**: se conserva; su borrado se propone en una ventana
  posterior, con OK por nombre.
- **Revisión:** RF-S4b sigue **PENDIENTE DE REVISIÓN INDEPENDIENTE** (el delta posterior a
  `d29a342` y D-262 incluidos).
- Los pendientes del handoff de RF-S4b siguen vigentes (P2-4, P2-7, D-252, D-254, D-011, E2E de
  UI del selector).

## Commits de la ventana

`57b10c9` fix(scripts): `db:prod` solo migra (D-262) → docs de cierre (este handoff,
`scripts/snapshot-reports.mjs`).
