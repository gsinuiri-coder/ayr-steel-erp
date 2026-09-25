# UAT — Corregir la fecha de emisión re-fecha el despacho (D-288)

Se prueba en **demo** (copia de production del 25-09 con FFA1-00001386 ya re-fechado), como
ADMINISTRADOR. Ninguno de estos pasos se hace en production.

## 1. El caso real ya corregido

1. Abrir **Comprobantes → FFA1-00001386**. Emisión **19/08/2026**.
2. Abrir **Kardex** de «TC5 UPVC ROJO 1.5 MM X 1.075 X 6.00 MT». Hay una salida de 50 u el
   **19/08** y, el **19/09**, la salida vieja y su anulación (mismo importe): el saldo del 19/09
   queda igual que antes de ese par.
3. **Descargar PEPS (SUNAT 13.1)** de septiembre: la salida y la anulación del 19/09 suman cero;
   el saldo final es igual al inicial. En agosto, la salida del 19/08.

## 2. Corregir la fecha con despacho a la fecha del comprobante

1. En un pedido de prueba con un comprobante **manual** y su despacho hecho con **Despachar a la
   fecha del comprobante**, abrir el comprobante → **Más acciones → Corregir fecha de emisión**.
2. Poner una fecha anterior y un motivo. Aparece el aviso **«DES-… se despachó a la fecha del
   comprobante (…)»** con la casilla **Re-fechar también el despacho a la fecha nueva**,
   marcada.
3. **Corregir**. El despacho viejo queda **revertido** y hay uno nuevo con la fecha nueva; el
   kardex muestra la salida nueva y el par viejo neto el mismo día.
4. Repetir desmarcando la casilla: solo cambia la fecha del comprobante; el despacho no se toca.
5. Si la fecha nueva deja el kardex negativo (la mercadería entró después), el sistema lo dice y
   **no cambia nada**, ni siquiera la fecha.

## 3. Despacho con fecha propia

Con un despacho registrado a mano (no con el botón), el diálogo solo avisa **«DES-… tiene fecha
propia: no se tocan»** y no ofrece re-fechar.

Nota: si el stock del producto es justo, el saldo corrido del kardex puede mostrar un negativo
de paso **dentro** del día viejo, entre la salida y su anulación; al cierre del día es correcto.
