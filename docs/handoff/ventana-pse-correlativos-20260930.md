# Handoff — ventana PSE, correlativos D-365 (2026-09-30)

## 1. Resumen

PR #63 (`fix/pse-correlativos-100`) integrado en `main` por avance directo al SHA `18a4eb5`.
El gate local PSE quedó verde con el avance de 100 por serie decidido por el dueño. El desfase
previo de #62 se cerró en `22fdfe7`; el release final de #63 dejó API y web en `18a4eb5`.

## 2. Hecho

- Respaldo Neon `respaldo-pre-deploy-20260930` (`br-summer-salad-aeal2b09`), 81 migraciones al
  día y `migrate diff` igual al drift conocido antes de la ventana.
- CI de `main` `22fdfe7` verde. Deploy de API desde ese SHA a
  `ayr-steel-erp-api-00067-qqg`, con label `git-sha=22fdfe7` en servicio y revisión, 100 % del
  tráfico. `pnpm smoke:prod` pasó completo tras generar Prisma Client en el worktree de release;
  el primer intento falló solo por esa dependencia local. El admin efímero se eliminó.
- El dueño validó el UAT de #62 y revisó la entrega. CI de PR #63 verde en `18a4eb5`.
  Sin migraciones nuevas ni cambios de código de producto respecto de `22fdfe7`; las nueve
  versiones de secretos coincidieron con la revisión anterior.
- Deploy de API de #63 a `ayr-steel-erp-api-00068-44h`, label `git-sha=18a4eb5` en servicio y
  revisión, 100 % del tráfico. Smoke previo con web vieja verde. Con OK individual D-232,
  `main` avanzó directamente al mismo SHA; GitHub marcó PR #63 como integrado y Vercel publicó
  Production desde ese SHA. `pnpm smoke:prod --base-url https://v2.mareliac.pe` pasó completo
  después del push; el admin efímero se eliminó. Diff de runtime contra `origin/main` vacío.
  CI de `main` verde en `18a4eb5`, run `36782561987`: calidad, E2E Playwright completo,
  análisis estático y smoke/migraciones Neon `ci`.
- El gate `pnpm e2e:pse` guarda en el checkout principal los últimos correlativos de F001,
  B001, FC01 y T001 respaldados por Nubefact, inicia la siguiente corrida 100 después y
  conserva `BC01: null`. BC01 queda inactiva solo en Docker E2E PSE.
- Antes de reservar un bloque, comprueba escritura y lectura en MinIO local. El reporte JSON
  debe contener exclusivamente los casos `@pse`, todos sin fallos ni omisiones.
- Antes de reservar, también exige que URL y token de `apps/api/.env` coincidan exactamente con
  `NUBEFACT_DEMO_URL`/`NUBEFACT_DEMO_TOKEN` de `.env.setup`, para impedir emisiones de prueba
  en otra cuenta.
- El gate completo pasó 12/12 en 6,1 min. Últimos confirmados: `F001=39421294`,
  `B001=39421285`, `FC01=39421282`, `T001=39431233`; BC01 sigue desconocido.
- La suite común conserva el offset por reloj de D-202. El gate PSE no escribió en producción.
- La QA común detectó y corrigió un reintento defectuoso del selector de cliente en
  `e2e/helpers/ui.ts` y una suposición de menos de 200 clientes en
  `selector-cliente-f8s3c.spec.ts`. Los seis casos afectados y la regresión de buscador abierto
  pasaron en la primera corrida focalizada 25/25. La corrección final distingue el buscador
  `Elegir · ...` de un diálogo de negocio que pueda contenerlo; el caso de cambio de cliente
  y la regresión de buscador ya abierto pasaron en focalizados posteriores.
- El mismo reintento se corrigió en `chooseProductWithStock`. Sus tres specs afectados pasaron
  13/13 en focalizado y los dos flujos antes rojos pasaron en la suite completa final.

## 3. Decisiones tomadas

- **D-365** — avanzar 100 por serie desde el último valor usado; guardar el estado local
  entre corridas; suspender BC01 en este gate hasta verificar su contador. Limpiar la cuenta
  demo no reinicia la numeración.

Commits locales de esta entrega, en orden: `fix(e2e): avanzar correlativos PSE por serie`
(`ee1e4e6`), `test(e2e): estabilizar selectores y tabla de bobinas` (`bb94ea2`),
`docs(pse): registrar decisión, revisión y QA` (`f713d7b`), y
`docs(deploy): registrar cierre del desfase de #62` (`18a4eb5`). Este cierre posterior es solo
documental y se agrega después de verificar la CI de `main`.

## 4. Bloqueos / pendientes

- BC01: falta un último correlativo verificable y una boleta aceptada para ensayar su nota de
  crédito. Los demás casos PSE ya pasaron.
- El dueño borró el residuo de `../ayr-r62`. También se retiraron `../ayr-fechadesp`,
  `../ayr-fechas` y `../ayr-log` después de comprobar que sus trabajos se integraron; los cinco
  archivos de `ayr-fechas/local-data/` se copiaron al checkout principal y se verificaron por
  tamaño y hash antes del borrado. Los otros worktrees conservan trabajo o PR abiertos.
- Sonnet no completó su pase por límite mensual de Claude Code; el segundo modelo disponible
  revisó el diff y el informe indica la sustitución. El dueño confirmó la revisión final.

## 5. Cómo verificar

```text
pnpm test:scripts
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm e2e:pse
```

Resultados de esta ventana: scripts 47/47; API unitarios 1966/1966 en serie; web unitarios
88/88; lint, typecheck y build verdes. Primera corrida PSE 11/12: almacenamiento local sin R2
(infraestructura). Tras habilitar MinIO, segunda corrida 12/12, sin fallos ni omitidos.
Primer pase E2E común: 452 passed, 6 failed (helper de prueba), 3 skipped, 1 flaky (fixture de
clientes), en 49,0 min. Los specs focalizados tras corregir el helper pasaron 25/25.
Pase completo final: **460 passed, 0 failed, 1 flaky, 3 skipped**, exit 0, 44,4 min, con builds de
producción. El flaky de la tabla de bobinas se corrigió y su spec pasó 1/1 en focalizado. El
gate PSE separado pasó 12/12. Un diagnóstico imprimió cookies de sesión E2E locales; se
invalidaron con el siguiente reset de `ayr_local_e2e`, sin credenciales de producción.

## 6. Siguiente sesión

No hay otra tarea autorizada en esta ventana. `BC01` permanece inactiva en el gate PSE hasta
conocer su último correlativo y contar con una boleta aceptada; cualquier cambio posterior
requiere una decisión del dueño. No correr `e2e:prod`.
