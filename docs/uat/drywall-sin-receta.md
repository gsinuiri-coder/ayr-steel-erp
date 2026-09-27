# Guion UAT — Drywall sin receta, ancho del accesorio y notas de crédito por línea (D-344 a D-346)

Para correr en **demo** (copia de producción) o en producción después de la ventana. Cada paso dice
qué mirar y qué tiene que salir. En producción, **mirar y no pulsar** salvo los pasos marcados con ✍
(escriben datos).

## 0. Antes de nada: los 10 perfiles de drywall están «sin espesor»

En producción los 10 perfiles activos **no tienen espesor** cargado, así que, hasta que se cargue,
salen **«Sin espesor en el SKU: sin piso»** y **no se puede abrir una orden** para ellos. Es lo
esperado: ver §2 para cargarlo. Además, tres traen datos de relleno (`PERFILH`, `PERFILU` y
`R39GALV090`: ancho 1.00 mm y 1.000 kg) que también hay que corregir.

## 1. Catálogo → Drywall: el formulario de producto

1. **Catálogo → Productos → Drywall → Nuevo producto** (o **Editar** un perfil).
2. Los campos son: **Espesor del fleje (mm)**, **Ancho del fleje — desarrollo (mm)**, **Largo de la
   pieza (mm)** y **Peso de la pieza (kg)**. **No hay campo «Acabado»**: drywall es siempre
   galvanizado.
3. El ancho es **el de la tira de acero de la que sale el perfil** (su desarrollo), no el del perfil
   terminado. Con un OMEGA de 115 mm de fleje, 3 000 mm de largo y 0.45 mm de espesor, el peso sale
   cerca de 1.22 kg.
4. **Sin espesor no guarda:** «El espesor del fleje es obligatorio en Drywall».
5. **Aviso de peso:** escribir ancho `1.00`, largo `6000`, espesor `0.45` y peso `1.000` → debajo del
   peso aparece «⚠ Se aleja … % del teórico (… kg con este ancho, largo y espesor): revisa los cuatro
   datos. Se guarda igual.» Corregir el ancho a `115` y el largo a `3000` (y el peso a `1.220`) → el
   aviso desaparece. **Es un aviso: no bloquea.**
6. En la lista del catálogo, un perfil con el peso fuera del teórico lleva la misma marca ámbar bajo
   su nombre.
7. Ya **no existe la acción «Receta»** en el menú ⋯ de un perfil.

## 2. Cargar el espesor y corregir los perfiles ✍ (lo hace el dueño)

1. Para cada uno de los 10 perfiles: **Editar** → escribir el **espesor del fleje**. (No se infiere
   del código del SKU: lo carga el dueño.)
2. Corregir **ancho y peso** de `PERFILH`, `PERFILU` y `R39GALV090`.
3. Al guardar cada uno, el aviso rojo «Sin espesor en el SKU: sin piso» debajo del nombre desaparece.
   Si el peso no cuadra con el teórico, aparece el aviso ámbar del paso 1.

## 3. Piso de precio de un perfil (cotización) — por SKU

1. **Ventas → Cotizaciones → Nueva**, línea de negocio Drywall, elegir un perfil ya completo.
2. Con **flejes galvanizados del mismo espesor y ancho con saldo**: la línea muestra el **precio
   mínimo** y una cotización por debajo se rechaza (piso duro de D-163).
3. **Sin flejes compatibles** (hoy, en producción, no hay ningún fleje): la línea dice **«Sin flejes
   compatibles: sin piso»** y **no bloquea** la cotización.
4. Un perfil al que le falta espesor, ancho o peso dice el motivo correspondiente («Sin espesor en el
   SKU: sin piso», «Sin ancho del fleje en el SKU: sin piso», «Sin peso por pieza: sin piso de
   precio»).
5. Si la línea de negocio no tuviera margen mínimo configurado, dice **«Sin margen configurado para la
   línea: sin piso»** (antes lo confundía con la falta de flejes).
6. **Mostrador:** sigue exento del piso.

## 4. Planta: producir un perfil sin receta ✍

Requiere un fleje galvanizado del espesor y ancho del perfil (de un corte tercerizado).

1. **Planta → Nueva orden de perfiles (drywall)**. El selector lista los perfiles **con el SKU
   completo** (`SKU — nombre (ancho mm)`), **no** las recetas. Si hay perfiles activos incompletos,
   una nota dice cuántos no aparecen y por qué.
2. Crear la orden. Un perfil sin espesor no se puede abrir: «… no tiene espesor en el SKU: cárgalo en
   el catálogo antes de producirlo».
3. Montar un fleje: solo los del **acabado galvanizado, espesor y ancho exactos** del SKU. Con otro
   ancho, otro espesor —aunque sea 0.01 mm de diferencia— u otro acabado, el error nombra los tres
   datos: «no es compatible con el perfil: se necesita un fleje de acabado galvanizado, 0.45 mm de
   espesor y 115.00 mm de ancho (los datos del SKU)».
4. Reportar piezas y cerrar: el costeo del cierre y la merma funcionan **como antes** (salen del
   kardex de los flejes montados y del peso del SKU).
5. **Con la orden en curso**, editar el catálogo y cambiar el **espesor, el ancho, la unidad o el
   origen** del perfil → «El producto tiene N orden(es) de producción en curso: ciérralas o anúlalas
   antes de cambiar…». El peso, el nombre y el precio sí se editan.
6. **Orden de corte (Corte → Nueva):** el ancho de cada fleje del plan se elige por perfil y sale del
   **ancho del fleje del SKU**.

## 5. Accesorios: ancho del SKU frente al de la bobina (D-345) ✍

1. Producir un accesorio con una bobina montada **de ancho distinto** al del SKU (por ejemplo, SKU a
   1 220 mm y bobina de 1 000 mm).
2. Reportar metros. El reporte se guarda igual y en el **Historial de auditoría** de la orden queda el
   aviso: «La bobina montada … mide 1000.00 mm de ancho y el SKU … declara 1220.00 mm: los kilos que
   reservó el pedido y el piso de precio salieron del ancho del SKU, y el kardex sale con el de la
   bobina».
3. Con el mismo ancho no hay aviso.

## 6. Notas de crédito por línea (D-346) ✍

1. Un pedido con una línea de 100 unidades facturada por completo (factura emitida).
2. Emitir una **nota de crédito parcial** sobre esa línea, por 40 unidades.
3. **Facturar de nuevo** esa línea: ahora deja hasta **40**; pedir 41 se rechaza con «le quedan 40.000
   por facturar». Antes de este cambio se frenaba aunque la NC ya estuviera emitida.
4. Una NC **total** deja la línea otra vez pendiente completa. Una NC **anulada o en borrador** no
   cuenta: sigue frenando.
5. En el detalle del pedido, el avance facturado por línea coincide con lo anterior.

## 6b. Editar un accesorio sin tocar espesor, color ni subtipo (M5, D-343) ✍

1. **Catálogo → Coberturas Aluzinc** → **Editar** un accesorio (`ACCES…`).
2. Cambiar solo el **nombre** o el **precio de lista** y **Guardar cambios**: se guarda normal, sin
   rebote. (Antes de esta corrección, cualquier edición rebotaba con «El SKU … refleja el espesor y
   el color del accesorio…», aunque no se tocara ninguno de los dos.)
3. **Editar** de nuevo y cambiar el **espesor**: ahí sí rebota con el mismo mensaje — el SKU lo
   refleja y sigue sin poder cambiar.

## 6c. Borrar un producto que nunca se usó (M6, D-347) ✍

1. **Catálogo → Productos**, cualquier línea. En la fila de un producto **recién creado, sin
   cotizaciones, pedidos, compras, comprobantes, kardex ni producción detrás**, abrir el menú **⋯**:
   al final, en rojo, **«Eliminar»**.
2. Confirmar: el diálogo nombra el SKU y avisa que no tiene reversa. **«Borrar `<SKU>`»** lo hace
   desaparecer de la lista para siempre (no queda como inactivo).
3. En un producto **con historia detrás** (una cotización, un pedido, kardex…), **«Eliminar»** sale
   **deshabilitado** en el menú, con el motivo al pasar el mouse. La forma correcta de retirarlo sigue
   siendo **Desactivar**.
4. Si algo se salta el botón (por ejemplo, un intento directo contra el API), el borrado también se
   rechaza con un mensaje que dice **qué** lo está usando (por ejemplo, «1 línea(s) de cotización»).

## 7. Lo que NO debe haber cambiado

- Cotizar, reservar y despachar drywall con stock propio (los perfiles reservan producto terminado).
- Las coberturas (plancha, a medida, accesorio): piso, reservas y producción.
- El total del pedido sigue topado por lo facturado neto (D-223).
- **Desactivar** un producto sigue siendo reversible y sigue protegiendo su historia; borrar es la
  acción nueva y separada, solo para lo que nunca se usó.
