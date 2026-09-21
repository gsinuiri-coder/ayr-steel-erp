---
name: ayr-arranque
description: 'Inicia una sesión o ventana de AYR Steel ERP: valida rama, CI y contexto, reporta el estado entendido y propone milestones antes de implementar. Usar al comenzar cualquier tarea de código, infraestructura o deploy del repo.'
---

# Arranque AYR

0. **Antes de empezar a trabajar en un worktree nuevo**, regístralo desde su raíz en Antigravity con `agy --new-project`. Esto debe ocurrir al inicio, no al cierre: sin ese registro la revisión cruzada puede auto-denegar la lectura del proyecto.

1. Lee `AGENTS.md` completo. Sus reglas prevalecen sobre documentación histórica.
2. Sin modificar archivos, ejecuta `git fetch`, confirma que la rama/worktree de la tarea parte
   del `origin/main` vigente y consulta `gh run list --branch main --limit 3`. No abras ni uses
   el worktree de otra sesión.
3. Lee `docs/PROGRESO.md`, `docs/ARQUITECTURA.md` §0.2, el último handoff según la historia de
   Git y las fuentes adicionales que `AGENTS.md` exige para el alcance.
4. Reporta al dueño:
   - rama, worktree, SHA y estado de CI;
   - estado funcional entendido, decisiones aplicables, deudas y bloqueos;
   - contradicciones entre el brief y el repo;
   - plan ordenado por milestones, marcando cuáles son sacrificables desde el final.
5. Ante ambigüedad de alcance o política, aplica D-230: presenta recomendación y espera decisión.
6. **No escribas código ni docs hasta recibir el OK explícito del dueño al plan.** El `git fetch`
   y las inspecciones de solo lectura no cuentan como implementación.

Fuentes: `AGENTS.md` §§2, 4 y 5; `docs/ARQUITECTURA.md` §0.2; `docs/PROGRESO.md`.
