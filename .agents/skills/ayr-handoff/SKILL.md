---
name: ayr-handoff
description: Escribe el handoff canónico de una sesión AYR para transferir estado entre agentes o al dueño. Usar al cerrar una sesión, cambiar de agente o dejar trabajo pendiente verificable.
---

# Handoff AYR

1. Lee `git status --porcelain`, `git log --oneline -10`, `docs/PROGRESO.md`, las decisiones
   nuevas de `docs/ARQUITECTURA.md` §0.2 y handoffs recientes comparables.
2. Usa `docs/handoff/_plantilla.md`. Escribe `docs/handoff/<sesion>.md` en español y sin
   secretos, con estas secciones obligatorias:
   1. **Resumen**: fase/sesión, entrega y estado de CI/entorno.
   2. **Hecho**: alcance completado, por milestone, con archivos clave.
   3. **Decisiones tomadas**: cada `D-nnn` nueva y su efecto.
   4. **Bloqueos / pendientes**: causa, alcance no completado y acción humana necesaria.
   5. **Cómo verificar**: comandos exactos, resultados esperados y URLs cuando apliquen.
   6. **Siguiente sesión**: primera tarea concreta autorizada; no inventar ni encadenar alcance.
3. Incluye pruebas ejecutadas con conteos y clasificación de rojos, commits locales y comando de
   push del dueño cuando corresponda.
4. Actualiza `docs/PROGRESO.md` si el estado cambió y muestra el contenido final al dueño.

Fuentes: `.claude/commands/handoff.md` y handoffs existentes en `docs/handoff/`.
