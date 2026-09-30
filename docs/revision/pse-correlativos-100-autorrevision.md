# Autorrevisión — D-365, gate PSE

Pase de un subagente nuevo que no escribió el cambio ni leyó el handoff de implementación.
Es una lista de riesgos del mismo modelo, no una aprobación cruzada. Alcance: diff de
`fix/pse-correlativos-100` frente a `origin/main`.

- P1: una cuenta PSE distinta podía heredar los correlativos locales. Corregido con huella
  SHA-256 de URL y token, sin guardar el token.
- P2: el offset para PSE debía quedar aislado de la suite E2E común y de datos reales.
  Verificado con la rama explícita `E2E_PSE`, guardas de base de test y configuración forzada a
  Docker local.
- P1 del pase final: el gate aceptaba cualquier cuenta configurada en `apps/api/.env` y, sin
  huella previa, podía emitir contra una cuenta real. Corregido: exige coincidencia exacta de
  URL y token con `NUBEFACT_DEMO_URL`/`NUBEFACT_DEMO_TOKEN` de `.env.setup` antes de reservar
  correlativos. Prueba de rechazo añadida; `pnpm test:scripts` pasó 47/47.
- Riesgo abierto para revisión del dueño: `BC01` permanece inactiva en este gate hasta conocer
  su último correlativo y contar con una boleta aceptada para la nota de crédito.

No se identificó un P0 restante. El P1 final quedó corregido; la revisión del dueño cierra la entrega.
