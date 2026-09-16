# UAT — RF-S1 (M0 higiene + precios de lista)

Guion para que el dueño (o quien capacite a un vendedor) pruebe lo que esta sesión entregó,
en lenguaje de negocio. Todos los casos son en `demo` o `dev` — ninguno se prueba contra
`production` con el catálogo real hasta que el propio dueño decida cargar precios ahí.

## 1. Precio de lista — edición inline

**Qué probar:** cambiar el precio de venta sugerido de un producto sin abrir el formulario
completo de edición.

1. Entrar a **Catálogo**, elegir cualquier línea con productos.
2. En la columna «Precio de lista (con IGV)», hacer click sobre el precio de un producto (o
   sobre «sin precio» si todavía no tiene uno).
3. Escribir un precio **con IGV** (el que el cliente pagaría) y «Guardar».

**Resultado esperado:** el precio se actualiza en la lista, con IGV incluido. Si el nuevo
precio queda por debajo del piso mínimo de ese producto, aparece un aviso amarillo — pero el
precio se guarda igual (el piso solo se aplica al vender, no a la lista).

## 2. Precio de lista — historial

**Qué probar:** que cualquier cambio de precio de lista queda a la vista, no solo en la
auditoría.

1. Sobre el mismo producto del caso 1, click en «Historial».

**Resultado esperado:** una tabla con cada cambio — fecha, quién lo hizo, si vino de una
edición manual o de una carga masiva, y el precio antes/después. El cambio que se acaba de
hacer aparece primero.

## 3. Carga masiva de precios — plantilla

1. En **Catálogo**, botón «Cargar precios de lista».
2. «Descargar plantilla».

**Resultado esperado:** un archivo con dos columnas, `SKU` y `PRECIO CON IGV`, con dos filas
de ejemplo.

## 4. Carga masiva — un archivo con errores

1. Editar la plantilla descargada: dejar una fila con un SKU que no existe en el catálogo, y
   duplicar el SKU de otra fila.
2. Subir el archivo.

**Resultado esperado:** una tabla de vista previa muestra cada fila con su estado — las que
tienen error, en rojo, con el motivo (SKU inexistente, SKU duplicado, precio inválido). El
botón «Confirmar» queda deshabilitado mientras haya algún error. **Nada se guarda todavía.**

## 5. Carga masiva — confirmar y revertir

1. Corregir el archivo del caso 4 (o armar uno nuevo) con SKU válidos y precios correctos.
2. Subir, revisar la vista previa (nuevos, cambiados, sin cambio, avisos).
3. «Confirmar».
4. Verificar en **Catálogo** que los precios cambiaron.
5. Volver a la pantalla de carga y click en «Revertir este lote».

**Resultado esperado:** paso 3 actualiza todos los precios del archivo de una sola vez (o
ninguno, si algo falla). Paso 5 devuelve **todos** los precios del archivo a como estaban
antes de esa carga — verificable en **Catálogo** y en el «Historial» de cada producto tocado.

## 6. Precio de lista al cotizar

**Qué probar:** que la lista efectivamente ahorra trabajo al vendedor, sin atarle las manos.

1. Elegir un producto que tenga precio de lista (de los casos anteriores).
2. Empezar una cotización nueva y agregar ese producto como línea.

**Resultado esperado:** el precio de la línea se prellena con el precio de lista. El
vendedor lo puede cambiar a mano sin ningún problema — la lista solo sugiere.

## 7. Una cotización ya emitida no cambia de precio sola

1. Emitir una cotización con al menos una línea de un producto con precio de lista.
2. Cambiar el precio de lista de ese producto (caso 1).
3. Volver a la cotización ya emitida y revisar sus líneas.

**Resultado esperado:** el precio de las líneas de la cotización **no cambió**, aunque el
precio de lista del producto sí. Una cotización emitida es un compromiso con el cliente, no
una referencia al catálogo vivo.

## 8. Emisión electrónica apagada (solo si el dueño quiere verificarlo en `demo`)

**Contexto:** mientras dura la migración desde la otra app, `production` tiene la emisión
electrónica apagada a propósito — el ERP solo registra comprobantes manuales (los que ya
salieron en papel). `demo` sigue con la emisión electrónica habilitada para poder
practicar el flujo completo.

**Qué probar en `production`:** que los botones de emisión electrónica (Emitir y enviar al
PSE, Reintentar envío, Consultar al PSE, Dar de baja, Emitir guía de remisión) aparecen
**deshabilitados**, con un aviso al pasar el mouse: «Emisión electrónica no habilitada en
este entorno». El registro manual de comprobantes sigue funcionando sin ningún cambio.
