# Handoff — Limpieza de residuos y coherencia del repo (2026-09-23)

## 1. Resumen

Sesión de housekeeping tras quedar Claude Code como único agente, corrida directo sobre `main`
por instrucción explícita del dueño (no una ventana `RF-Sn`). Inventario completo antes de
cualquier borrado, OK del dueño ítem por ítem, `main` local realineado con `origin/main` y
`AGENTS.md` §2 actualizado al esquema de un solo agente. `origin/main` está en `fc5fc31` (el
dueño ya empujó hasta ahí); queda 1 commit local sin push (`a7617e7`, AGENTS.md §2).

## 2. Hecho

- **Inventario (PASO 1)**: worktrees, ramas locales/remotas (mergeadas vs. con trabajo vivo),
  archivos/directorios sueltos, procesos en puertos del proyecto (ninguno activo), contenido de
  `local-data/`, referencias a Codex/Antigravity dentro y fuera del repo. Sin borrados hasta
  completarlo.
- **`acc-demo` descartado** (decisión del dueño, prototipo de accesorios rechazado en demo al
  cliente): worktree, rama local y `origin/acc-demo` eliminados. Antes de borrar: los 9 commits
  listados con su decisión D asociada, y verificada — sin escritura — la colisión de numeración
  D-242/D-248 entre `acc-demo` y las ramas vivas (`docs/ventana-rf-s4a`/`hotfix-d249`); no llega
  a materializarse en ningún log compartido porque `acc-demo` nunca se mergeó. Registrado en
  `docs/PROGRESO.md` con el hash de la punta descartada, recuperable si hiciera falta.
- **`main` local realineado con `origin/main`**: tenía 3 commits propios sin push y 18 de
  retraso (RF-S4a, HOTFIX kg teórico). Rebase con 2 conflictos —ambos "las dos ramas agregaron
  su sección en el mismo punto", nunca contenido superpuesto— resueltos conservando ambas
  historias en orden cronológico.
- **16 borrados aprobados ítem por ítem** (detalle completo en `docs/PROGRESO.md`, sección
  "Limpieza de residuos y coherencia del repo"): 4 ramas ya mergeadas + 1 backup pre-rebase
  local, `.playwright-mcp/` y `.worktrees/` (residuo/vacío), 2 scripts one-off sin borrar al
  cierre de su sesión en `apps/api/prisma/` (duplicados por sus equivalentes en
  `scripts/oneoff/`, que se conservan), 3 scripts de `scripts/oneoff/` atados a una ventana ya
  cerrada, y residuo de diagnóstico en `local-data/` (`r1/`, `v4prep/`, snapshots vacíos, salidas
  sueltas de Playwright). Los `.xlsx`/`.json` de cargas ya ejecutadas en `local-data/` se
  conservaron a pedido del dueño, como rastro de auditoría.
- **`pnpm install` + lint/typecheck verdes**: el rebase trajo `vitest` (D-226) que este
  worktree nunca había instalado; `pnpm install` (+31 paquetes) resolvió los 108 errores de
  ESLint que eso causaba. No fue un defecto de la limpieza, sino una consecuencia esperable de
  ponerse al día con 18 commits de una sola vez.
- **`AGENTS.md` §2 reescrita** al esquema de un solo agente (Claude Code; Codex/Antigravity
  fuera), con subagentes internos y una regla de revisión nueva: sin segundo agente, el pase se
  hace con un subagente que no leyó el handoff de implementación, marcado como autorrevisión sin
  valor de pase cruzado, y registrado en `PROGRESO.md` como PENDIENTE DE REVISIÓN
  INDEPENDIENTE. Numeración de la lista (1-6) preservada para no romper la referencia "§2.2" que
  ya usa D-248 en `docs/ventana-rf-s4a`.
- Quitado el paso `agy --new-project` de `.agents/skills/ayr-arranque/SKILL.md:8`.
- Registradas en `docs/PROGRESO.md` las tres piezas hoy en autorrevisión sin pase cruzado:
  RF-S4a, HOTFIX D-249 y el propio cambio de `AGENTS.md` §2.

## 3. Decisiones tomadas

Ninguna decisión `D-nnn` nueva: todo lo de esta sesión fue ejecución de instrucciones directas
del dueño (descarte de `acc-demo`, resolución del rebase, contenido exacto del diff de
`AGENTS.md` §2), no una recomendación del agente sobre una ambigüedad abierta.

## 4. Bloqueos / pendientes

- **PASO 2 del brief original, incompleto a propósito**: `docs/agentes/README.md` (hoy es
  enteramente instalación/perfiles de Codex y Antigravity) y las dos menciones a `agy`/Codex en
  `.agents/skills/ayr-revisor/SKILL.md:8-9` quedan para otra sesión — decisión del dueño, no
  bloquean nada y el README sirve de registro histórico.
- **`docs/ENTORNOS.md`** no tiene pasos dependientes de Codex/Antigravity (verificado, sin
  hallazgos).
- **Fuera del repo, solo listado, sin tocar**: `~/.codex/ayr-deep.config.toml`,
  `~/.codex/ayr-grind.config.toml`, `~/.codex/ayr-ventana.config.toml`,
  `~/AppData/Local/agy/` — son de otra herramienta, no de este repo.
- **`a7617e7` sin push**: comando exacto abajo.
- **Tres piezas en autorrevisión sin pase cruzado** (RF-S4a, HOTFIX D-249, este cambio de
  `AGENTS.md` §2), registradas en `docs/PROGRESO.md`, a recuperar cuando haya un segundo
  revisor disponible.
- **No propuesto para borrar** (a criterio del dueño si quiere que se revise igual): los
  `.xlsx`/`.json` de `local-data/` de cargas ya ejecutadas.

## 5. Cómo verificar

```bash
git status                       # limpio
git worktree list                # solo main, hotfix-d249 (intocable), docs/ventana-rf-s4a (intocable)
git log origin/main..main --oneline   # 1 commit: a7617e7
pnpm exec turbo run lint --force      # verde, 4/4
pnpm exec turbo run typecheck --force # verde, 4/4
```

Push pendiente, a cargo del dueño (D-232):

```bash
git push origin main
```

## 6. Siguiente sesión

Primera tarea concreta ya autorizada, si el dueño la retoma: `docs/agentes/README.md` y
`.agents/skills/ayr-revisor/SKILL.md:8-9` al esquema de un solo agente (mismo criterio que
`AGENTS.md` §2 de esta sesión). No encadenar alcance nuevo sin decisión del dueño.
