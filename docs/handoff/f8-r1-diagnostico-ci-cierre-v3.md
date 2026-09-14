# Handoff — F8-R1: diagnóstico de la lentitud del E2E en CI y cierre de la Ventana V-3

Fecha: 2026-09-14

## 1. Resumen

- Fase 8, sesión de **diagnóstico** F8-R1: FASE 1 completa, causa nombrada y **sin fix de producto,
  porque no hay regresión de producto** (D-201).
- La lentitud del E2E en CI es consultas × latencia runner→Neon, que cambia con la región del
  runner. El lote F8 sube el total de consultas ×1,64 sin encarecer cada una.
- Prod al día: 61/61 migraciones, API `ayr-steel-erp-api-00032-bdn` al 100 % y `/health` ok. La
  CI completa del lote es el run 34875631463 (305 passed en 92 min). **Ventana V-3 CERRADA.**

## 2. Hecho

- **Paso 1 de FASE 1:** `stock-shortages` no explica CI. En los specs 1-31, con latencia y muestreo,
  nunca hubo más de 2 cotizaciones emitidas a la vez.
  [`docs/analisis/f8-r1-rendimiento.md`](../analisis/f8-r1-rendimiento.md) §4.
- **Descartados** R2, PSE, polling del web, `next dev` y padrón (§5).
- **CI instrumentada** en la rama `diag/f8-r1-instrumentacion`: consultas y su duración por test,
  medidas con un preload de Prisma solo en el proceso del API. La forma es uniforme por consulta:
  mismas consultas (×1,02 contra local), sin picos y sin acumulación (§6).
- **A/B** sobre `e184ca1` (runner `eastus`, 16 ms de RTT, 18,8 ms por consulta), y HEAD relanzado
  con una sonda de RTT y `SELECT 1` en paralelo (runner `centralus`, 33 ms de RTT, 42,4 ms por
  consulta). El mismo HEAD había pagado 80 ms por consulta con las mismas consultas (§6, Causa).
- **Ramas diag** borradas (remoto y worktrees). La instrumentación quedó copiada en
  `local-data/r1/tools/diag/`, fuera de git.
- **Cierre de V-3** en [`docs/PROGRESO.md`](../PROGRESO.md): migraciones 55→61 (D-184 y D-189
  mutan datos), gate PSE aceptado por clasificación, B-V3-5 resuelta, la corrección de la lectura
  «la regresión es del lote» y la deuda. Las filas F8-S1..S3c pasan a «Desplegado en la Ventana
  V-3».
- **Herramientas locales** que quedan en el repo: `scripts/latency-proxy.mjs`,
  `scripts/e2e-latency.mjs`, `scripts/e2e-roundtrips-reporter.mjs` y
  `scripts/e2e-latency-compare.mjs`, documentadas en `docs/ENTORNOS.md` → «E2E con latencia».

## 3. Decisiones tomadas

- **D-201** — La lentitud del E2E en CI es consultas × latencia runner→Neon por región. El E2E de
  CI pasa a un Postgres de servicio dentro del runner, y Neon queda para el chequeo de migraciones
  y un smoke chico. Reducir consultas por test queda como higiene; workers en paralelo se
  reevalúa después; fijar región no es viable en runners hosted.

## 4. Bloqueos / pendientes

- **Sesión de salud E2E** (no hecha, es de otra sesión): Postgres de servicio en el runner, smoke
  de Neon (~10-15 specs más el guard de reset) y correlativos de la cuenta demo de Nubefact.
  **Hasta entonces, la CI de `main` puede volver a cortarse por timeout según dónde caiga el
  runner**, sin que eso sea una regresión. Incluye la CI que dispara el push de este cierre.
- **Backlog de rendimiento:**
  - `stock-shortages` cuesta ~16 consultas por cotización emitida en cada carga del Panel; es
    riesgo de producción.
  - El API paga ~12 ms por consulta por encima de la sonda en CI.
  - Reducir consultas por test.
- **Fragilidad bajo latencia** de `fase2a.spec.ts:471` y `m2-reversa-pago.spec.ts:233`, y un
  `ECONNRESET` intermitente del rewrite de Next en `fase7d.spec.ts:94` en local.
- **`docs/analisis/e2e-velocidad.md`** estaba sin trackear desde antes de esta sesión. No lo toqué
  ni lo commiteé; queda para el dueño.
- Sin acción humana requerida para cerrar esta sesión.

## 5. Cómo verificar

```
node scripts/migrations-status.mjs --branch production    # «61 migrations found … up to date»
cmd /c gcloud run services describe ayr-steel-erp-api --region us-central1 --format="value(status.latestReadyRevisionName)"
curl -s https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app/health   # {"status":"ok","db":"ok"}
gh run view 34875631463                                     # CI completa del lote: 305 passed, 92 min
gh run list --branch main --limit 3                         # CI del push de cierre (docs)
git ls-remote --heads origin "diag/*"                       # vacío: ramas diag borradas
```

Web de producción: https://ayr-steel-erp-web.vercel.app

## 6. Siguiente sesión

**Sesión de salud E2E (D-201).** Primera tarea concreta: en `.github/workflows/ci.yml`, agregar al
job `e2e` un servicio `postgres` en el runner y apuntar `DATABASE_URL`/`DIRECT_URL` de la suite
completa a él. Ajustar el guard de `apps/api/prisma/reset-test-db.ts` para aceptar ese host sin
abrirlo a otras bases, y medir el tiempo de la suite con la misma instrumentación
(`local-data/r1/tools/diag/`). Después, el job de smoke contra la rama `ci` de Neon
(migraciones, ~10-15 specs y el guard de reset) y los correlativos de Nubefact. Recién con eso en
verde, seguir con Fase 8 (§3.7: auditoría, reportes, hardening y UAT, RF-90..96).
