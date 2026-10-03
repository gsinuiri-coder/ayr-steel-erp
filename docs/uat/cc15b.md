# Guion de prueba: cc15b (D-372, sesión 2, segunda parte)

Para el dueño, con usuario **administrador**, en demo (http://127.0.0.1:3101). Todo se hace desde
el detalle de una compra recibida → **⋯ → Editar compra** → **Revisar cambios** → motivo →
**Guardar cambios**.

## 1. Compra con reserva activa (punto 3)

Elegir una compra de **producto terminado** cuyo producto tenga un pedido que lo reserva y que
no haya tenido salidas después de la compra (en la foto de producción eran F001-00043612,
E001-1731, F001-00043848 y E001-2427; en demo pueden haber cambiado).

1. Cambiar el **precio**. Esperado: **Reversa y nuevo ingreso**, guardable. Después, el saldo del
   producto tiene el costo corregido y la reserva del pedido sigue **activa**.
2. Cambiar la **cantidad** a menos de lo reservado. Esperado: **Bloqueado**: «Con la cantidad
   nueva quedarían X y hay Y reservados…».
3. Una cantidad que **sí** cubre la reserva se guarda.
4. Si el producto tiene existencias de **otras compras**, la revisión avisa: deshacer puede dejar
   el costo promedio a ±0,0001.

## 2. Otra compra posterior del mismo producto (punto 4)

Una compra de producto terminado cuyo producto volvió a entrar por **otra compra** después, sin
ventas ni consumos (en producción, la línea 1 de E001-1766).

1. Cambiar el precio. Esperado: **Reversa y nuevo ingreso**; después, el promedio del producto
   pondera el precio corregido con el de la otra compra.
2. Cambiar el **producto** de esa línea: sigue **Bloqueado** (el cambio de producto no pasa por el
   reemplazo).

## 3. Bobina que respalda material prometido (puntos 3 y 5)

Una compra de bobina **sin usar** cuyo color y espesor tengan cotizaciones o pedidos a medida que
prometen ese material.

1. Cambiar el **precio**: pasa (no mueve kilos).
2. Bajar los **kilos** por debajo de lo prometido: **Bloqueado**, con el pedido: «…con la cantidad
   nueva esa promesa quedaría sin cubrir».
3. Cambiar el **acabado a otro color** (o el espesor fuera de la tolerancia): **Bloqueado**: «No se
   puede cambiar el color o el espesor porque esta bobina respalda material comprometido de
   PED-…».

## 4. Deshacer

Volver a editar con el valor anterior. En una bobina, el saldo y el costo vuelven exactos. En un
producto con otras existencias, a ±0,0001 como máximo.

## 5. Lo que no cambia

- Con **consumo** (ventas, producción, mermas), el precio sigue por **Ajuste sobre lo que queda**
  (cc15a) y la cantidad sigue bloqueada.
- El **cambio de producto** sigue con reversa e ingreso nuevo, y la reserva que la reversa deje sin
  cubrir lo bloquea.
