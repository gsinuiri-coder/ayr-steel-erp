# UAT — RF-S3b

Ejecutar en `demo`, solo escritorio. Validar a 1366×768 y repetir el caso 5 a 1920×1080.

## 1. Kardex individual

1. Abrir Inventario y entrar al kardex de una bobina con varios movimientos.
2. Confirmar que se lee desde el ingreso inicial hacia los movimientos posteriores y que no hay paginador.
3. Volver al listado general: debe seguir paginado y mostrar primero lo reciente.

## 2. Historial de planta

1. Abrir `/planta` y revisar Historial.
2. Confirmar que cada tarjeta representa un pedido y contiene sus OP.
3. Abrir una OP; debe conservar la ruta `/produccion/:id` y su detalle previo.

## 3. Selector de cliente y producto

1. Crear una cotización y abrir ambos selectores.
2. Confirmar que el cliente muestra RUC/DNI, no hay scroll horizontal y la fila completa elige.
3. Repetir con Tab + Enter y Tab + Espacio. El botón `Elegir` debe permanecer visible.

## 4. Altas contextuales

1. Revisar cotización, pedido e importador de cotizaciones.
2. Confirmar que no ofrecen crear producto/SKU.
3. Confirmar que `+ Crear cliente` sigue disponible.

## 5. ProductDialog

Abrir crear/editar producto para Drywall, Coberturas Aluzinc, UPVC, Reventa y Servicios. A
1366×768 y 1920×1080 no debe existir overflow horizontal; el cuerpo puede desplazarse en
vertical y las acciones deben quedar visibles.

Reportar cada caso como pasa, no pasa o no se pudo verificar, adjuntando captura ante fallo.
