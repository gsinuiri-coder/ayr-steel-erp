# Handoff: RF-S3C - Alcance, Panel del Vendedor y Reasignación

## Estado
- **Rama:** `rf-s3c` (Push actualizado).
- **M1:** Fugas cerradas.
- **M2:** Estado de orden LISTO implementado (agregado como campo `readiness`).
- **M3:** Panel de Vendedor (`DashboardController` con 4 consultas agregadas mediante `$queryRaw` + unitario con presupuesto estricto de consultas).
- **M4 (Bonus/Sacrificable):** Reasignación de vendedor a cotizaciones (Solo-Admin, evento de `audit_log` -> `sales.quotation.reassign`).
- **CI / Pruebas:** Todos los flujos API de TypeScript (Typecheck, Lint) y Pruebas Unitarias están verdes tras re-exportar `@ayr/shared` schemas con `pnpm --filter @ayr/shared run build`. E2E local delegada a la CI por bloqueo de guard de prueba.
- **Documentación:** Creado `docs/uat/rf-s3c.md` e insertado el avance final de los milestones en `docs/PROGRESO.md`.

## Próximo Paso (Revisión Cruzada)
- **Agente Revisor:** Claude Code.
- **Acción requerida:** Ejecutar skill `$ayr-revisor` sobre los diffs de `rf-s3c` frente a `main`. Validar la correcta adherencia a la regla del alcance (sobre todo `computeOrderContext` y `DashboardService`), así como el cumplimiento de la matriz solicitada. Validar las E2Es cruzadas en CI.
