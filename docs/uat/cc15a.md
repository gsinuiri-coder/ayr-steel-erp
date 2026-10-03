# Guion de prueba: cc15a (D-372, sesión 2, primera parte)

Para el dueño, con usuario **administrador**, en demo (http://127.0.0.1:3101). Todo se hace desde
el detalle de una compra recibida → **⋯ → Editar compra** → **Revisar cambios** → motivo →
**Guardar cambios**.

## 1. Corregir el precio de una bobina ya consumida

Elegir una compra de bobinas cuya bobina ya tuvo producción o merma (por ejemplo, una de la
FACTURA 118-315630 o de la E001-262).

1. Cambiar el **precio unitario** y **Revisar cambios**.
2. Esperado en la revisión:
   - el camino dice **«Ajuste sobre lo que queda»**;
   - debajo: «Quedan X de esta compra: ajuste de S/ Y con la fecha de hoy», donde Y = diferencia
     de la línea en soles × lo que queda / lo comprado;
   - la lista **«Ya salió al costo anterior (no se recalcula)»** con cada OP, despacho o merma,
     su fecha, cantidad y costo;
   - los avisos: los márgenes no se recalculan; deshacer con consumo entre medio no deja todo
     idéntico; el costo por kg de la bobina cambia también en los **reportes mensuales de
     bobinas ya pasados**.
3. Guardar. Esperado:
   - en el kardex de la bobina, las salidas conservan su costo y aparece un **ajuste de costo**
     con la fecha de hoy por Y;
   - el saldo de la bobina queda valorizado al precio nuevo;
   - la ficha de la bobina y la línea de la compra muestran el precio nuevo;
   - si la bobina ya estaba **cerrada** (sin saldo), no hay ajuste: solo cambian la compra y la
     ficha, y la revisión lo dice (quedan 0).

## 2. Deshacer

1. Volver a editar con el **precio anterior**.
2. Si no salió material entre las dos ediciones: el saldo vuelve exacto al costo de antes.
3. Si salió material entre medio: la revisión lo lista con el costo corregido, y lo que queda
   vuelve al precio anterior; lo que salió entre medio conserva el corregido (es lo que dice el
   aviso).

## 3. Lo que sigue bloqueado con consumo

- Cambiar la **cantidad** o el **producto** de una línea consumida: **Bloqueado**, con las
  operaciones que la movieron.
- Una línea de producto terminado cuyo producto volvió a entrar por **otra compra** posterior y
  sin consumo: **Bloqueado** («disponible en la próxima versión», cc15b).
- Con reserva y sin consumo: sigue bloqueada (cc15b).

## 4. Anular después de un cambio de producto

En demo, con una compra de producto terminado **intacta**:

1. Cambiar el **producto** de la línea. La revisión muestra también **Descripción → nombre del
   producto nuevo**.
2. Registrar y recibir **otra compra** del producto **viejo**.
3. **Anular** la primera compra. Esperado: se anula (antes se rechazaba con «ya tiene
   movimientos posteriores»), revierte el ingreso del producto nuevo y no toca el viejo.

## 5. Cáscara

- Pasar una compra al crédito a **Contado**: la revisión muestra **Días de crédito → —** y
  **Vencimiento → —**.
- Cambiar la **fecha de emisión** de una compra al crédito: la revisión muestra el
  **Vencimiento** recalculado.
- Una compra con una **serie vieja** fuera del formato actual deja corregir el precio sin tocar la
  serie.
