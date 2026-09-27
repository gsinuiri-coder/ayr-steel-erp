# Guion UAT — Correcciones 03b: confirmar con faltante, piso del drywall, accesorios y formularios (D-341 a D-343)

Para correr en **demo** (copia de producción) o en producción después de la ventana. Cada paso dice
qué mirar y qué tiene que salir. En producción, **mirar y no pulsar** salvo los pasos marcados con ✍
(escriben datos; usarlos solo con un cliente y un producto de prueba que el dueño elija).

## 1. Confirmar con faltante (D-341) — solo administrador

Preparación: una cotización **emitida** de una cobertura a medida (o de un producto con stock) que
pida **más material del que hay disponible**. Cotizar sin stock nunca bloqueó: lo que bloqueaba era
confirmar.

1. Entrar como **vendedor**, abrir la cotización y pulsar **Confirmar**. El diálogo muestra el
   faltante línea por línea («faltan X kg») y el botón **Confirmar** queda apagado. **Igual que
   antes.**
2. Entrar como **administrador**, abrir la misma cotización y pulsar **Confirmar**. El diálogo
   muestra el faltante en un recuadro ámbar («Falta material: el pedido se confirma con
   faltante»). El botón dice **Confirmar con faltante** y sigue apagado hasta **marcar la casilla**
   «Entiendo que falta material…» y **escribir un motivo** (mínimo 5 caracteres). ✍
3. Confirmar. El pedido nace con el badge **Con faltante** junto al estado, un aviso con el
   faltante **por espesor y color** (por ejemplo «21.200 kg de 0.50 mm · Rojo») y, en la tabla de
   **Reservas**, la cantidad reservada con «faltan X» debajo. Las **órdenes de producción se crearon
   igual** (menú **⋯** → **Producir**).
4. **Panel:** aparece la tarjeta **Pedidos con faltante** con el pedido y lo que le falta. Solo la ve
   el administrador.
5. **Historial de auditoría** del pedido (enlace **Historial**): la confirmación trae el **motivo** y
   el faltante por línea (prometido, reservado, faltante).

## 2. Completar la reserva ✍

1. Hacer que aparezca el material que faltaba (registrar la compra de la bobina, o liberar la
   reserva temporal de otra cotización que lo tenía).
2. En el pedido, menú **⋯** → **Completar reserva**. Escribir qué material llegó y confirmar.
3. Si alcanza todo: el badge **Con faltante** desaparece, la tarjeta del Panel deja de listar el
   pedido y la reserva sube a la cantidad completa. Si alcanza solo una parte, el faltante baja por
   lo que se reservó y el pedido sigue **Con faltante**.
4. Si **todavía no hay material nuevo**, el sistema lo dice («Todavía no hay material disponible
   para completar la reserva») y **no cambia nada**.
5. **No se crean órdenes nuevas** (ya existían). Anular el pedido, o liberar la reserva, también
   cierran el faltante.

**Lo que no cambia:** un vendedor no puede confirmar con faltante (si lo intenta por otra vía
recibe «Solo un administrador puede confirmar con faltante»); una **bobina entera** sin saldo sigue
bloqueando a todos.

## 3. Costo mínimo del drywall (D-342)

Preparación: el dueño carga las recetas de los perfiles (Catálogo → Drywall → **Receta**) con el
**peso por pieza** en el producto.

1. **Catálogo → Drywall.** Un perfil **sin receta activa** trae debajo del nombre el aviso ámbar
   **«Sin receta: sin piso de precio»**. Uno con receta y con flejes en almacén no trae aviso.
2. **Cotización nueva**, elegir un perfil **con receta**: debajo del precio aparece **«Mínimo: S/ …»**
   (peso de la pieza × costo por kilo de los flejes, con el margen de Administración → Márgenes).
   Escribir un precio menor lo pone en rojo «por debajo» y el guardado lo rechaza con el mínimo
   exacto.
3. Elegir un perfil **sin receta**: debajo del precio dice **«Sin receta: sin piso de precio»** y se
   puede guardar el precio que se quiera (sin costo no hay piso). Un perfil con receta pero **sin
   flejes con saldo** dice **«Sin costo de flejes: sin piso»**.
4. **Coberturas de aluzinc:** el piso por metro se calcula igual que antes (desde la bobina). Nada
   cambió ahí.
5. **Mostrador:** sin cambios (sigue exento del piso).

## 4. Accesorios (D-343)

1. **Catálogo → Coberturas Aluzinc → Nuevo producto.** En **Subtipo** elegir **Accesorio**: la
   unidad pasa a **MTR**, desaparece el largo, y el **SKU** se forma solo con el espesor y el
   acabado (`ACCES` + espesor de 3 dígitos + color, por ejemplo `ACCES030ROJO`) y queda de solo
   lectura. ✍ (guardar solo con un producto de prueba)
2. Un accesorio existente no permite cambiar el espesor, el color ni el subtipo (el SKU los
   refleja): para otro espesor u otro color se crea otro accesorio.
3. **Cotización nueva**, elegir el accesorio: la línea **no tiene editor de largos**. La cantidad son
   los **metros lineales de bobina** que se van a usar (editable), hay un campo **Piezas
   (informativo)** y la descripción se escribe a mano. La cantidad de piezas **no cambia el
   importe**: probar cambiarla y ver que el total no se mueve.
4. Al guardar, la cotización reserva **materia prima**: en el detalle, «Reserva» dice los kilos de
   ese espesor y color (metros × kilos por metro del ancho completo de la bobina, con el 1 % de
   merma normal adentro).
5. Confirmar, y en **Planta** abrir la orden del accesorio: en vez del editor de largos hay una
   tarjeta **Reportar metros de bobina** con **Metros de bobina usados**, **Piezas (opcional)** y
   **kg consumido (opcional)**. Reportar los metros; «ML reportado» sube. ✍
6. Reportar **más metros de los que pidió el pedido**: se guarda igual y queda el aviso «rindió más
   de lo planeado» en el reporte (no bloquea).
7. **Reportar y cerrar** (o **Cerrar sin reportar más**) cierra la orden con el despunte de siempre
   (los kilos declarados menos los teóricos). El producto terminado entra al kardex **en metros**.
8. **Importador de cotizaciones:** una línea de accesorio ya no pide largos.

## 5. Formularios alineados (D-293, segunda tanda)

Abrir cada uno y comprobar que **ningún campo se pisa con otro**, que los rótulos y los campos
quedan alineados en la misma fila y que no aparece scroll horizontal, a 1366 y a 1920 px:

1. **Administración → Acabados → Nuevo acabado.**
2. **Catálogo → Colores → Nuevo color.**
3. **Catálogo → Drywall →** menú de un perfil **→ Receta.**
4. **Compras → Nueva compra**, con tipo **Bobinas** y con otro tipo (encabezado y líneas).

## 6. Regresiones a mirar

1. Una cotización de **cobertura a medida** sigue pidiendo su detalle de largos y sumando los metros.
2. Una **plancha de catálogo** sigue cotizando por metro con su largo fijo.
3. Confirmar una cotización **con material suficiente** se comporta exactamente como antes
   (sin casilla ni motivo).
4. Una compra nueva, un despacho y un comprobante se registran como siempre.
