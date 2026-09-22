# RF-S3c — paso 0

Fecha: 2026-09-20. Alcance de esta lectura: `rf-s3c` en `ebe6fc4`; no se ejecutó ninguna
migración ni escritura fuera del worktree.

## a. Roles, guardas y token

`Role` vive en `apps/api/prisma/schema.prisma` (y se espeja en `@ayr/shared`):
`ADMINISTRADOR`, `SUPERVISOR_PLANTA` y `VENDEDOR`. Por tanto existe el rol vendedor y no
corresponde la parada D-230.

`AuthGuard` y `RolesGuard` son guards globales de `AuthModule`. El primero valida el JWT y la
sesión; el segundo lee `@Roles(...)` (`roles` metadata). La ausencia de `@Roles` permite los
tres roles autenticados. El JWT de acceso contiene exactamente `sub` (usuario), `sid`
(sesión revocable) y `role`; `req.user` añade email, nombre y `mustChangePassword` desde la
sesión. No existe hoy una política de alcance uniforme: hay verificaciones aisladas por
`createdById`, y varias lecturas están abiertas a todo vendedor.

## b. Matriz actual de rutas × rol

Leyenda: A=administrador, P=supervisor de planta, V=vendedor; `*` significa que el guard de
rol deja pasar pero no hay alcance por dueño consistente. Los endpoints públicos de auth y
health se excluyen de la matriz autenticada.

| Prefijo y rutas                                                                                                         |  A  |     P     |               V                | Estado de alcance actual                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | :-: | :-------: | :----------------------------: | ------------------------------------------------------------------------------------------------ |
| `audit` GET                                                                                                             | sí  |    no     |               no               | admin                                                                                            |
| `users` GET/POST/PATCH/DELETE                                                                                           | sí  |    no     |               no               | admin                                                                                            |
| `catalog`, `business-lines`, `colors`, `finishes`, `exchange-rates` GET                                                 | sí  |    sí     |               sí               | catálogo compartido                                                                              |
| altas/cambios de catálogo, colores, acabados, precios, tipos de cambio e importación de lista                           | sí  |    no     |               no               | admin                                                                                            |
| `customers` GET, lookup, search, detalle, POST, PATCH                                                                   | sí  |    no     |              sí*               | cartera compartida; DTO no lleva agregados                                                       |
| `inventory` balances, movements, summary                                                                                | sí  |    sí     |              sí*               | vendedor recibía kardex y campos costeados como `null`; la ruta de kardex seguía expuesta        |
| `coils` GET, detalle, PDF, children/splits/consumptions, report PDF; operaciones                                        | sí  |    sí     |               no               | no aplica V, pero enlaces cruzados pueden filtrar datos desde pedidos                            |
| `purchases`, `suppliers`, `cutting`, `reports`                                                                          | sí  | parcial P |               no               | administrativo/planta                                                                            |
| `production` lista/detalle y `production/roofing` cola/drafts                                                           | sí  |    sí     |          algunos GET*          | las rutas GET de roofing admiten V sin alcance; mutaciones son A/P salvo excepciones explícitas  |
| `sales/quotations` lista/detalle/PDF/stock-shortages                                                                    | sí  |    no     |              sí*               | lista y lectura cruzada abiertas                                                                 |
| `sales/quotations` create/update/duplicate/confirm-preview/confirm/reserve/release/cancel                               | sí  |    no     |              sí*               | algunas mutaciones revisan `createdById`, responden 403 y otras no                               |
| `sales/temporary-reservations`, `sales/orders`, `sales/orders/:id`, `sales/orders/:id/pdf-planta`, `sales/reservations` | sí  | parcial P |              sí*               | lecturas globales; pedido usa `createdById` solo en ediciones                                    |
| edición de pedido (cantidad/agregar ítem)                                                                               | sí  |    no     |              sí*               | chequeo de `createdById`, 403; precio/cliente/cancelar siguen admin                              |
| `dispatches` lista/detalle/crear/guía                                                                                   | sí  |    sí     |              sí*               | globales, sin dueño                                                                              |
| `invoicing/orders/:id/progress`, documentos lista/detalle/PDF/XML/CDR                                                   | sí  | parcial P |              sí*               | documentos tienen algunos checks por `createdById`, no por pedido                                |
| configuración, series, emisión, envío, anulaciones, cuentas por cobrar y pagos                                          | sí  |    no     | no (salvo lecturas anteriores) | admin                                                                                            |
| `pos` contexto/productos/turnos/ventas                                                                                  | sí  |    no     |              sí*               | es otro flujo; fuera del panel comercial, requiere política explícita antes de habilitar alcance |

El inventario exhaustivo de controladores está en `apps/api/src/**/**.controller.ts`; M1 debe
convertir esta matriz en metadata comprobable por el centinela, con default-deny para V, en vez
de sostenerla en esta tabla manual.

## c. Costos, margen y valorización expuestos hoy

Los DTO de inventario contienen `avgCost`, `totalValue`, `avgCostPen`, `totalValuePen`,
`unitCost`, `totalCost` y `balanceAvgCost`; hoy el servicio los anula para V, pero el vendedor
aún puede llamar los endpoints de kardex. Bobinas incluyen `unitCostPerKg`, `totalCost`,
`totalCostPen` y `avgCostPen` en servicios de bobinas; OP y reportes incluyen
`materialCostPen`, `overheadCostPen`, `totalCostPen`, `unitCostPen`; paneles de stock pueden
exponer el piso, del que se puede despejar costo con margen mínimo (D-163).

Plan: bloquear kardex y auditoría en API para V; eliminar costos/valorizaciones de los DTO
serializados para V (no meramente ocultarlos); mantener sólo el aviso del piso y su mínimo,
sin exponer las variables de cálculo.

## d. Cierre de OP

Una OP `CLOSED` se cierra con `closeInTx`: libera consumos montados y calcula merma/costo; no
exige que el plan se haya completado. D-159 añade `report-and-close`, transacción que escribe
el último reporte y luego cierra; `close` sin reporte también se permite tras haber producido
algo (cierre corto). Reabrir bobina (D-193) revierte el ajuste de cierre sólo si sigue siendo el
último movimiento vivo; no reabre una OP ni borra sus reportes. En consecuencia LISTO debe
usar OPs vivas cerradas y comparar cantidades reportadas con las pedidas, sin impedir un cierre
corto.

## e. Creadores y casos sin cotización

`Quotation.createdById` y `SalesOrder.createdById` existen y son obligatorios. Confirmar crea
el pedido con el actor actual, no copia el creador de la cotización: es el defecto que M1
corrige con `sellerId`. Pedido directo y POS quedan a nombre de su creador. El importador
masivo llama `createInTx` con el actor administrador que ejecuta el importador; por tanto sus
cotizaciones históricas hoy quedan a nombre de esa cuenta y el backfill las reportará como
administrativas, no inferirá un vendedor inexistente.

## f. Fugas no obvias

- PDF de cotización y hoja de planta por id no hacen comprobación de dueño.
- Trazabilidad en detalles de OP, reserva, despacho, bobina y números enlazables se resuelve
  por ids independientes; una relación bobina→pedido puede cruzar vendedores.
- Listas, búsqueda, reservas temporales, faltantes y exports/reportes reciben resultados
  globales.
- Documentos, PDF/XML/CDR y cobranzas se protegen de manera heterogénea por creador del
  documento, no por vendedor del pedido.
- Clientes no llevan totales o saldos en su DTO actual; hay que preservar esa ausencia.

## g. Ensayo de datos reales

Se intentó listar la rama `ensayo-s3c-20260920` en modo lectura mediante el wrapper seguro
del repositorio. Falló porque `neonctl` no está disponible en este entorno (sin credenciales
impresas ni reintentos). No se puede medir distribución real de roles ni de dueños aquí. M1
se ensayará con el dataset sintético/E2E; el dry-run del backfill y la distribución real en la
rama clon quedan como paso obligatorio previo a la ventana.

## Resultado de la parada D-230

No aplica: hay rol VENDEDOR real, el modelo de roles no exige rediseño, y no se obtuvo
evidencia de cuentas compartidas. Continúa M1.
