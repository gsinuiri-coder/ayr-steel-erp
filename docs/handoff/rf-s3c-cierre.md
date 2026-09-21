# Handoff: RF-S3C - Alcance, Panel del Vendedor y Reasignación

## Estado
- **Rama:** f-s3c (Push a PR #7)
- **M1:** Fugas cerradas, indLinesWithoutOrder testeada con alcance en E2E y E2E de UI de Vendedor para abrir catálogo en cotización (no ve rentabilidad).
- **M2:** Expuesto estado derivado LISTO, LISTO_CON_FALTANTE, EN_PRODUCCION en detalle y listado de pedidos, con casos de bordes testeados en order-readiness.spec.ts.
- **M3:** Panel de Vendedor Web (SellerDashboardCards) renderizado con métricas parametrizadas seguras mediante $queryRaw. Testeado en Playwright UI para asegurar ocultamiento de cards de admin.
- **M4:** Reasignación de vendedor a cotizaciones (Solo-Admin, validación de que Vendedor Destino exista, esté activo y sea VENDEDOR con test propio).
- **Documentación:** Creado docs/uat/rf-s3c.md, añadido S3c Checklist en docs/ENTORNOS.md, agregadas D-238 (cambio de roles) y D-239 en docs/ARQUITECTURA.md, y reporte actualizado en docs/PROGRESO.md.

## Próximo Paso (Revisión Cruzada)
- **Agente Revisor:** Codex CLI (ahora secundario tras D-238).
- **Acción requerida:** Validar E2E y Smoke en CI en el PR #7. Si está verde, se cierra la ventana.
