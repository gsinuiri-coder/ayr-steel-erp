# UAT — Correcciones post-RF-S4b (2026-09-24)

En `demo`. Los pasos 1 y 2 también se pueden mirar en production, cancelando siempre. Ningún
paso confirma ni emite, salvo el 3, que es solo para `demo`.

## 1. El selector de bobina no nombra cotizaciones ajenas (D-267)

Hacen falta dos vendedores (A y B) y una bobina atada a una cotización abierta de A (por
ejemplo, una venta de bobina completa cotizada por A).

1. Entrar como **A**. Abrir una cotización suya con un producto `BOB…` del mismo espesor y color
   y usar **Convertir en venta de bobina** (o, en un pedido, **Cambiar bobina**).
   **Esperado:** «No se ofrecen: <bobina> (atada a COT-…)», con el código de su cotización.
   Cancelar.
2. Entrar como **B** y hacer lo mismo en una cotización o un pedido de B.
   **Esperado:** «No se ofrecen: <bobina> (no disponible)». No aparece ningún código COT-….
   Cancelar.
3. Entrar como **ADMINISTRADOR**. **Esperado:** «atada a COT-…», como A.

## 2. Cotizar por metro una plancha importada por plancha (D-268)

1. Abrir una cotización importada abierta con una línea de plancha que dice «por plancha, como
   se cotizó» y entrar a **Editar**.
2. Debajo del precio, **Cotizar por metro**. **Esperado:** un recuadro con el precio por metro
   equivalente («S/ X por metro (equivalente a S/ Y por plancha)») y «Total de la línea sin
   IGV: antes → después», con cuatro decimales. **Cancelar** no cambia nada.
3. Otra vez **Cotizar por metro** → **Pasar a por metro**. El campo pasa a «Precio por metro»,
   con el valor equivalente, y el importe de la línea es el que decía el recuadro.
4. **Deshacer: volver a por plancha**. El campo vuelve a «Precio unitario… por plancha, como se
   cotizó» con su precio de antes.
5. Solo en `demo`: pasarla a por metro y **Guardar cambios**. **Esperado:** el importe
   guardado es el que mostró el recuadro, nunca `× largo` del precio por plancha.

## 3. Facturar en dos borradores por mitades (D-269 a)

Solo en `demo`, sobre un pedido importado con una línea de trío (como el de COT-000002):

1. Crear una factura en borrador por la mitad de los kg de la línea. **No emitirla.**
2. Crear otra factura en borrador por la otra mitad.
3. **Esperado:** la suma de los dos borradores es exactamente el importe, el IGV y el total de
   la línea del pedido (en COT-000002: 12 439.83 / 2 239.17 / 14 679.00).
