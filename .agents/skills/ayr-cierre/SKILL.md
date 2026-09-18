---
name: ayr-cierre
description: 'Cierra una sesión de AYR Steel ERP después de revisión y QA: consolida decisiones, progreso, UAT, handoff y commits locales sin push. Usar cuando el alcance implementado ya está listo para entregar al dueño.'
---

# Cierre de sesión AYR

1. Confirma que terminó el alcance aprobado y que los milestones sacrificados quedaron
   explícitos. No incorpores tareas nuevas durante el cierre.
2. Exige revisión independiente mediante `$ayr-revisor`: el autor no firma su propio trabajo.
   Corrige o documenta cada hallazgo antes de continuar.
3. Ejecuta `$ayr-qa` en proporción al cambio. Siempre lint, typecheck y unitarios. La suite E2E
   completa con builds de producción es obligatoria cuando se tocó aplicación o flujo; si el
   cambio es solo docs/infraestructura de agentes, registra por qué no aplica.
4. Actualiza, en este orden:
   - `docs/ARQUITECTURA.md` §0.2 para decisiones nuevas `D-nnn`;
   - `docs/DECISIONES.md` si una decisión requiere contexto largo;
   - `docs/PROGRESO.md` con estado, pruebas, métricas y bloqueos;
   - `docs/uat/<sesion>.md` cuando haya UI o flujo de negocio;
   - `$ayr-handoff` para `docs/handoff/<sesion>.md`.
5. Revisa `git status`, el diff final y los archivos ignorados relevantes. No dejes procesos ni
   worktrees auxiliares colgados.
6. Crea commits pequeños y temáticos, conventional commits en español. Puedes empujar la rama de
   trabajo y abrir su PR. Nunca uses `gh repo sync` ni borres ramas protegidas.
7. Empuja la rama de trabajo y entrega la lista de commits y el estado de CI. Antes de cualquier
   push o merge a `main`, presenta el resumen de D-232 y espera el OK explícito del dueño; solo
   entonces usa `AYR_OWNER_PUSH=1`. Verifica CI antes de declarar cierre definitivo.

Fuentes: protocolo de cierre de `AGENTS.md` §5 y `$ayr-handoff`. No existe un
comando `/goal` versionado; no se inventa uno.
