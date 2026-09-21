# Handoff — RF-S3b

## Cierre posterior al merge (2026-09-20)

RF-S3b fue entregada mediante PR #6 a `main` con merge commit `fb443a5`, tras OK explícito del
dueño conforme a D-232 y usando `AYR_OWNER_PUSH=1`. La CI del PR en `9a78bb2` quedó verde en
lint/typecheck/unit, análisis estático, E2E completo y smoke Neon. Los 7 rojos previos fueron
defectos de prueba corregidos; agy revisó de forma independiente sin hallazgos bloqueantes,
altos ni medios (dejó dos notas bajas).

Todo worktree nuevo se registra en agy con `agy --new-project` desde su raíz antes de empezar a
trabajar. La CI no corre en pushes a ramas de trabajo: corre en pushes a `main` y en PRs hacia
`main`; abrir el PR temprano es la vía para obtener el veredicto sin depender del entorno local.

Tras el merge, la CI de `main` se lanzó desde `fb443a5`; queda pendiente confirmar su resultado
antes del cierre final. El worktree y la rama local se retiran después de esa confirmación; la
rama remota `rf-s3b` queda para borrado por el dueño.

Este apartado supersede los pendientes historicos de las secciones siguientes.

## 1. Resumen

Los cinco milestones funcionales están implementados en el worktree `rf-s3b`, sin migraciones
ni operaciones sobre entornos. El cierre está bloqueado: Antigravity auto-denegó el permiso de
lectura en tres intentos y otro proyecto ocupa el puerto 3000 para la repetición E2E limpia.

## 2. Hecho

- D-237: kardex individual completo y ascendente; listado mezclado reciente y paginado.
- `/planta` agrupa el historial por pedido con OP internas y conserva `/produccion/:id`.
- Selectores con fila clicable, teclado, documento visible, `Elegir` permanente y sin overflow.
- Retiradas las dos entradas de alta de producto: formulario de venta e importador; el alta de
  cliente permanece.
- `ProductDialog` adaptado y medido en cinco líneas de negocio y dos resoluciones.

## 3. Decisiones tomadas

- **D-237** — el historial individual no pagina y se lee ascendente; la bandeja mezclada no cambia.

## 4. Bloqueos / pendientes

- Revisión independiente obligatoria: `agy` falló tres veces porque el modo headless auto-deniega
  `command`/`escalate_admin`. Falta confiar este worktree y permitir lectura del diff.
- Repetir Fase 2b, Fase 7 consolidada y el detector de overflow cuando el puerto 3000 quede libre.
- Sin revisión independiente ni QA E2E limpio no corresponde commit, push ni declaración de cierre.

## 5. Cómo verificar

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
node scripts/e2e-latency.mjs --worktree . --out local-data/rf-s3b/recheck.jsonl --proxy-port 5434 -- e2e/tests/fase2b.spec.ts e2e/tests/fase7-consolidada.spec.ts e2e/tests/layout-scroll-horizontal-d179.spec.ts
```

Resultados confirmados: lint y typecheck verdes; 626 unitarios verdes; build de producción
verde. Los E2E afectados dieron 7 verdes y 3 rojos de prueba, corregidos en una repetición de
4/4 verdes. La suite completa alcanzó 254/375 antes de colapsar el entorno; sus fallos previos
detectaron expectativas antiguas de orden del kardex y se corrigieron, pero falta revalidarlas.

## 6. Siguiente sesión

Resolver el permiso de lectura de `agy`, ejecutar el pase independiente y repetir los E2E
pendientes; solo entonces completar cierre, commits y push de `rf-s3b`.
