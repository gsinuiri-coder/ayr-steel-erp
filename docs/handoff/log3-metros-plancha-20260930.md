# Handoff — LOG-3, metros reportados de planchas (2026-09-30)

## 1. Resumen

La revisión #57 se portó desde una base 23 commits antigua a `fix/log3-current`, nacida de
`origin/main` `7212b0f` en `../ayr-log3r`. El alcance aprobado por el dueño corrige el avance
visible de planchas de catálogo en pedido y planta; `readiness` del pedido queda intacto.
La CI de `main` en `7212b0f` está verde (run `36784967948`).
Sin migración, escritura de datos, push, PR nuevo ni deploy al redactar este handoff. La suite
E2E completa local terminó con rojos de entorno ajenos a LOG-3 y la CI de rama queda pendiente
del push autorizado.

## 2. Hecho

- `ProductionService.findAll` agrega `planMetersReported` desde los largos de reportes vigentes
  de plancha NIU. Para MTR usa los metros del reporte. `metersReported` conserva la unidad de
  kardex y drywall conserva el avance en piezas.
- El DTO y las vistas de tarjeta de OP en pedido e historial de planta usan el nuevo avance
  frente a `planMeters`. No se toca el cálculo de `readiness` de ventas.
- La consulta de listado selecciona solo reportes `ACTIVE`; si las reversas llenan los 200
  reportes del detalle, el avance del plan consulta todos los vigentes por separado.
- Revisión de segundo modelo en `docs/revision/log3-metros-plancha-segundo-modelo.md` y
  autorrevisión final en `docs/revision/log3-metros-plancha-autorrevision.md`. Los dos hallazgos
  medios del pase final se corrigieron; este pase no es aprobación independiente.
- Guion de lectura UAT en `docs/uat/log3-metros-plancha.md`.

Commits locales de esta rama, en orden: `6c62f55` (cálculo y vistas), `6c0bba9` (pruebas),
`0d5da77` (restaurar ventas para aislar `readiness`) y `2346bd8` (filtro de vigentes y caso
de 200 reversas). El cierre documental se registra con `docs(log3): registrar decisión,
revisión y QA`.

## 3. Decisiones tomadas

- **D-366** — limitar LOG-3 a metros visibles en pedido y planta. Una comparación correcta de
  `readiness` necesita definir ambas magnitudes en la misma unidad y queda para otra decisión.

## 4. Bloqueos / pendientes

- Autorizar por comando exacto D-251 el push de la rama de trabajo; abrir PR y verificar su CI.
- El dueño cierra la revisión de la entrega antes de una ventana de despliegue. No hay deploy
  autorizado en esta sesión.
- El plan cero del accesorio MTR en el listado y las unidades heredadas de `readiness` son
  comportamientos previos a esta entrega, fuera de D-366.

## 5. Cómo verificar

```text
pnpm lint
pnpm typecheck
pnpm --filter @ayr/api exec jest --runInBand
pnpm --filter @ayr/web test
pnpm build
node scripts/e2e-latency.mjs --worktree . --out local-data/log3/qa-final.jsonl
```

Resultados hasta aquí: lint, typecheck y build verdes; API 160/160 suites y 1 975/1 975
unitarios; web 15/15 archivos y 89/89 unitarios, todos tras el último ajuste.
La prueba focalizada del ajuste final pasó 4/4. La suite E2E de 464 casos terminó en 131,3 min:
**452 passed, 10 failed, 2 skipped**. Una invocación inicial de Jest
con opciones pasadas a pnpm falló antes de ejecutar tests (infraestructura de comando); se
repitió con `exec jest`. El primer intento E2E se interrumpió tras 30 casos verdes para incluir
la corrección de los hallazgos de autorrevisión en un build nuevo.
Varios casos de comprobantes y guías fallaron en el pase E2E porque la API local tiene
`PSE_ENABLED` apagado: uno esperaba un mensaje de rechazo distinto y los demás intentaban
emitir. Son **8 fallos** de configuración/prueba ajenos a LOG-3; no se activó el PSE para evitarlos.
Los otros **2 fallos** requieren R2: `fase5a.spec.ts` exige un PDF archivado y `fase2a.spec.ts`
guarda el XML antes del preview. La repetición aislada de RF-11 falló 1/1 con el mismo build;
la traza mostró `POST /api/purchases/xml/preview` → 503, y el servicio llama a
`StorageService.putObject` antes de responder. La CI sí recibe sus variables de R2. Se
clasifican como infraestructura local; no se configuró almacenamiento externo para esta suite.

## 6. Siguiente sesión

No hay otra tarea autorizada después de LOG-3. El dueño decide la revisión final y cualquier
ventana posterior; no correr `e2e:prod` con datos reales.
