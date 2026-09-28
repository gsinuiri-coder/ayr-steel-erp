# Guion UAT — Correcciones 05: ventas por material y cuatro ajustes (D-354 a D-358)

Para correr en **demo** (copia de producción) o en producción después de la ventana. Todo lo de este
guion es **de lectura**: en producción se mira, no se pulsa nada que escriba.

## 1. Ventas por material (D-354)

1. **Reportes → Ventas por material** (solo administrador; un vendedor o un supervisor no ven el ítem
   del menú y la ruta les responde 403).
2. Por defecto, **Mes actual**. Pulsar **Mes anterior** → el rango cambia al mes pasado completo; la
   dirección de la página lo guarda (recargar no lo pierde).
3. La tabla tiene una fila por **tipo × espesor × color** del producto vendido, en el orden
   Coberturas, Accesorios, Bobinas (venta entera), Planchas, con un **Subtotal** por tipo y el
   **Total** abajo. Columnas: ML vendido, peso teórico, peso real, rendimiento (kg y %), venta, costo
   de producción, utilidad, costo/kg compra, precio/kg venta y margen/kg.
4. Chequeos de una fila: utilidad = venta − costo; costo/kg = costo ÷ peso real; precio/kg = venta ÷
   peso real; margen/kg = precio/kg − costo/kg; rendimiento = teórico − real.
5. **Clic en una fila** → modal «Bobinas usadas» con código, espesor y color **de la bobina**, kg y
   costo. Los kg del modal suman el peso real de la fila. Cambiar a **Desglosado** → aparece la columna
   Tipo.
6. Botón **Bobinas usadas** (arriba) → el mismo modal para todas las filas visibles.
7. Filtros **Tipo**, **Espesor**, **Color** → la tabla, los subtotales y el total se recalculan; la
   leyenda del cuadre **no** cambia (es sin filtros).
8. Sección **No trazable** (si hay): cada venta con su comprobante, pedido, SKU y motivo («Sin
   producción aún», «Producción parcial», «Atendida desde stock», «Sin línea de pedido», «Bobina sin
   despachar aún», «Unidad sin conversión a metros lineales»). Esas ventas no están en las filas.
9. **Cuadre.** La leyenda de abajo da la venta de Coberturas Aluzinc facturada en el rango y la de
   bobinas enteras. Abrir **Ventas y margen** con el mismo rango: la fila «Coberturas Aluzinc» más los
   pedidos de esa línea que queden en «Facturación parcial» o «Costo no rastreable» dan la primera cifra.
   Total de la tabla + venta no trazable = las dos cifras de la leyenda sumadas.
10. **Descargar Excel** → tres hojas: «Ventas por material» (con subtotales, total y el cuadre),
    «Bobinas por tipo» (el modal desglosado) y «No trazable». Con un filtro puesto, el Excel sale
    filtrado igual.

## 2. Reporte mensual de bobinas: solo vigentes (D-355)

1. **Reportes → Reporte mensual de bobinas**, **agosto 2026**: saldo fin de mes **283 602.000 kg**
   (el cambio de esta entrega no lo mueve). Era 291 636.000 kg cuando se verificó D-340; bajó 8 034 kg por
   dos ventas de bobina entera registradas el 26-09 con fecha de agosto (despacho a la fecha del
   comprobante, D-278): `SALDO-…-4194-7` y `SALDO-…-3840-12`.
2. En Selladas y Abiertas **no hay ninguna bobina con 0 kg** en «Saldo fin de mes».
3. Debajo de las tablas: «N bobinas terminadas o agotadas en el mes, no listadas: X kg consumidos»,
   y si corresponde «N anuladas con saldo al inicio: X kg». Y el cuadre: «Saldo inicio + altas −
   salidas = saldo fin de mes».
4. **Septiembre 2026**: las dos anuladas (XSY-…-4544-9 e IMPO-…-4240-1, alta y anulación en
   septiembre) no aparecen en ningún lado, y el saldo fin de mes es el mismo de antes de este cambio
   (**171 650.418 kg** al 2026-09-27). El saldo inicio de septiembre es el saldo fin de agosto.
5. **Descargar Excel** (Selladas, Abiertas, Resumen) y **Descargar PDF**: las mismas tablas y líneas.
   Con el usuario del supervisor de planta, lo mismo con costos (lo ve); un vendedor no entra.

## 3. Metro lineal teórico (D-356)

1. **Almacén → Bobinas**: la columna se llama **«ML teórico (peso inicial)»** y en una bobina usada ya
   **no** baja con el disponible (se calcula sobre el peso inicial). El PDF de la lista, igual.
2. **Almacén → Inventario → Coberturas Aluzinc → Bobinas por tipo**: columna nueva **«ML teórico
   (disponible)»**. En un tipo con una sola bobina, coincide con el metro del disponible del detalle de
   esa bobina. **Descargar Excel** de esa tabla.

## 4. Pedidos: a qué comprobante están asociados (D-357)

1. **Comercial → Pedidos**: columna **Comprobante** con el número como enlace. Un pedido con varios
   comprobantes muestra el primero y «+N»; al pulsar «+N» se abre un cuadro con el resto. Una nota de
   crédito se marca «(NC)».
2. Detalle de un pedido facturado: los comprobantes junto al estado, como enlaces.

## 5. Comprobantes: a qué despacho están asociados (D-358)

1. **Comercial → Comprobantes**: columna **Despacho**.
   - Un comprobante con despacho **declarado** (facturado declarando el despacho, venta de mostrador,
     o «Despachar a la fecha del comprobante»): el enlace al despacho, en negro.
   - Uno **sin** despacho declarado cuyo pedido tiene despachos: en gris «Del pedido: DES-…» (es del
     pedido, no del comprobante).
   - Una guía de remisión: su propio despacho.
2. En el detalle del comprobante, lo mismo debajo del encabezado.
