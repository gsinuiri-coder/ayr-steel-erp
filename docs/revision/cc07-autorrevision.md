# Autorrevisión — cc07 (D-373, reactivar comprobante anulado)

**Autorrevisión: lista de riesgos, no aprobación.** La hizo un subagente nuevo que no leyó el
handoff de implementación (AGENTS.md §2, regla 2.1). No vale como pase cruzado.

- **Fecha:** 2026-10-01
- **Rama:** `cc07/reactivar-comprobante`
- **Commits revisados:** `5536da6`, `f6519cc`, `0d19ea4`

Resumen del informe. El detalle de cada hallazgo está en la tabla final, con lo que se hizo.

## Verificado sin hallazgo

- **CHECK de la fila.** Vaciar `annulled_at`, `annulled_by_id` y `annul_reason` al volver a
  `ACCEPTED` cumple dos CHECK:
  - el bicondicional (`20260905233000…/migration.sql:9`);
  - el de forma (`20260905220100…/migration.sql:19-20`).

  El de origen (`20260908213000…:31-33`) solo restringe `ANNULLED`.

- **Lock.** `FOR UPDATE` sobre la fila, más `updateMany` condicionado a `ANNULLED` (409 si
  `count !== 1`).
- **Roles.** Hay doble guarda, en el controlador y en el servicio.
- **Auditoría.** Guarda una copia completa de lo que se vacía.
- **Decimal.** Se usa en toda la cuenta de líneas.
- **Unicidad.** No se toca.
- **`RowActions`.** El cambio es compatible hacia atrás.
- **Lista.** `colSpan` 9/10 correcto.
- **`useSearchParams`.** Bien en una página dinámica.

## Hallazgos

| Id   | Sev. | Hallazgo                                                                                                                                                                                                          | Qué se hizo                                                                                                                                                                                                                                              |
| ---- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 | P1   | Carrera con el registro o envío del borrador del reingreso. `registerManual` bloquea solo su fila, así que dos comprobantes podían quedar vivos sobre las mismas líneas. Coincide con el P2-1 del segundo modelo. | **Corregido.** La reactivación toma, en este orden, el comprobante, el **pedido** (el mismo lock que la creación de borradores y las ediciones D-187) y los **borradores** de esas líneas, ordenados por id (`FOR UPDATE`). Unitario del orden de locks. |
| P2-1 | P2   | El pedido pudo cambiar mientras el comprobante estuvo anulado (precio, producto de la línea, o pedido `CANCELLED`) y la reactivación no lo mira.                                                                  | **Decisión del dueño** (regla dura 16). No implementado. Recomendación: bloquear si el pedido está `CANCELLED`. Los cambios de precio o de producto, avisarlos o bloquearlos, según decida el dueño. Para 341, PED-000048 está `CONFIRMED`.              |
| P2-2 | P2   | Con fecha sugerida, la línea «Default D-285» rotulaba la fecha sugerida.                                                                                                                                          | **Corregido.** Con `suggestedDate`, el default se lee de un plan pedido sin fecha (misma clave de caché que el plan por defecto).                                                                                                                        |
| P2-3 | P2   | Huecos E2E: línea refacturada, NC, cobro, 403 y visibilidad del menú.                                                                                                                                             | **Parcial.** Se agregó el E2E de **línea refacturada**, que nombra el comprobante, contra Postgres real. NC, cobro y 403 siguen cubiertos por unitarios; el resto queda anotado.                                                                         |
| P2-4 | P2   | Huecos en los unitarios: 4 campos de PSE sin probar, `IMPORTED`, estado auditado distinto de `ACCEPTED`.                                                                                                          | **Corregido.** Los 9 campos de PSE, `IMPORTED` que pasa y la anulación auditada desde otro estado. Más los de NC, sin líneas de pedido y orden de locks: 28 tests.                                                                                       |
| P3-1 | P3   | `?despacho=fecha-comprobante` queda en la URL.                                                                                                                                                                    | Anotado. Es inofensivo (solo siembra la fecha y el aviso); quitarlo con `router.replace` borraría el aviso al instante.                                                                                                                                  |
| P3-2 | P3   | Sin `idempotencyKey`.                                                                                                                                                                                             | Conforme a D-182: es una **transición de estado**, protegida por el lock de fila; el segundo intento da 409. Registrado en D-373.                                                                                                                        |
| P3-3 | P3   | Posibles falsos positivos de rastro PSE en importados históricos.                                                                                                                                                 | Anotado. Bloquea, que es el lado seguro.                                                                                                                                                                                                                 |
| P3-4 | P3   | El mensaje de borradores no nombra cuál.                                                                                                                                                                          | Anotado. Nombra el pedido.                                                                                                                                                                                                                               |
| P3-5 | P3   | La acción no está en el detalle.                                                                                                                                                                                  | Conforme al requisito aprobado (menú de la fila).                                                                                                                                                                                                        |
| P3-6 | P3   | `uniqueCorrelative()` se repite cada ~2,8 h.                                                                                                                                                                      | Anotado. Es el mismo patrón que el resto de la suite.                                                                                                                                                                                                    |
| P3-7 | P3   | Faltaba la fila D-373.                                                                                                                                                                                            | Agregada en el commit de docs.                                                                                                                                                                                                                           |

## Riesgos que quedan

1. **Pedido modificado o anulado** mientras el comprobante estuvo anulado: P2-1, pendiente de
   decisión.
2. **La casilla «sigue vigente en Nubefact/SUNAT» es una afirmación del usuario.** El ERP no la puede
   verificar en un manual.
3. **El despacho a la fecha del comprobante escribe kardex retroactivo.** En 341 la línea 2 seguirá
   en revisión (negativo de `AUTOPERF10X1` el 2026-08-03). El runbook dice que no se fuerza otra
   fecha sin decisión.
4. **La historia de la anulación vive solo en `audit_log`.**
