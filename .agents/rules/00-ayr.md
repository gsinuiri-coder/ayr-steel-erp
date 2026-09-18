---
trigger: always_on
---

# Reglas canónicas AYR

Lee y aplica el `AGENTS.md` de la raíz del repositorio antes de actuar. Es la fuente canónica
para roles, permisos, seguridad, dominio, ciclo de sesión y cierre; este archivo no duplica esas
reglas. Las skills compartidas viven en `.agents/skills/` y se cargan solo cuando su descripción
o una invocación explícita `$ayr-*` corresponda a la tarea.

`GEMINI.md` es solo un adaptador de compatibilidad que importa `AGENTS.md`; nunca lo sustituye
ni sobreescribe.
