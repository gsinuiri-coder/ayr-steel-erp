# Handoff — CHORE-AGENTS: infraestructura compartida de agentes

## 1. Resumen

La rama `chore/agents` deja a Codex como agente principal, Antigravity como segundo
implementador/revisor y Claude Code en solo lectura. Las reglas y seis procedimientos quedan
versionados y se verificaron con los binarios instalados. Todo está listo para push del dueño;
no se tocó aplicación, datos, deploy ni el worktree `rf-s3`.

## 2. Hecho

- `AGENTS.md` quedó como fuente canónica fusionada; `CLAUDE.md`, `GEMINI.md` y
  `.agents/rules/00-ayr.md` son adaptadores sin reglas divergentes.
- Se portaron las seis skills en `.agents/skills/`: arranque, revisión, QA, cierre, handoff y
  ventana. Se documentó invocación automática o explícita con `$ayr-*`; M3 de custom prompts se
  descartó por decisión del dueño.
- `scripts/setup-agentes.mjs` y `pnpm setup:agentes` configuran de forma idempotente
  `core.hooksPath`, el worktree y las skills de Antigravity, preservando configuración ajena.
- `.githooks/pre-push` bloquea pushes de agentes salvo `AYR_OWNER_PUSH=1`.
- Claude Code quedó restringido a lectura; conserva comandos de diagnóstico y niega edición,
  mutaciones Git/GitHub, intérpretes, gestores de paquetes y CLIs de infraestructura.
- Se añadió la plantilla vigente `docs/handoff/_plantilla.md` y la guía
  `docs/agentes/README.md` con perfiles de Codex y las particularidades verificadas de
  Antigravity 1.2.5.

## 3. Decisiones tomadas

- **D-230** — Toda ambigüedad de alcance o política obliga a detenerse, presentar recomendación
  y esperar decisión del dueño. Sustituye la autorización histórica de aplicar la recomendación
  sin preguntar; evita decisiones silenciosas con varios agentes escritores.

## 4. Bloqueos / pendientes

- Ningún bloqueo de producto o infraestructura.
- Tras clonar o crear un worktree nuevo, ejecutar `pnpm setup:agentes` y abrir la primera sesión
  de Antigravity desde la raíz con `agy --new-project`.
- Claude Code muestra que `Edit(**)` es la regla que cubre Write/Edit/NotebookEdit en 2.1.274;
  no volver a introducir las formas inválidas `Write(**)` o `NotebookEdit(**)`.
- E2E completa quedó omitida deliberadamente porque esta sesión no tocó aplicación ni flujo.

## 5. Cómo verificar

```bash
pnpm setup:agentes
git config --local --get core.hooksPath
git push --dry-run origin HEAD:refs/heads/chore-agents-hook-test

codex exec --ephemeral -s read-only -c 'approval_policy="never"' \
  '$ayr-arranque Indica la primera fuente que debes leer y no escribas archivos.'
agy --new-project

pnpm lint
pnpm typecheck
pnpm test
```

Resultados de esta sesión: lint y typecheck verdes; 589 unitarios passed, 0 failed, 0 skipped.
El hook abortó el dry-run antes de contactar al remoto. Antigravity reconoció `AGENTS.md` y las
seis skills. Claude devolvió `permission_denials` para `Write` y no creó el probe.

## 6. Siguiente sesión

El dueño empuja `chore/agents` y verifica CI. No hay otra tarea autorizada ni se encadena una
ventana de producto desde este handoff.
