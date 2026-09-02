---
description: Cierra la sesión: escribe docs/handoff/<nombre>.md con estado, decisiones, bloqueos y siguientes pasos.
argument-hint: <nombre-del-archivo-sin-extension>
---

Genera el resumen de cierre de sesión en `docs/handoff/$ARGUMENTS.md` (si no se da nombre, usa `sesion-<fecha ISO>`).

Antes de escribir, verifica: `git status --porcelain`, `git log --oneline -10`, `docs/PROGRESO.md` y las decisiones nuevas en `docs/ARQUITECTURA.md` §0.2.

Estructura del archivo (en español, conciso, sin secretos):

1. **Resumen** — 3 líneas: qué fase, qué se entregó, estado de CI/prod.
2. **Hecho** — lista por punto del alcance con enlace a archivos clave.
3. **Decisiones tomadas** — IDs D-nnn nuevos y una línea cada uno.
4. **Bloqueos / pendientes** — qué no se pudo cerrar, por qué, y qué acción humana (si alguna) se requiere.
5. **Cómo verificar** — comandos exactos (pnpm/gh/gcloud/vercel) y URLs de prod.
6. **Siguiente sesión** — primera tarea concreta de la fase siguiente según `docs/ARQUITECTURA.md` §3.7.

Después de escribir el archivo, actualiza `docs/PROGRESO.md` si algo cambió y muestra el contenido del handoff en el chat.
