# Handoff — ventana PSE, correlativos D-365 (2026-09-30)

## 1. Resumen

Rama `fix/pse-correlativos-100` desde `origin/main` `22fdfe7`, en `../ayr-dep30`.
El gate local PSE quedó verde con el avance de 100 por serie decidido por el dueño.
El desfase previo de #62 quedó cerrado: la API de producción corre `git-sha=22fdfe7`, igual
que `main`. Esta rama del gate PSE aún no se desplegó.

## 2. Hecho

- Respaldo Neon `respaldo-pre-deploy-20260930` (`br-summer-salad-aeal2b09`), 81 migraciones al
  día y `migrate diff` igual al drift conocido antes de la ventana.
- CI de `main` `22fdfe7` verde. Deploy de API desde ese SHA a
  `ayr-steel-erp-api-00067-qqg`, con label `git-sha=22fdfe7` en servicio y revisión, 100 % del
  tráfico. `pnpm smoke:prod` pasó completo tras generar Prisma Client en el worktree de release;
  el primer intento falló solo por esa dependencia local. El admin efímero se eliminó.
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
- La suite común conserva el offset por reloj de D-202. No hubo escrituras en producción.
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
`docs(deploy): registrar cierre del desfase de #62` (este apunte).

## 4. Bloqueos / pendientes

- BC01: falta un último correlativo verificable y una boleta aceptada para ensayar su nota de
  crédito. Los demás casos PSE ya pasaron.
- Revisión final del dueño y aprobaciones separadas para push, merge y deploy. Cada operación
  sensible requiere comando exacto y OK explícito en la sesión.
- La rama está publicada en PR #63 en borrador. Su CI pasó sobre `f713d7b`; el deploy de esta
  rama y la revisión final del dueño siguen pendientes. El desfase anterior de #62 ya se cerró.
- Git desregistró el worktree temporal `../ayr-r62`, pero Windows dejó su directorio con
  `node_modules`. La política automática bloqueó `Remove-Item -Recurse`; se verificó que no hay
  `local-data/` en ese directorio.
- Sonnet no completó su pase por límite mensual de Claude Code; el segundo modelo disponible
  revisó el diff y el informe indica la sustitución. Falta la revisión final del dueño.

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

Para PR #63, solicitar la revisión del dueño y aprobación de las operaciones de publicación
que falten; no confundirlo con el despliegue ya cerrado de `main` `22fdfe7`. Cada comando
sensible exige su propio OK. No correr `e2e:prod`.
