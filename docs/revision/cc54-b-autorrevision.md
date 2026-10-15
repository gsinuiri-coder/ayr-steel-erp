# cc54 corte B — autorrevisión

Revisor: un subagente nuevo que no leyó el handoff de implementación (AGENTS.md §2.2.1). Revisó `d902e5c9..48324e3a`
en solo lectura. Es una lista de riesgos, no una aprobación.

Veredicto: sin P0; dos P1, cuatro P2 y diez P3.

## Lo verificado sin hallazgo

- **CHECK del motivo:** toda NC tiene motivo (CHECK de fase5b), así que los filtros `in` y `notIn` no pierden filas.
- **POS:** el mostrador anula con 01 por borrador y envío. `assignInTx` no genera DEV-, la reversa del despacho sigue
  funcionando y no hay doble devolución.
- **Doble devolución:** con una DEV- vigente, la reversa manual del despacho queda bloqueada.
- **Orden de bloqueos (regla 17):** el camino de un paso respeta el orden: comprobante y NC, despachos, pedido, y después
  bobinas y saldos.
- **Importes de las NC de cantidad (D-169, D-255, D-265):** la línea entera copia su importe y la que cierra toma el
  resto. Con una rebaja anterior, se valoriza a lo que queda por unidad.
- **Facturar de nuevo tras una rebaja:** no se sobrefactura (`closingPartTotals`).
- **`assertStillAvailable`:** mide la cantidad solo contra las NC de cantidad y el importe contra todas.
- **02:**
  - es total y trae el reemplazo;
  - el neto del pedido no cambia;
  - el reemplazo conserva el plazo del papel;
  - el comprobante anulado no se puede anular mientras la 02 esté viva.
- **13:** el vencimiento vigente sale de la NC en todos los lectores: el DTO (también `isOverdue`), el Excel de
  comprobantes, cobranzas, la antigüedad de CxC y su Excel, y el panel.
- **D-662, rentabilidad, web y API, y auditoría:** coherentes.

## Hallazgos y qué se hizo

| Sev | Hallazgo                                                                                                                   | Qué se hizo                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | Después de un 01 con DEV-, el pedido no se podía anular: pedía revertir el despacho, y la devolución lo impedía            | Corregido para el pedido despachado a medias (uno atendido entero ya no se anulaba antes, regla de siempre): un despacho devuelto entero no bloquea la anulación del pedido. Con el pedido anulado, la NC ya no se anula (la mercadería volvería a salir). Prueba unitaria y db-spec |
| P1  | Las NC 03/04/05/13 que ya existían dejarían de acreditar unidades                                                          | Sin efecto: producción tiene 0 NC (medido el 2026-10-15, solo lectura)                                                                                                                                                                                                               |
| P2  | Anular una NC 02 no deshacía el reemplazo; el reemplazo es único y su choque daba un mensaje falso                         | Corregido: anular la 02 (con su reemplazo ya anulado) devuelve el despacho y el cliente del pedido, con constancia. Un segundo 02 sobre el mismo comprobante se rechaza con un mensaje claro. db-spec                                                                                |
| P2  | La vista previa prometía una DEV- en un 01 sobre un comprobante electrónico                                                | Corregido: la vista previa devuelve mercadería solo si el comprobante es manual                                                                                                                                                                                                      |
| P2  | En Ventas y margen, un 01 sin DEV- dejaba de marcar «no comparable»                                                        | Corregido: el 01 declara costo solo con su DEV-; sin ella, como antes                                                                                                                                                                                                                |
| P2  | El 02 cambia el cliente del pedido, pero no el de las guías; un borrador de NC no lo bloqueaba; lo podía hacer un vendedor | Corregido: lo bloquean las guías vivas y los borradores de NC del comprobante; solo lo registra un ADMINISTRADOR (en el API y en la web)                                                                                                                                             |
| P3  | La web podía registrar un cuerpo distinto del de la vista previa (debounce)                                                | Corregido: el botón exige que la vista previa sea la del cuerpo actual                                                                                                                                                                                                               |
| P3  | Una 05 o una 04 podían salir por S/ 0                                                                                      | Corregido: se rechaza la rebaja menor a un céntimo                                                                                                                                                                                                                                   |
| P3  | Una 04 con monto de 4 decimales                                                                                            | Corregido: el API exige céntimos                                                                                                                                                                                                                                                     |
| P3  | Quedaba un texto viejo («Descuento / corrección de precio»)                                                                | Corregido: «Rebajar el precio»                                                                                                                                                                                                                                                       |
| P3  | Lista de motivos de cantidad duplicada                                                                                     | Corregido: el reporte usa `QTY_CREDIT_NOTE_REASONS`                                                                                                                                                                                                                                  |
| P3  | El reemplazo no tenía constancia de alta                                                                                   | Corregido: `invoicing.document.register-manual` en el reemplazo                                                                                                                                                                                                                      |
| P3  | El orden por vencimiento de la lista usa la columna guardada, no el vencimiento vigente de un 13                           | Anotado                                                                                                                                                                                                                                                                              |
| P3  | 03 y 13 sobre un comprobante ya acreditado, o por el camino electrónico                                                    | Anotado (PSE fuera)                                                                                                                                                                                                                                                                  |
| P3  | Un 01 puede devolver un despacho sin comprobante declarado                                                                 | Decidido así en D-656                                                                                                                                                                                                                                                                |
| P3  | Se borró la E2E de cc52                                                                                                    | Su recorrido (06 con DEV- y bobina reabierta) quedó en `nc-motivo-cc54`; la anulación de la NC que revierte la DEV- la cubre `sales-returns.db-spec`                                                                                                                                 |
