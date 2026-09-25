# Correcciones 03 — censo de tablas (M5, D-295)

Censo de las tablas de `apps/web/src` (`grep -l "<Table"` + `PaginationBar`), hecho el 2026-09-25 en
la rama `fix/correcciones-03`. **Regla (D-295):** filtro de texto por columna, en el cliente, solo en
las tablas que **no** paginan; en las paginadas por el servidor, un filtro de columna en el cliente
filtraría solo la página visible, así que ahí se filtra en el servidor por cliente, estado y rango
de fechas (D-289) y nada más.

## Paginadas por el servidor (sin filtro de columna en el cliente)

| Vista                    | Paginada | Filtros que sí tiene (servidor, en la URL)                         |
| ------------------------ | -------- | ------------------------------------------------------------------ |
| `cotizaciones`           | sí       | búsqueda (código, cliente, documento), estado + chip Anulados      |
| `pedidos`                | sí       | búsqueda, estado, chips Atendidos / Anulados                       |
| `bobinas`                | sí       | pestaña, línea, acabado, espesor, estado + chip Anuladas, búsqueda |
| `comprobantes`           | sí       | búsqueda, tipo, origen, estado + chip Anulados, «solo con saldo»   |
| `compras`                | sí       | línea, tipo, estado + chip Anuladas, «solo con saldo», búsqueda    |
| `despachos`              | sí       | búsqueda, estado + chip Revertidos                                 |
| `cobranzas` (dos tablas) | sí       | ninguno (resumen por cliente y comprobantes con saldo)             |
| `clientes`               | sí       | búsqueda (nombre o documento)                                      |

## No paginadas — con filtro de columna (M5)

| Vista / tabla                               | Columnas filtrables                | Nota                                                                        |
| ------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| `catalogo` (una tabla por línea)            | SKU, nombre                        | además del buscador de M1                                                   |
| `kardex` (kardex de un ítem)                | movimiento, origen, motivo/usuario | el rango se filtra en el servidor                                           |
| `pedidos/[id]` → órdenes de producción      | orden, producto, estado            |                                                                             |
| `planta?historial=1` (historial de órdenes) | pedido, cliente, estado            | sobre todos los pedidos entregados (tope de 500 órdenes), no solo la página |

## No paginadas — sin filtro de columna (no aplica o fuera de alcance)

| Vista                                                                                                                                                                    | Motivo                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Detalles (`cotizaciones/[id]`, `pedidos/[id]` líneas y reservas, `bobinas/[id]`, `produccion/[id]`, `comprobantes/[id]`, `despachos/[id]`, `compras/[id]`, `corte/[id]`) | tablas de 1 a 30 filas de un solo documento                                  |
| Formularios (`nuevo-comprobante`, `nuevo-despacho`, `sales-document-form`, `nueva-orden`)                                                                                | son las líneas que se editan                                                 |
| Selectores (`search-select-modal`, `coil-picker`, `coil-sale-picker`, `product-stock-picker`, `confirm-quotation-dialog`)                                                | ya tienen su propio filtro de texto                                          |
| Maestros chicos (`acabados`, `lineas`, `proveedores`, `usuarios`, `configuracion/*`, `catalogo/colores`)                                                                 | decenas de filas; un filtro no aporta                                        |
| Reportes (`reportes/*`, `inventario`, `flejes`, `reservas-temporales`, `auditoria`, `pos/caja`)                                                                          | tienen sus propios filtros o agrupaciones; `auditoria` filtra en el servidor |

Cualquier tabla que pase a paginar por el servidor pierde el derecho a este filtro; cualquier tabla
nueva sin paginar puede usarlo con `useColumnFilters` + `SortableTableHead filter={…}`.
