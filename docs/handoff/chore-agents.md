# Handoff — CHORE-AGENTS: política de push y esquema de dos agentes

## 1. Resumen

`chore/agents` deja activa D-232, reduce el esquema a Codex y Antigravity (D-233) y retira los
adaptadores de Claude Code. Solo cambia documentación y configuración de agentes: no toca rutas
de runtime, datos, infraestructura desplegada ni producción. La CI del PR es el gate de merge.

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

## 3. Decisiones tomadas

- **D-232** — Un agente solo puede empujar o mergear `main` después de presentar commits, CI,
  despliegue y riesgo, y recibir el OK explícito del dueño en la sesión; sustituye D-231.
- **D-233** — Quedan dos agentes: Codex y Antigravity, con revisión recíproca obligatoria.

## 4. Bloqueos / pendientes

- **Hook sin verificación ejecutable dentro del sandbox.** `sh.exe` está bloqueado. El dueño
  debe ejecutar fuera del sandbox los dos dry-runs de la sección siguiente; no se declara verde.
- **Revisión independiente pendiente.** Tres intentos con `agy` 1.2.5 en modo plan/sandbox
  fallaron porque no pudo escribir su estado bajo `~/.gemini` y el modo headless denegó el
  permiso de comando. Repetir el pase fuera del sandbox; no se abrió el aislamiento con
  `--dangerously-skip-permissions`.
- Los unitarios web locales quedaron bloqueados por `spawn EPERM`; CI Linux es la evidencia.
- E2E completa no aplica porque el diff es exclusivamente docs/configuración de agentes.

## 5. Cómo verificar

```powershell
git push --dry-run origin HEAD:main
$env:AYR_OWNER_PUSH='1'; git push --dry-run origin HEAD:main; Remove-Item Env:AYR_OWNER_PUSH
```

El primer comando debe imprimir el bloqueo AYR; el segundo debe llegar al dry-run de Git sin ese
mensaje. Ninguno publica por `--dry-run`.

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

Resultados locales: format, lint y typecheck verdes; API 581 passed / 0 failed / 0 skipped.
Web: pendiente de CI por la restricción de procesos hijos del sandbox.

## 6. Siguiente sesión

Esperar la CI del PR de `chore/agents`, presentar al dueño el resumen de D-232 y detenerse. Solo
con su OK explícito se mergea a `main`; después se confirma la CI de `main`.
