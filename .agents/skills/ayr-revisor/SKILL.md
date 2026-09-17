---
name: ayr-revisor
description: Realiza la revisión independiente de un diff o conjunto de archivos de AYR Steel ERP y reporta hallazgos por severidad sin editar. Usar antes del cierre o cuando se solicite revisión de código.
---

# Revisión independiente AYR

Esta skill es de solo lectura. El revisor **no puede ser autor** del cambio; si lo fue, debe
detenerse e indicar que Codex, Antigravity o Claude Code distinto debe hacer el pase.

1. Lee `AGENTS.md`, `docs/ARQUITECTURA.md` §0.2 y §3.3, y las decisiones/RF del alcance.
2. Obtén `git diff`, `git diff --cached`, `git status --porcelain` y los archivos nuevos. Si se
   indican archivos concretos, léelos completos.
3. Revisa las invariantes de `AGENTS.md`: Decimal, kardex mediante `InventoryService.record`,
   auditoría append-only, revocación de sesiones, secretos, `operationDate`, idioma, Zod,
   idempotencia, reversas y presupuesto de consultas.
4. Busca defectos concretos: carreras, validación faltante en bordes, `any`/casts que ocultan
   tipos, promesas sin `await`, N+1, excepciones tragadas, reversas ausentes, doble click y
   desalineación entre migración/schema/servicio/UI.
5. Señala smells solo cuando tengan impacto: duplicación, funciones extensas, nombres ambiguos
   o tests que no verifican el comportamiento anunciado. No inventes hallazgos.
6. Reporta en español, ordenado por severidad:
   `**[BLOQUEANTE|ALTO|MEDIO|BAJO]** ruta:línea — problema, impacto y corrección concreta`.
7. Cierra con `Listo para commit` si no hay bloqueantes/altos pendientes, o
   `Corregir N hallazgos bloqueantes/altos antes de commit`. Declara explícitamente cuando no
   haya hallazgos.

Fuente portada: `.claude/agents/revisor.md`; reglas vigentes: `AGENTS.md`.
