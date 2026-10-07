# cc32 · Reportes y documentos — especificación aprobada

Aprobada por el dueño el 07/10/2026. Solo web (`apps/web`). Sin cambios de API, sin migraciones, sin cambios de regla de negocio. Continúa cc31 y hereda todas sus reglas transversales (tipografía, números, textos, estados de lista, mensajes).

## Cómo leer esto

- `tableros/*.dc.html` son los dibujos aprobados (HTML con estilos en línea; ignora `<x-dc>` y `support.js`).
- El tablero manda en disposición y jerarquía; este documento manda en reglas y alcance.
- Los tableros «Hoy» se dibujaron antes de cc31: sirven para ver qué cambia, no como retrato exacto de producción.
- Usa los tokens y componentes existentes, incluidos los que cc31 creó. No copies hex ni estilos en línea.
- Si algo dibujado necesita un dato o un archivo que el API no entrega hoy, se omite y se anota en el informe.

## 1. Plantilla de reportes

Tableros: `ReporteHoy`, `ReportePropuesta`, `ReporteReglas`, `ReporteIndice`.
Aplica a los siete reportes: Ventas y margen, Ventas por material, Cuentas por cobrar, Inventario valorizado, Reporte mensual de bobinas, Merma por bobina y Reporte de producción.

### Cabecera

- Ruta «Reportes / nombre». Título a 20 px y un subtítulo de una línea.
- La explicación larga (cómo se calcula, cuadres, salvedades) pasa a «Cómo se calcula», que abre un panel o popover. No se pierde ningún texto: se mueve.
- A la derecha: «Más opciones» y «Descargar Excel» como botón principal.

### Periodo

- Un solo componente para todos: atajos «Este mes», «Mes anterior», «Últimos 3 meses», «Este año» y «Otro periodo…» (rango libre), con el rango escrito al lado.
- Fechas en hora de Lima, como hoy (`businessToday`, texto AAAA-MM-DD).
- El periodo va siempre en la URL, también cuando es el predeterminado, para que un enlace guardado muestre el mismo periodo otro día.
- El periodo se mantiene al pasar de un reporte a otro.
- Reporte mensual de bobinas sigue eligiendo un mes. Cuentas por cobrar e Inventario valorizado siguen siendo «a hoy», sin selector.
- Con un rango inválido se muestra el mensaje de error y no un esqueleto de carga eterno. Al cambiar de periodo o de pestaña se conserva el dato anterior mientras carga el nuevo.

### Cifras

- Franja gris con etiquetas cortas que no se corten; el matiz va en una segunda línea pequeña.

### Tabla

- Orden por cualquier columna, en todos los reportes. El orden va en la URL.
- Buscador sobre lo ya cargado.
- Todo código de documento es un enlace: pedido, comprobante, bobina, orden de producción, cliente.
- El detalle de una fila se abre y cierra con chevron, igual en todos. El diálogo de Ventas por material se conserva.
- Unidad en el encabezado («Venta (S/)», «Saldo (kg)»), no en cada celda. Espesor siempre con «mm». Miles con separador. Cero como «0.00», igual en todos.
- Fila de total al pie en toda tabla principal.
- Sin columnas con el mismo nombre. En Ventas y margen: la segunda «Costo» pasa a «Costo registrado»; «Material de OPs» sale de la tabla y queda en el detalle de la fila.
- Sin jerga a la vista: «OP» → «Orden», «Comprob.» → «Comprobantes», «pzs» → «piezas», y los códigos crudos de tipo y acabado con su nombre cuando el dato ya viene.

### «Ver por»

- En Ventas y margen: Pedido / Vendedor / Cliente. Agrupa en el navegador las filas que el reporte ya trae; los totales del grupo se calculan con los valores completos.

### Excel

- El botón aparece donde el API ya entrega el archivo, con el filtro y el periodo puestos.
- Donde el API no lo entrega (Merma, y las pestañas sin archivo de los demás) el botón no se muestra. No se genera Excel en el navegador. Se anota la lista para una pieza de API.

### Inicio de Reportes

- Página `/reportes` (hoy da error) con los siete reportes agrupados: Ventas y cobranza, Almacén, Planta. Cada tarjeta, una línea que dice qué responde. Solo los que el rol puede abrir.

## 2. Documentos: guía e imprimir

Tablero: `Documentos`.

### Imprimir

- «Imprimir» abre el diálogo de impresión con el mismo PDF que ya genera el API, sin descargar el archivo. Se resuelve en la web.
- «Descargar PDF» sigue existiendo, en «Más opciones».
- Si el PDF falla, mensaje en español con el ayudante de cc31, nunca JSON crudo. Las descargas de comprobante y Mostrador pasan por `downloadFile`.

### Despacho

- El botón principal sigue el estado de la guía: sin guía, «Emitir guía»; con guía, «Imprimir guía».
- «Más opciones»: Descargar PDF de la guía, Ver la guía, y al final, en rojo, Revertir despacho.
- Guía con número pero todavía sin aceptar por SUNAT: se permite imprimir solo si la app ya permite hoy continuar la operación en ese estado. Compruébalo en el código; si no es así, el botón espera a «aceptada» y lo dice.

### Mostrador

- Al cerrar la venta, «Imprimir comprobante» es el botón principal y Enter imprime. «Nueva venta» queda al lado; «Descargar PDF» como enlace.
- Al cerrar la impresión, el foco vuelve a «Nueva venta».

### Resto

- Comprobante: «Imprimir» primero en «Más opciones».
- Cotización: «Imprimir» en «Más opciones»; el botón principal sigue siendo el del estado.
- Pedido: «Imprimir hoja de planta» donde hoy está «Hoja de planta (PDF)».

## Fuera de la pieza

- Reportes nuevos (compras por proveedor, cobranzas del periodo, conversión de cotizaciones) y los Excel que faltan: piden API.
- PDF de orden de producción y de despacho; decimales dentro de los PDF.
- Planta, auditoría, buscar despachos por código.
