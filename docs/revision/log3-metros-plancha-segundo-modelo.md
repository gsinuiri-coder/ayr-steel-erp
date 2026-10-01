# Segundo modelo — LOG-3, metros reportados de planchas

## Alcance y procedencia

Revisión estática de `origin/main...fix/log3-current` en `../ayr-log3r`, con contexto limpio y
sin leer el handoff de implementación. Sonnet no estaba disponible en este entorno; el pase lo
hizo **gpt-6-astra**. Es una revisión de modelo, no la revisión del dueño.

## Hallazgo del primer pase

- **[P2, corregido]** `apps/api/src/sales/order-readiness.ts` — la primera versión incorporaba
  metros derivados de reportes NIU a `reportedMl`, pero `orderedMl` seguía viniendo de
  `reserveQty`, que puede representar kg. Una producción parcial podía pasar de
  `LISTO_CON_FALTANTE` a `LISTO` en el DTO, aunque ambas etiquetas se mapeen al mismo estado
  visible `READY`. El segundo modelo no lo señaló inicialmente y lo confirmó al reevaluar la
  autorrevisión. Por decisión D-366, los cuatro archivos de ventas se restauraron desde
  `origin/main`; el diff efectivo de `apps/api/src/sales` quedó vacío.

## Pase final sobre el diff reducido

**Sin hallazgos nuevos P0, P1 ni P2 en el diff reducido que examinó este pase.** Se verificó que:

- NIU deriva metros del detalle de largos de reportes vigentes; MTR conserva `metersM` y no
  duplica el detalle de piezas.
- `metersReported` mantiene su semántica de unidad de kardex; `planMetersReported` viaja en el
  DTO y llega a la tarjeta del pedido y al historial de planta.
- El cálculo se hace sobre la consulta del listado, sin consultas por OP dentro de un bucle.
  El test revisa llamadas al cliente Prisma, pero no mide filas ni SQL real.
- `readiness` permanece igual que en `origin/main`.

La vista de accesorio MTR puede mostrar un denominador cero en el listado cuando la OP no
tiene `items`; se verificó que es anterior a este diff y queda fuera de D-366. La incompatibilidad
heredada de unidades de `readiness` también queda registrada en D-366 para una decisión aparte.
Después de este pase, una autorrevisión nueva identificó dos casos medios en el historial
de reportes y en el volumen de la consulta de listado. Se corrigieron en `2346bd8`: el
listado filtra reportes vigentes y el detalle recupera todos los vigentes cuando las reversas
llenaron su límite de 200. El segundo modelo reevaluó **todo el diff efectivo** tras ese commit
y no encontró P0/P1/P2 nuevos. Confirmó que, por el límite de negocio de 200 reportes vigentes,
si los primeros 200 fueran todos `ACTIVE` no puede quedar otro vigente fuera del historial.
Los campos heredados `piecesReported`, `metersReported` y `reports` conservan su truncación
anterior en el detalle; este ajuste se limita al nuevo campo. La reevaluación reutilizó el
contexto de la primera revisión, por lo que no es un pase adicional con contexto nuevo.

El pase no ejecutó pruebas ni comprobación visual. La revisión del dueño cierra la entrega.
