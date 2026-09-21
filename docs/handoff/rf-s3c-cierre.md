# Handoff: RF-S3C - Alcance, Panel del Vendedor y Reasignación

## Estado

- **Rama:** `rf-s3c` (PR #7)
- **M1:** Fugas cerradas. `assertSellerAccess` filtra SOLO si el actor es VENDEDOR (no bloquea SUPERVISOR_PLANTA). Ownership en quotations usa `sellerId` (no `createdById`). Ownership en invoicing usa `salesOrder?.sellerId ?? dispatch?.salesOrder?.sellerId ?? createdById`.
- **M2:** Estado derivado (LISTO, LISTO_CON_FALTANTE, EN_PRODUCCION, SIN_PRODUCCION) expuesto en detalle y listado, con bordes testeados.
- **M3:** Panel de Vendedor (`DashboardController` con 4 consultas `$queryRaw` parametrizadas). Cards de admin (stock-shortages, price-floor-summary, receivables) protegidas con `@Roles(ADMINISTRADOR)`.
- **M4:** Reasignación de vendedor (Solo-Admin, validación destino existe + activo + VENDEDOR).
- **Invoicing:** `addPayment` verifica seller scope del comprobante. `receivables` y `receivables/summary` son `@Roles(ADMINISTRADOR)` — CxC por vendedor va en RF-S4.
- **CI:** Pendiente CI verde tras último push.
- **Documentación:** D-238 corregida (Claude Code es revisor, no Codex). D-239 con `$queryRaw`.

## Próximo Paso

- **Agente Revisor:** Claude Code.
- **Acción requerida:** Verificar CI verde del PR #7 (E2E + smoke con números).
