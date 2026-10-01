# UAT — LOG-3, metros reportados de planchas (D-366)

## Preparación

- Usar una instancia con API y web de la misma revisión de esta entrega.
- Elegir un pedido con una OP de plancha de catálogo (`NIU`) que tenga reportes vigentes con
  largos. Anotar la suma `cantidad × largo` de esos reportes antes de abrir las vistas.
- Este guion es de solo lectura: no crear, cerrar, revertir ni despachar órdenes.

## Recorrido

1. Abrir el detalle del pedido. En la tarjeta de órdenes de producción, la plancha debe mostrar
   los metros reportados calculados de sus largos frente a los metros del plan; por ejemplo, dos
   planchas de 3 m muestran `6.000 m de 6.000 m`, no `0.000 m de 6.000 m`.
2. Abrir `/planta?historial=1` y buscar el mismo pedido. La fila agrupada debe sumar esos metros
   con los de las demás OP de cobertura del pedido. Al expandirla, la fila de la OP debe mostrar
   los mismos metros reportados frente a su plan.
3. Revisar una OP de cobertura a medida (`MTR`): los metros registrados deben conservar su valor.
   Una OP de drywall debe continuar mostrando su avance en piezas.
4. Revisar una OP sin reportes vigentes: el avance visible debe ser cero. Si se revirtió un
   reporte, sus largos no deben sumarse.
5. Confirmar que el estado visible del pedido no cambió por este ajuste de lectura.

## Criterio de aceptación

La tarjeta del pedido y el historial coinciden con los largos de los reportes vigentes; las
unidades MTR y drywall conservan su lectura anterior. No se modifican reportes, saldos, kardex ni
el cálculo heredado de `readiness` del pedido.
