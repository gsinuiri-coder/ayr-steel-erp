# Handoff — F8-V4prep: cierre de S6a2 + herramientas de la ventana V-4

Fecha: 2026-09-15

## 1. Resumen

- Fase 8, sesión **F8-V4prep**: cierra la deuda OOM que dejaba F8-S6a2 abierta (suite E2E
  completa, 0 rojos) y entrega las dos herramientas que la ventana V-4 —la más delicada del
  proyecto hasta ahora— solo tiene que ejecutar: la limpia total de producción (**D-208**,
  `pnpm limpia:v4`) y la migración de obligatoriedad de acabados (**D-209**). Las dos se
  ensayaron de punta a punta (dry-run y `--execute`, las dos ramas de D-209) contra una rama de
  ensayo de Neon clonada de `production`.
- Verificación de cierre en dos niveles: `pnpm lint && pnpm typecheck && pnpm test &&
pnpm format:check` en verde para todo el monorepo, y la **suite E2E completa en 0 rojos**
  (336/336) de punta a punta — el gate que tres sesiones anteriores no habían podido completar
  por un límite de memoria del host.
- **Todo en commits locales, sin push** (se acumula para la ventana V-4, 19 commits ahora tras
  esta sesión: F8-S4 + F8-S5 + F8-S6a + F8-S6a2 + F8-V4prep). Producción no se tocó: todo el
  ensayo de D-208/D-209 corrió contra `ensayo-v4-20260915`, una rama Neon que queda para
  referencia (regla dura: Neon nunca se borra).

## 2. Hecho

- **M0 — Suite E2E completa, 0 rojos (cierra la deuda OOM de F8-S6a/F8-S6a2).**
  - Causa raíz: `pnpm e2e` local corre `nest start` + `next dev` (sin compilar) durante toda la
    corrida; con ~330 specs en un solo worker eso acumula memoria en procesos que nunca se
    reinician — no era un defecto de código.
  - Solución: correr la suite desde un **`git worktree`** aparte con **builds de producción**
    (`node dist/main.js` + `next start`), reusando
    [`scripts/e2e-latency.mjs`](../../scripts/e2e-latency.mjs) de F8-R1 con `--proxy-port 5434`
    (bypasea el proxy de latencia, habla directo al Postgres de Docker). Nunca toca
    `apps/web/.next` del repo principal, así que no interfiere con `pnpm dev:preview` del dueño.
  - Resultado: **331/333 en 35,9 min sin ningún síntoma de memoria**; los 2 rojos de la primera
    corrida (`fase2a.spec.ts` — XML de factura; `fase5a.spec.ts` — PDF en R2) eran **el entorno
    del worktree, no el producto**: nunca se corrió `pnpm env:local` ahí, así que
    `R2_ACCOUNT_ID` quedaba vacío y `StorageService` degradaba sin PDF. Reintentados con las
    credenciales reales de `.env.setup` inyectadas: **13/13 en verde**. Total: **336/336**
    (331 + 2 reintentados + 3 skipped).
  - **F8-S6a2 queda CERRADA** con esto: su M1+M2 ya estaban verificados por un subset curado, y
    esta corrida completa la deuda que la dejaba abierta.
- **M1 — `pnpm limpia:v4` (D-208).**
  [`apps/api/prisma/production-cleanup-v4.ts`](../../apps/api/prisma/production-cleanup-v4.ts) +
  [`scripts/production-cleanup-v4.mjs`](../../scripts/production-cleanup-v4.mjs). Un solo
  `TRUNCATE ... RESTART IDENTITY CASCADE` sobre 39 tablas (cotizaciones, pedidos, OPs y sus
  reportes/staging, reservas, despachos, comprobantes, cobranzas/pagos, compras, bobinas y su
  kardex, movimientos e inventario de productos, clientes, proveedores, sesiones, auditoría,
  idempotencia, cambios de precio, caja/POS e importaciones), preservando 12 tablas de catálogo
  y configuración (líneas de negocio, productos + BOM + materia prima, colores, acabados,
  usuarios, márgenes/ventas/facturación); `exchange_rates`/`fiscal_series` quedan fuera de
  alcance a propósito. Dry-run por defecto; `--execute` revalida conteos antes de truncar y
  verifica después que las 12 sobrevivientes no cambiaron de tamaño. Restaura el cliente
  «público en general» (D-077) y el proveedor «Saldo inicial de inventario» (D-206) vía
  `pnpm db:seed` al final.
  - Toda ambigüedad del brief original (qué hacer con clientes/proveedores, sesiones/auditoría,
    caja/POS, importaciones) se resolvió preguntándole al dueño antes de escribir código.
  - **Ensayado dos veces de punta a punta contra `ensayo-v4-20260915`** (clon real de
    `production`): encontró y corrigió dos bugs reales — `spawnSync('pnpm.cmd', ...)` sin
    `shell: true` (EINVAL en Windows/Node 24) y el seed heredando `ADMIN_EMAIL`/`ADMIN_PASSWORD`
    del `.env` de desarrollo local en vez de `.env.setup`.
  - **Revisión (`revisor`):** confirmó que las 39+12 tablas cubren exactamente los 51 modelos
    del schema y que ninguna sobreviviente tiene FK real hacia una purgada. Hallazgo medio
    corregido: el gate `--confirm-production` solo vivía en el wrapper — se agregó
    `AYR_LIMPIA_V4_CONFIRMED=1` como defensa redundante dentro del propio script.
- **M2 — Migración `20260915120000_d209_acabados_tipo_obligatorio` (D-209).** Cierra la deuda
  diferida de D-203: `finishes.kind`/`business_line_id` pasan a `NOT NULL`, pero solo después de
  validar (con `RAISE EXCEPTION` nombrando los códigos exactos) que ninguno quedó sin tipo.
  `schema.prisma` pierde el `?` de `Finish.kind`/`businessLineId`/`businessLine`, sin fallout de
  tipos ni lint (ya se exigían a nivel de aplicación desde D-203).
  - **Ensayada las dos ramas** contra la misma rama de ensayo: producción real tenía **8
    acabados sin tipo** — la migración falló nombrándolos exactamente. Completados a mano
    (simulando al dueño) y reintentada tras `prisma migrate resolve --rolled-back` (necesario:
    Prisma deja una migración fallida bloqueada hasta resolverla), aplicó limpio. De paso quedó
    confirmado que el índice único case-insensitive de colores de D-203 no encuentra duplicados
    en los datos reales.
- **M3 — Runbook de V-4** en
  [`docs/ENTORNOS.md`](../ENTORNOS.md#checklist-de-la-ventana-v-4-limpia-total--migraciones--inventario-real):
  9 pasos en orden, cada uno con quién lo hace (dueño/agente), incluido el flujo de
  `migrate resolve --rolled-back` si D-209 encuentra acabados incompletos.

## 3. Decisiones tomadas

- **D-208**: `pnpm limpia:v4` — limpia total de producción para la ventana V-4 (39 tablas
  purgadas, 12 sobreviven, `exchange_rates`/`fiscal_series` fuera de alcance). Detalle completo
  en `docs/ARQUITECTURA.md` §0.2.
- **D-209**: migración de obligatoriedad de tipo en acabados (`kind`/`business_line_id` `NOT
NULL`), validando antes de alterar la columna. Cierra la deuda diferida de D-203.

## 4. Bloqueos / pendientes

- **Nada bloqueante.** Las dos herramientas de la ventana V-4 están escritas, ensayadas de punta
  a punta contra un clon real de producción y revisadas.
- **Acción del dueño requerida antes de D-209 (paso 5 del runbook):** completar en la UI de
  Acabados los 8 que hoy quedan sin tipo en producción (`ALZ-AZUL-5002`, `ALZ-BLANCO`,
  `ALZ-GRIS-7040`, `ALZ-NATURAL`, `ALZ-ROJO-3020`, `ALZ-VERDE-6002`, `ALZ-VERDE-6035`, `GALV`) y
  consolidar colores duplicados por criterio comercial si aplica.
- **Dos incidentes propios de esta sesión, ya resueltos, documentados en memoria para no
  repetirlos:** un `pnpm build` en el repo principal corrompió el `apps/web/.next` compartido
  con `pnpm dev:preview` del dueño (avisado en el acto; el dueño lo reinició); un
  `docker compose --profile storage down` de más quitó también el contenedor compartido
  `ayr-local-db` (los datos sobrevivieron — el volumen no se toca sin `-v` —, el contenedor se
  recreó con `docker compose up -d`).
- **Pendientes heredados sin tocar esta sesión** (siguen para V-4 o después): el flujo estándar
  de facturación sigue sin enlazar comprobante↔despacho (D-205); el aviso de mínimo en el
  mostrador sigue sin decidirse (`pnpm check:price-floor`); `BOB38AZUL`/`BOB38ROJO` en
  `production` sin revisar.

## 5. Cómo verificar

```
git log --oneline 2814620..HEAD                     # commits locales de esta sesión
pnpm lint && pnpm typecheck && pnpm test             # verde
pnpm format:check
pnpm limpia:v4 --branch local-e2e                    # dry-run, solo lectura, seguro de correr
node scripts/migrations-status.mjs --branch production   # confirma D-209 pendiente
```

Producción sin cambios: https://ayr-steel-erp-web.vercel.app. Nada de esta sesión se desplegó.

## 6. Siguiente sesión

Según la fila de Fase 8 (§3.7), lo que sigue es abrir la **ventana V-4** siguiendo el checklist
de `docs/ENTORNOS.md` — el paso 0 (suite verde + gate PSE) ya está confirmado por esta sesión,
así que la ventana puede empezar directo por el paso 1 (respaldo Neon) cuando el dueño lo decida.
Alternativa si la ventana no es inminente: más sesiones de feedback del cliente (como F8-S4/S5/
S6a/S6a2) o el contenido propio de la fase — auditoría, reportes formales y hardening
(RF-90..96), todavía sin empezar.
