# cc51 corte B — autorrevisión (subagente nuevo, sin el handoff)

Alcance: `git diff origin/main...cc51-b-a-costo` (commit dc11313a), solo lectura, con foco en
permisos y en que nadie venda bajo costo. Es una lista de riesgos, no una aprobación.

Resumen: P0 ninguno · P1 1 · P2 6 · P3 7.

Verificado sin hallazgo: `allowAtCost` solo en alta, edición y duplicado de cotización; pedido
directo, agregar ítems y mostrador rechazan; importador e importadas rechazan (sin piso); el cambio de
precio en el pedido pasa por el piso normal y limpia la marca; `atCostPricePen` es null para quien no
es ADMINISTRADOR; el centinela de rol de `assertPriceFloor` sigue en pie; el margen 0 forzado no deja
`NO_MARGIN` ni cambia el piso normal; las consultas del panel no crecen (`unitCosts` deduplica).

- **P1 — corregido.** Cambiar la bobina de una línea de pedido (el dueño del pedido) dejaba el precio
  a costo de la bobina A sobre una bobina B más cara. Ahora una línea a costo no cambia de bobina.
- **P2-1 — corregido.** El VENDEDOR cambiaba la cantidad de una línea a costo en el pedido → 403
  (también en el diálogo).
- **P2-2 — corregido.** El VENDEDOR cambiaba el cliente de una cotización con líneas a costo → 403.
- **P2-3 — anotado (decisión del dueño).** Confirmar no vuelve a comprobar el costo; con margen 0, una
  subida del costo entre cotizar y confirmar deja la venta bajo el costo nuevo. Igual que el piso
  normal (D-163); el costo auditado es el del momento de cotizar.
- **P2-4 — corregido.** Duplicar como ADMINISTRADOR perdía la marca en la venta de bobina entera.
- **P2-5 — corregido.** La prueba del filtro de Ventas y margen no discriminaba: ahora factura un
  pedido a costo y uno normal.
- **P2-6 — corregido.** Cobertura de Sonar: funciones puras (`assertAtCostAllowed`,
  `markAtCostCandidates`, `attachAtCost`, `applyAtCostMarks`) con unitarias.

P3 (anotados): el «línea igual» ignora largos, descripción e importe del papel (el piso a costo se
comprueba igual); el piso compara el valor unitario redondeado a 4 decimales; quitar la marca no tenía
registro (corregido por la otra revisión); el vendedor no tiene aviso en el formulario antes del 403;
el filtro marca el pedido por cualquier línea; rótulos genéricos nuevos (`code`, `totalPen`,
`customerId`, `items`); faltaban pruebas de cantidad, duplicado del vendedor y panel del vendedor
(sumadas las de cantidad y duplicado).
