# Handoff — F8-R2: salud E2E (Postgres del runner, smoke de Neon, correlativos)

Fecha: 2026-09-14

## 1. Resumen

- Fase 8, sesión **F8-R2** de salud E2E: implementa D-201 y deja la decisión D-202. Solo infra, sin
  cambios de producto ni de schema.
- La suite completa de CI corre ahora en un Postgres dentro del runner: **305 passed / 3 skipped en
  9,6 min**, contra 92 min en Neon. Neon `ci` queda para migraciones y un smoke de 12 archivos.
- CI verde en los cuatro jobs sobre la rama de medición (run 34900414817). Producción no se tocó.
  El push a `main` de este cierre es su propia validación.

## 2. Hecho

- **Postgres del runner.** En [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), el job
  `e2e` levanta un servicio `postgres:17-alpine` con la base `ayr_ci_e2e` en `localhost`. El
  timeout baja de 110 a 30 min.
- **Medición con la instrumentación de F8-R1**, en dos corridas de dos regiones:

  | Run                 | Runner  | Resultado              | Suite   | Consultas | ms/consulta |
  | ------------------- | ------- | ---------------------- | ------- | --------: | ----------: |
  | 34898572060         | WestUS3 | 303 passed / 2 failed  | 9,8 min |   124 504 |        0,07 |
  | 34900414817 (final) | eastus  | 305 passed / 3 skipped | 9,6 min |   124 661 |        0,08 |

  Contra Neon (F8-R1): 125 241 consultas a 42,4-80 ms. Las consultas no cambian; la diferencia es
  toda latencia.

- **Guard.** La lista blanca se movió a
  [`apps/api/prisma/test-db-guard.ts`](../../apps/api/prisma/test-db-guard.ts) y admite tres bases:
  `ayr_local_e2e`, `localhost/ayr_ci_e2e` (solo con `GITHUB_ACTIONS=true`) y el endpoint de Neon
  `ci`. Valida **las dos** URLs, por un ALTO de `revisor`: el `TRUNCATE` escribía por
  `DATABASE_URL` y solo se validaba `DIRECT_URL`. Probado con 12 combinaciones.
- **Smoke de Neon.** El job `smoke-neon` corre `migrate deploy` + `status` y después
  [`scripts/e2e-smoke.mjs`](../../scripts/e2e-smoke.mjs) (`pnpm e2e:smoke`): 12 archivos, cada uno
  con su motivo, sobre flujo comercial, staging de planta, kardex, emisión sin PSE, idempotencia
  y POS. Resultado: 35 passed en 8-14 min.
- **Correlativos por corrida.**
  [`apps/api/prisma/e2e-fiscal-offset.ts`](../../apps/api/prisma/e2e-fiscal-offset.ts) corre desde
  [`e2e/global-setup.ts`](../../e2e/global-setup.ts) y adelanta cada serie a
  `10 000 000 + (epoch s mod 80 000 000)`. Está documentado en
  [`e2e/README.md`](../../e2e/README.md) y en el checklist de ventana nuevo de
  [`docs/ENTORNOS.md`](../ENTORNOS.md).
- **Dos fallas que la latencia escondía.** `fase2a.spec.ts:514` y `m2-reversa-pago.spec.ts:263`
  chocaban con la descripción del drawer de pago mientras se cerraba. Se corrigieron con `exact`.
  `qa` barrió el resto de la suite y no encontró otros casos.
- **`docs/analisis/e2e-velocidad.md`** entra al repo con cabecera de «estimaciones sin medir».
- **Rama `diag/salud-e2e`**: borrada en el remoto, en local y su worktree.

## 3. Decisiones tomadas

- **D-202**: el E2E completo de CI corre en un Postgres de servicio en el runner. Neon `ci` queda
  para migraciones y smoke. Cada corrida parte de su propio correlativo fiscal, y el guard valida
  las dos URLs.

## 4. Bloqueos / pendientes

- **Sin verificar contra la cuenta demo de Nubefact**: falta confirmar que acepte un correlativo de 8 dígitos
  como primer número de una serie. Lo prueba el próximo `pnpm e2e:pse`, que necesita cupo en la
  cuenta demo (acción del dueño si está cerca de 50). Si Nubefact lo rechaza, D-202 se revisa
  antes de la próxima ventana.
- **Worktrees `../wt-r1-base` y `../wt-r1-head`** de F8-R1: siguen existiendo aunque el handoff
  anterior los daba por borrados. `wt-r1-head` tiene `e2e/tests/zz-bench-shortages.spec.ts` sin
  trackear. No se tocaron: decide el dueño.
- **Vuelta del rango de correlativos** el 2028-04-22: ese día hay que vaciar la cuenta demo una vez.
- **`fase7b` en `smoke-neon`**: sin PSE, «anular la venta del turno» espera 60 s y se salta. No es
  un rojo, pero cuesta un minuto.
- **Backlog de rendimiento sin cambios**: `stock-shortages` en producción, ~12 ms del pool y reducir
  consultas por test. Workers en paralelo no aprieta con una suite de 10 min.

## 5. Cómo verificar

```
gh run view 34900414817                     # los 4 jobs verdes: e2e 305 passed (9,6 min), smoke-neon 35 passed
gh run list --branch main --limit 1         # CI del push de este cierre
git ls-remote --heads origin "diag/*"       # vacío
pnpm e2e:smoke                              # local, contra ayr_local_e2e (~13 min)
pnpm e2e                                    # local; el log muestra «Correlativos de … parten de …»
```

Producción sin cambios: https://ayr-steel-erp-web.vercel.app ·
`curl -s https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app/health`

## 6. Siguiente sesión

**Fase 8 (§3.7): auditoría, reportes, hardening y UAT (RF-90..96).** La salud E2E ya no bloquea.
Primera tarea concreta: correr `pnpm e2e:pse` con cupo en la cuenta demo para cerrar la
verificación pendiente de D-202. Después, relevar RF-90..96 contra lo ya construido (`audit_log`,
reportes existentes) y armar el checklist de UAT del cliente.
