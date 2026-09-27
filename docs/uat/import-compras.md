# Guion UAT — Importar compras, inactivos del catálogo y editar un producto sin uso (D-348 a D-353)

Para correr en **demo** (copia de producción) o en producción después de la ventana. Cada paso dice
qué mirar y qué tiene que salir. En producción, **mirar y no pulsar** salvo los pasos marcados con ✍
(escriben datos).

## 1. Catálogo: inactivos ocultos por defecto (D-349)

1. **Catálogo → Productos**, cualquier línea. Junto al buscador hay un botón **Inactivos**, apagado.
2. La lista muestra **solo productos activos** (ninguna fila con estado «Inactivo»).
3. Escribir en el buscador el SKU de un producto desactivado → aparece, con estado «Inactivo».
4. Borrar el buscador y pulsar **Inactivos** → aparecen también los desactivados; la dirección de la
   página lleva `inactivos=1`. Recargar la página → el botón sigue encendido.

## 2. Editar un accesorio sin uso real (D-348)

1. **Catálogo → Coberturas Aluzinc → Editar** un accesorio (`ACCES…`) que solo tenga cotizaciones
   **anuladas o vencidas** (o ninguna):
   - Subtipo, espesor y acabado **están habilitados**.
   - Cambiar el espesor (por ejemplo de 0.30 a 0.45) → el SKU cambia solo a `ACCES045…`. ✍ Guardar →
     se guarda con el SKU nuevo.
2. **Editar** un accesorio con una cotización **emitida** (viva), un pedido o kardex:
   - Subtipo, espesor y acabado **bloqueados**, y debajo el motivo: «Tiene uso real (cotizaciones
     vigentes…): su subtipo, espesor y color ya no cambian. Crea otro producto y desactiva este.»
   - El nombre y el precio se siguen editando normal.
3. ✍ Pasar un accesorio sin uso a **A medida**: al guardar, el SKU `ACCES…` se marca en rojo («Los SKU
   ACCES… son de accesorios…»); escribir un SKU nuevo y guardar → pasa.
4. ✍ Pasar una cobertura a medida **sin uso** a **Accesorio**: el SKU se propone solo con el patrón
   `ACCES` + espesor + color.
5. **Duplicar** una cotización anulada cuyo producto cambió de subtipo → mensaje «No se puede duplicar
   COT-…: en la línea N, … pasó a ser un accesorio … desde que se cotizó»; no se crea nada.
6. **Eliminar** un producto con una cotización anulada sigue deshabilitado (borrar no cambió).

## 3. Importar compras (D-351, D-352)

1. **Compras → Importar compras** (o **Bobinas → ⋯ → Importar compra de bobinas**). Botones
   **Plantilla** y **Ejemplo** descargan los `.xlsx`.
2. ✍ Completar la plantilla con una compra de cada tipo (bobinas en dólares sin tipo de cambio,
   producto terminado, servicio y gasto) y subirla.
   - Cada comprobante sale en su acordeón con proveedor, total y estado.
   - En la de dólares: «Sin tipo de cambio en el archivo: se usará el de SUNAT del …» y el TC a usar.
   - Un RUC que no está en proveedores pero sí en SUNAT: «Nuevo — se creará desde padrón: <razón
     social>» y el **código corto** propuesto, editable.
   - Poner un color que no es el del acabado → error en la fila. Un SKU de otra línea → error.
3. Subir una compra que **ya está registrada** → «Ya registrada: compra F001-… de …».
4. Subir una factura cuyo número coincide con una **factura de referencia de la carga inicial** →
   «Coincide con la factura de referencia de la carga inicial (bobinas/SKU: …)… ¿Es otra compra?»; el
   botón **Crear las compras** no se habilita hasta marcar **Es otra compra**.
5. Corregir una celda con error → en un segundo se revalida y el comprobante pasa a **Lista**.
6. ✍ **Crear las compras** → «Se crearon N compras en borrador» con los enlaces. En **Compras** están
   en estado **Borrador**.
7. ✍ **Deshacer lote** (administrador) → anula las que siguen en borrador y sin pagos y nombra las
   demás («ya se recibió…»).

## 4. Recibir varias compras (D-353)

1. **Compras**: las filas en **Borrador** tienen una casilla.
2. ✍ Marcar dos y pulsar **Recibir seleccionadas (2)** → «2 recibidas.» con el detalle de cada una.
   Una compra de bobinas recibida así crea sus bobinas con el color de su acabado y el código externo
   que traía la planilla.

## 5. Purga de cotizaciones anuladas (D-350, solo el equipo técnico)

Se corre por consola con los números que pase el dueño; primero el dry-run
(`local-data/import-compras/purga-cotizaciones-dry-run-<rama>.txt`), después el `--execute` con su OK.
Las no anuladas, con pedido o con reservas temporales vivas salen como **bloqueadas** y no se tocan.
