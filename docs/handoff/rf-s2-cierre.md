# Handoff — RF-S2-CIERRE (bloqueantes antes de integrar)

## Resumen

Cierre de RF-S2 (auditoría): tres puntos que el brief pedía resolver o justificar con
contraejemplo antes de integrar (append-only real, límite de paginación entre fuentes,
invariante de transacción), más la suite E2E **completa** con builds de producción — lo único
que había quedado sin correr al cerrar RF-S2. Los tres puntos ya estaban en orden o se
resolvieron con prueba, no solo documentados. `rf-s2` sigue sin merge ni push; `main` intacto.

## Hecho

- **PASO 0**: `git rebase origin/main` fue un no-op — `origin/main` (`f92a3df`) ya es
  ancestro de `rf-s2`. Sin conflictos.
- **M1 (D-221)**: `audit_log` ya era inmutable a nivel de base sin ninguna brecha (trigger sin
  excepción por entorno, sin FK, ningún helper borra filas puntuales). Se agregó el test que
  faltaba contra una base real: `e2e/tests/audit-log-immutable.spec.ts`.
- **M2 (D-220, deuda → resuelta)**: el límite de paginación entre fuentes distintas se
  resolvió con el argumento matemático (el `take: pageSize` por fuente ya alcanza) más los
  tres escenarios adversariales que pedía el brief, todos en verde:
  `apps/api/src/audit/audit-query.service.spec.ts`.
- **M3 (D-222)**: centinela nuevo, `apps/api/src/audit/audit-tx-invariant.spec.ts` — recorre
  por glob todos los `*.service.ts` y verifica que `audit.write()` siempre pasa `tx`, nunca el
  cliente global; no existía ningún test de este tipo.
- **Suite E2E completa**, corrida desde este worktree con `next build`/`nest build` y
  `CI=true` (mismo camino que el job `e2e` de GitHub Actions): **356 tests — 351 pasan, 3 se
  saltan por diseño, 2 fallan por una causa ajena a esta sesión** (detalle abajo).

## Decisiones tomadas

- **D-220** (actualizada): el límite de paginación entre fuentes pasa de "deuda documentada" a
  "resuelto, con prueba".
- **D-221**: verificación de M1 — sin brecha, test nuevo contra base real.
- **D-222**: centinela nuevo del invariante de transacción de `AuditService`.

## Bloqueos / pendientes

- **2 fallas de E2E, las dos por R2 (almacenamiento de archivos) sin configurar en este
  entorno** — `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET` vacíos, y
  ninguno es un secreto que el agente deba o pueda tener. Confirmado leyendo el código:
  - `e2e\tests\fase2a.spec.ts:359` — `PurchasesService.previewFromXml` llama a
    `StorageService.putObject` sin `try/catch`; con R2 sin configurar tira
    `ServiceUnavailableException` y el preview del XML nunca llega a la pantalla.
  - `e2e\tests\fase5a.spec.ts:100` — la generación del PDF de una cotización nueva tampoco
    atrapa ese error; `quotation.pdfKey` queda `null`.
  - A diferencia del PDF de un comprobante ya emitido (`invoicing.service.ts#storeFiles`, que
    sí es _best-effort_ a propósito, D-068), estos dos caminos no tienen ese tratamiento. **No
    es una regresión de esta sesión ni de RF-S2** — son rutas de Fase 2a y Fase 5a, sin tocar.
    Acción humana: el dueño decide si `previewFromXml` y el PDF de cotización deberían ser
    _best-effort_ como el de `invoicing`, o si de verdad tienen que fallar sin R2.
- **3 saltos de E2E, por diseño**: `fase5b-bordes.spec.ts:92`, `fase7b.spec.ts:254` y `:339`
  — los tres dependen de que SUNAT confirme `ACCEPTED`/`REJECTED` de verdad, y este entorno no
  tiene credenciales reales de Nubefact (`probePse()`, ya documentado desde antes; no es un
  hallazgo de esta sesión). Sin acción requerida.
- **`rf-s2` sigue sin merge ni push.** El dueño decide cuándo integrarla — ninguno de los dos
  hallazgos de arriba bloquea la auditoría en sí; el visor y todo lo que construyó RF-S2 pasa
  limpio (ningún test de `audit/` ni de esta sesión está entre las fallas ni los saltos).

## Cómo verificar

Desde `C:\Users\User\Documents\workspace\ayr\ayr-steel-erp-rf-s2` (worktree de esta sesión,
rama `rf-s2`):

```
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check
# unitarios/integración: 40 test suites, 568 tests, 0 fallidos
```

Para reproducir la corrida E2E completa (production build, ~23 min, Postgres local en Docker):

```
CI=true \
DATABASE_URL="postgresql://ayr:ayr_local@127.0.0.1:5434/ayr_local_e2e?schema=public" \
DIRECT_URL="postgresql://ayr:ayr_local@127.0.0.1:5434/ayr_local_e2e?schema=public" \
JWT_SECRET="ayr-local-docker-secreto-de-desarrollo-nunca-usar-fuera-de-localhost" \
ADMIN_EMAIL="admin@ayr.local" ADMIN_PASSWORD="AyrLocal-2026!" \
E2E_ADMIN_EMAIL="admin@ayr.local" E2E_ADMIN_PASSWORD="AyrLocal-2026!" \
ALLOW_DB_RESET=1 THROTTLE_DISABLED=true PSE_ENABLED=true \
pnpm exec playwright test --reporter=list
```

Ninguno de esos valores es un secreto real (mismos que documenta `scripts/local-docker-env.mjs`
para el Postgres local). Con credenciales reales de R2 en el entorno, los 2 fallos deberían
desaparecer; con credenciales reales de Nubefact demo, los 3 saltos correrían de verdad.

```
git log --oneline 49fe903..HEAD   # 16 commits de RF-S2 + RF-S2-CIERRE
git status --porcelain             # limpio
git diff main --stat               # nada toca main
```

## Siguiente sesión

`rf-s2` queda lista para que el dueño la revise e integre cuando decida — no hay ningún
bloqueante propio de la auditoría. Si prioriza cerrar primero los dos hallazgos de R2 (fuera
de alcance de esta sesión), la primera tarea sería decidir el tratamiento de
`previewFromXml`/PDF de cotización frente a R2 no configurado y, si aplica, aplicar el mismo
patrón _best-effort_ que ya usa `invoicing.service.ts#storeFiles`. Si no, la Fase 8 sigue con
los cinco reportes de RF-90..94, como ya quedó anotado en el handoff de RF-S2.
