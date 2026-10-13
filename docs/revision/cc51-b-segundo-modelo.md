# cc51 corte B — revisión del segundo modelo (Sonnet, contexto limpio)

Alcance: `git diff origin/main...cc51-b-a-costo` (api, shared, web, migración), solo lectura.

Resumen: P0 ninguno · P1 1 · P2 2 · P3 3.

- **P1 — corregido.** Un VENDEDOR que mandaba la marca por API con un precio bajo recibía el 400 del
  piso a costo, con el costo promedio en el mensaje (el 403 llegaba después de resolver las líneas).
  Ahora el 403 va antes del piso (`assertAtCostRequest`) y, si una línea ya a costo queda bajo el costo
  para otro rol, el mensaje sale sin cifras (`opaqueAtCost`). Prueba con precio 0.01 → 403 sin cifras.
- **P2 — decidido.** Si el costo sube, el VENDEDOR no puede guardar una cotización con una línea a
  costo igual: se mantiene («nunca bajo el costo»), con el mensaje sin cifras.
- **P2 — corregido.** Quitar la marca no se auditaba: `sales.quotation.line-at-cost-removed`.
- P3 (anotados): el panel duplica candidatos para el ADMINISTRADOR (las consultas no crecen); la
  etiqueta del comprobante la ve quien vea el comprobante (solo el motivo); el filtro es por pedido.

Verificado: el VENDEDOR no tiene camino para bajar el precio de una línea a costo guardada
(emparejamiento de una sola vez, por producto, cantidad, precio, valor por metro y motivo); el pedido
hereda y pierde la marca donde corresponde; margen 0 con la misma fórmula; auditoría en la misma
transacción; `atCostPricePen` solo para ADMINISTRADOR; la migración solo agrega columnas y coincide
con `schema.prisma`; el SQL del filtro es válido.
