# Guion UAT — RF-S4b: SKU canónico de bobina, pool y el importe que manda

Para correr en **demo** (copia de producción) antes de la ventana, o en producción después de
ella con datos que el dueño elija. Cada paso dice qué mirar y qué tiene que salir.

## 1. El importador resuelve un código de bobina al pool (R1, D-254)

1. Cotizaciones → Importar. Subir un export que traiga una línea `BOB38<color>` (por ejemplo la
   de FFA1-1355 o FFA1-1350 del export de agosto).
2. En la fila de la bobina, la columna de producto muestra el **SKU canónico** (`BOB038ROJO`,
   `BOB038AZUL`), los kg disponibles del pool y un selector «Bobina de la fila N».
   - Con **una sola** bobina candidata (o una sola con el saldo exacto del papel), viene elegida.
   - Con varias, la fila queda en rojo pidiendo elegir; elegir una la destraba.
   - Sin candidatas, la fila queda bloqueada con el motivo (kg disponibles del pool).
3. La columna **Valor de venta S/** es editable. Si no se toca, el importe que se guarda es el
   del papel; si se toca, el unitario se recalcula desde el importe.
4. Confirmar la cotización y el pedido: no aparece «0.000 KGM disponibles». La reserva del pedido
   es sobre la bobina elegida.

## 2. El importe manda (R2, D-255)

1. Nueva cotización con un producto por kg: precio con IGV **3.50**, cantidad **4194**. Tiene que
   mostrar y guardar **12,439.83 / 2,239.17 / 14,679.00** (antes salía 14,678.99).
2. En la misma línea, activar «Cargar importe sin IGV» y escribir **11715.254** con cantidad
   **3840**: el total del documento queda en **13,824.00** y el unitario mostrado **3.0508**.
3. Editar el precio de una línea de un pedido (solo ADMINISTRADOR): el diálogo deja elegir
   «Precio con IGV» o «Importe de la línea» y muestra antes de guardar lo que se va a guardar.
4. Un pedido importado se edita **sin** que el piso de precio rebote (D-256).

## 3. Cambiar la bobina de una línea de pedido (D-254)

1. En un pedido con venta de bobina, botón «Bobina» de la línea → lista las candidatas del pool
   (mismo espesor exacto, mismo color comercial o tipo, libres, con saldo ≥ la cantidad).
2. Elegir otra, escribir el motivo, guardar: la reserva pasa a la nueva bobina; cantidad e
   importe no cambian.

## 4. Catálogo (D-257)

1. Catálogo → Nuevo producto con SKU `BOB040ROJO`: rebota («se generan solos al dar de alta la
   bobina»).
2. Comprar una bobina de un color/espesor nuevo: aparece sola en el catálogo con el SKU canónico.

## 5. Después de la ventana: la normalización y el barrido

1. Catálogo: los `BOB…` de reventa tienen SKU canónico. Los sueltos unidos (p. ej. `BOB38AZUL`)
   aparecen **inactivos** con su código viejo.
2. Reportes → Inventario valorizado y Ventas y margen: los totales son los mismos que antes de la
   ventana (anotar los dos totales antes del execute).
3. COT-000002: la línea vende la bobina de 4194 kg (SALDO-ALZ-AZUL-5002-0.38-4194-7), total
   **14,679.00**. Confirmarla crea el pedido sin error.
4. El pedido de FFA1-1355 (si sigue abierto) se puede facturar con el importe del papel.
