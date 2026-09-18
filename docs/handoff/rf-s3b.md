# Handoff — RF-S3b

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
