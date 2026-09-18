# Handoff — CHORE-AGENTS: política de push y esquema de dos agentes

## 1. Resumen

`chore/agents` quedó mergeada en `main` mediante el PR #4 como `ffe4cee`, después del resumen
de D-232 y del OK explícito del dueño. Reduce el esquema a Codex y Antigravity (D-233) y retira
los adaptadores de Claude Code. Solo cambió documentación y configuración de agentes: no tocó
rutas de runtime, datos, infraestructura desplegada ni producción. La CI del PR y la de `main`
quedaron verdes.

## 2. Hecho

- `AGENTS.md` permite push de ramas de trabajo y exige resumen + OK explícito del dueño antes de
  cualquier push o merge a `main`; `gh repo sync` y borrar ramas protegidas siguen prohibidos.
- `.githooks/pre-push` inspecciona cada ref remoto, permite ramas de trabajo y bloquea
  `refs/heads/main` salvo `AYR_OWNER_PUSH=1`.
- Se eliminaron `CLAUDE.md` y `.claude/`. La revisión previa confirmó que `CLAUDE.md` solo
  importaba `AGENTS.md` y definía el rol: no había una regla técnica exclusiva que migrar.
- `AGENTS.md` §2 queda con Codex principal y `agy` segundo implementador. `ayr-revisor` fija la
  revisión cruzada Codex → `agy` y `agy` → Codex; nadie firma su propio cambio.
- Se actualizaron `ayr-cierre`, `ayr-handoff`, `ayr-qa` y `docs/agentes/README.md` para no dejar
  fuentes eliminadas ni una política de push obsoleta.
- PR #4 mergeado con `AYR_OWNER_PUSH=1` únicamente después del OK del dueño. CI del PR:
  <https://github.com/gsinuiri-coder/ayr-steel-erp/actions/runs/35300213796>. CI de `main`:
  <https://github.com/gsinuiri-coder/ayr-steel-erp/actions/runs/35301808282>.
- `rf-s3` se rebasó de nuevo sobre el `main` resultante, conservando D-228, D-229, D-232 y
  D-233. Su PR #3 sigue reservado para una ventana de deploy; no se mergea suelto.

## 3. Decisiones tomadas

- **D-232** — Un agente solo puede empujar o mergear `main` después de presentar commits, CI,
  despliegue y riesgo, y recibir el OK explícito del dueño en la sesión; sustituye D-231.
- **D-233** — Quedan dos agentes: Codex y Antigravity, con revisión recíproca obligatoria.

## 4. Bloqueos / pendientes

- **Revisión independiente pendiente.** Tres intentos con `agy` 1.2.5 en modo plan/sandbox
  fallaron porque no pudo escribir su estado bajo `~/.gemini` y el modo headless denegó el
  permiso de comando. Corregir los permisos de `~/.gemini` o repetir el pase en un entorno que
  pueda escribir allí; no usar `--dangerously-skip-permissions` para desbloquearlo.
- Los unitarios web locales quedaron bloqueados por `spawn EPERM`; CI Linux es la evidencia.
- E2E completa no aplica porque el diff es exclusivamente docs/configuración de agentes.

## 5. Cómo verificar

```powershell
git push --dry-run origin HEAD:main
$env:AYR_OWNER_PUSH='1'; git push --dry-run origin HEAD:main; Remove-Item Env:AYR_OWNER_PUSH
```

El dueño ejecutó la verificación fuera del sandbox: sin la variable el hook bloqueó `main`, una
rama de trabajo pasó y `AYR_OWNER_PUSH=1` permitió el bypass. Ningún dry-run publicó cambios.

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

Resultados locales: format, lint y typecheck verdes; API 581 passed / 0 failed / 0 skipped.
Web: pendiente de CI por la restricción de procesos hijos del sandbox.

## 6. Siguiente sesión

Ventana de deploy de RF-S3: conservar el orden migraciones si aplicaran → API → merge/publicación
web, y ejecutar el UAT de `docs/uat/rf-s3.md` en demo. Antes, queda pendiente el pase cruzado de
`agy`, corrigiendo los permisos de `~/.gemini` sin desactivar el sandbox.
