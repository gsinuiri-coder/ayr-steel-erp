# Ventana cc44 — Drywall: protección de main, piezas enteras, sin meta, kerf con costo y OP sin pedido

2026-10-11, sesión atendida en modo continuo. Ventana suspendida (D-533). Sin migraciones, sin SQL
contra producción. D-597 a D-602 nuevas, ratificadas por el dueño el 2026-10-11.

## En producción

| Corte | Qué                                | Resultado                                                       |
| ----- | ---------------------------------- | --------------------------------------------------------------- |
| (a)   | `pnpm deploy:api` desde `0c9366db` | API `00115-wnv` (`git-sha=0c9366db`), 100 %; `smoke:prod` verde |
| (b)   | merge de PR #173 (`b65e396b`), web | Vercel en verde; `smoke:prod` verde                             |

- Vuelta atrás de la API: tráfico a `00114-mgd`.
- `git diff --quiet 0c9366db b65e396b -- apps packages Dockerfile …` → exit 0 (alineado).
- CI del PR en verde sobre `0c9366db` (shards, `test:db`, `smoke-neon`, Sonar).
- Suite E2E local completa con builds de producción (`CI=true`, base `ayr_local_e2e_cc44`):
  588 passed, 19 failed, 1 flaky, 2 skipped. Los 19 son de entorno local, ninguno de drywall ni
  corte: emisión sin PSE (`Emisión electrónica no habilitada`), PDF sin R2, y los CLI de
  inventario inicial, normalización, barrido y purga, que buscan la base `local-e2e` por defecto.
  La CI, con esos secretos, pasó las 610.
- **UAT de solo lectura en producción** (admin efímero, borrado): formulario sin «Meta de piezas»
  ni «Pedido a atender» y con la nota de corrida de stock; `/produccion/[id]` de la única OP de
  perfiles (cerrada) sin decimal en piezas teóricas; historial sin «N / M und»; 0 órdenes de
  corte. Salida y capturas en `local-data/cc44/uat/`.

## Qué entró

| Pieza                      | Decisión | Dónde                                                                                                                                      |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Kerf con costo             | D-597    | `cutting.service.ts` (`receive`), `cutting-math.ts` (`receptionCosts`, `prorateReceptionValue`), `coils.service.ts` (`kardexTotalCostPen`) |
| Pedido de perfil con stock | D-598    | Sin cambio de código; fijado por `e2e/tests/drywall-stock-cc44.spec.ts`                                                                    |
| OP de perfiles sin pedido  | D-599    | `new-order-cards.tsx` (sin «Pedido a atender»; la web no manda `reservationId`)                                                            |
| Piezas teóricas enteras    | D-600    | `drywall-order-panel.tsx`, `produccion-detalle-view.tsx`                                                                                   |
| Sin meta de piezas         | D-601    | `new-order-cards.tsx`, `drywall-order-panel.tsx`, `order-history.tsx`, `production-orders-card.tsx`, `planta-view.tsx`                     |
| Protección de `main`       | D-602    | GitHub (aplicada al abrir la sesión); `docs/ENTORNOS.md`, `AGENTS.md` §3.2                                                                 |
| Diagnóstico                | —        | `pnpm inspect:cc44` (solo lectura)                                                                                                         |

El API sigue aceptando `targetPieces` y `reservationId` opcionales en `POST /production`
(compatibilidad, sin migración). Las OPs viejas con pedido lo siguen mostrando con su enlace.

## Protección de `main` (D-602)

Configuración aplicada con `gh api -X PUT …/branches/main/protection`:

```json
{
  "required_status_checks": {
    "strict": false,
    "checks": [{ "context": "E2E Playwright (Postgres del runner)", "app_id": 15368 }]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
```

No había checks obligatorios antes (la rama no tenía protección). Verificación: push de prueba a
`chore/cc44-prueba-proteccion` (entró y se borró con `gh api -X DELETE`); `main` figura
`protected: true`. Nunca se empujó a `main`. Ningún flujo dependía de empujar directo a `main`.

## Kerf con costo (D-597)

Ejemplo (el del db-spec): bobina de 1 220 mm a S/ 4.1234/kg, se reciben 1 500 kg cortados en
600 + 560 mm con 20 mm de kerf.

| Concepto                      | Antes                  | Ahora                               |
| ----------------------------- | ---------------------- | ----------------------------------- |
| Sale de la madre              | 1 500 kg, S/ 6 185.10  | igual                               |
| Fleje 600 mm                  | 737.705 kg a S/ 4.1234 | 737.705 kg, su parte por kilo       |
| Fleje 560 mm                  | 688.525 kg a S/ 4.1234 | 688.525 kg, su parte por kilo       |
| Valor en flejes               | S/ 5 880.92            | **S/ 6 185.10** (exacto)            |
| Kerf + borde (73.770 kg)      | S/ 304.18 perdidos     | repartidos en los flejes            |
| Costo del documento del fleje | 4.1234                 | 4.3367 (4.1234 × 1 500 / 1 426.230) |

Reversa: cada entrada se revierte por el valor con que entró, así que madre y flejes vuelven
exacto; una segunda recepción reparte otra vez exacto. La factura de corte posterior suma por kilo
encima (db-spec: flejes = salida de la madre + S/ 300 del servicio).

**Producción:** `pnpm inspect:cc44 --branch production --confirm-production` (transacción READ
ONLY, 2026-10-11): **0 recepciones de corte, 0 órdenes de corte**. No hay históricos que reparar.

## Pruebas

- Unitarios: `cutting-math.spec.ts` (reparto, redondeo al pesado, borde casi nulo,
  `receptionCosts`), `coils.service.spec.ts` (`kardexTotalCostPen`).
- `cutting-kerf-cost.db-spec.ts` (4): recepción con kerf, reversa exacta + segunda recepción,
  bobina en USD, factura del corte después.
- E2E: `fase3.spec.ts` con los costos nuevos (4.2069 y 4.4172), `fase7e-ajustes-d121.spec.ts`
  (piezas enteras, sin «Meta»), nuevo `drywall-stock-cc44.spec.ts`.
- `seed:escenarios`: la integración ya no manda `targetPieces`; el sembrado no usaba meta ni pedido.
- Capturas antes/después en `local-data/cc44/capturas/` (panel, detalle, historial, pedido,
  formulario).

## Revisión

Autorrevisión (subagente sin el handoff) y segundo modelo (`docs/revision/cc44-segundo-modelo.md`):
0 P0, 0 P1. Atendidos: casos USD, reversa con valorizado, segunda recepción, reparto truncado (el
pesado nunca queda negativo), notas en D-597 (`totalCostPen` = valor de kardex; partido interno
sin cambio a propósito). SonarCloud pidió cobertura de unitarios: el cálculo pasó a
`receptionCosts`.

## Para la próxima sesión

- D-597..D-602 ratificadas por el dueño el 2026-10-11.
- El partido interno (RF-15) sigue perdiendo el valor del borde: si el dueño lo quiere como el
  corte tercerizado, es otra decisión.
- `AYR_OWNER_PUSH=1` ya no sirve: GitHub rechaza el push directo a `main` también para el dueño.
