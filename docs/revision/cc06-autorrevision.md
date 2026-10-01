# Autorrevisión — cc06 (M0, M1, M2)

- **Fecha:** 2026-10-01
- **Rama:** `feat/cc06-ui` contra `origin/main` (`a1fa929`), commits `5b4dbe5`, `66f2728`, `5ba4898`
- **Revisor:** subagente nuevo que no leyó el handoff de implementación (criterio de D-248).
  **Es una autorrevisión: lista de riesgos, no una aprobación** ni un pase cruzado.
- **Alcance:** solo lectura (git, grep, código); no corrió tests ni nada contra bases.

## Hallazgos

| #   | Sev. | Hallazgo                                                                                                                                                                 | Resolución                                                                                                  |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 1   | P0   | Accesorios (y reportes con `meters_m` sin largos) con teórico 0 en el reporte y en la rentabilidad por comprobante. Mismo hallazgo que el P1 n.º 1 del segundo modelo.   | **Corregido** (precedencia `meters_m` → largos; E2E de accesorio).                                          |
| 2   | P1   | `receive` con la foto vieja de las líneas frente a una corrección D-371 concurrente.                                                                                     | **Corregido** (relectura dentro de la transacción; test unitario).                                          |
| 3   | P1   | La revalidación de D-368 no frena dos `confirm` simultáneos; el comentario prometía más de lo que hacía.                                                                 | **Corregido** (advisory lock por N° de comprobante; el test fija que se toma).                              |
| 4   | P2   | Tasa de IGV implícita con líneas chicas (0.10 con IGV 0.02 = 20 %).                                                                                                      | **Corregido** (ajuste a 18/0 a ±0,1 puntos o rechazo).                                                      |
| 5   | P2   | Guardar sin cambios recalculaba `qty × precio` y pisaba el importe del papel de una línea importada (D-359), con una auditoría casi vacía.                               | **Corregido** en API (no-op sin cambios, test) y en web («Guardar» deshabilitado sin cambios).              |
| 6   | P2   | La foto de duplicados contaba re-cotizaciones (anulada + viva).                                                                                                          | **Corregido** (dos o más no anuladas).                                                                      |
| 7   | P2   | Una marca con `\r\n` o espacio tras el número no coincide con la regla exacta, aunque `externalInvoiceOf` (con trim) sí la reconoce.                                     | **No se corrige.** La marca la escribe solo el importador, sin `\r` ni espacio final; riesgo bajo. Anotado. |
| 8   | P2   | El modal decía que el teórico de la fila es la suma de las bobinas sin mostrar el teórico por bobina; `aria-controls` apuntaba a un id inexistente con el panel cerrado. | **Corregido** (teórico y ML como dato secundario bajo «Kg consumidos»; `aria-controls` solo abierto).       |
| 9   | P2   | La SQL nueva no tiene cobertura unitaria; el E2E no cubre reporte revertido, plancha NIU ni accesorio.                                                                   | **Parcial** (E2E de accesorio). Revertido y NIU quedan anotados como deuda de pruebas en el handoff.        |
| 10  | P2   | El Excel no trae el teórico por bobina ni el nivel de comprobantes: pantalla y Excel ya no cuentan exactamente lo mismo.                                                 | **Pendiente del dueño**: el brief no pidió tocar el Excel; se pregunta en el handoff.                       |

## Verificado sin hallazgos (resumen del revisor)

`report_coil`/`meters` no duplican filas (un solo OUT no-reversa por reporte de coberturas);
despunte, bobina entera y notas de crédito coherentes; `customer_name` por INNER JOIN es seguro
(`customer_id` NOT NULL); M2 usa `Decimal`, lock compatible con `addPayment`, renumeración sin
choques, roles de ADMINISTRADOR y auditoría en la misma transacción; M0 aplica la misma regla en
preview y `confirm`; existen las rutas `/bobinas/[id]` y `/comprobantes/[id]`.
