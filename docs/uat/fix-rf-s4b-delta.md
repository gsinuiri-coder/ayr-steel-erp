# UAT — Correcciones del delta RF-S4b (2026-09-24)

En `demo` (o production, con cuidado: solo mirar y cancelar). Ningún paso confirma ni emite.

## 1. Plancha importada, guardada sin tocar el precio (D-263, ya en production)

1. Abrir una cotización importada abierta que tenga una línea de plancha (`PL…6M…`) y entrar a
   **Editar**.
2. El campo de precio de esa línea dice **«Precio unitario»** y debajo **«por plancha, como se
   cotizó»** (no «por metro»).
3. Cambiar solo las **Observaciones** (sin borrar la primera línea «Factura externa: …») y
   **Guardar cambios**.
4. **Esperado:** el importe de cada línea y el total no cambian. En «Cambios de precio» no
   aparece ninguna fila nueva.
5. Volver a editar, cambiar la cantidad de planchas de una línea y guardar. **Esperado:** el
   importe nuevo es `cantidad × precio por plancha`, nunca `× largo`.

## 2. La bobina atada se ve (M6)

1. Abrir COT-000002. Bajo el SKU `BOB038AZUL` de la línea se lee **«Bobina
   SALDO-ALZ-AZUL-5002-0.38-4194-7»**.
2. Lo mismo en un pedido con una línea de venta de bobina.
3. En una cotización importada con un producto `BOB…`, **Convertir en venta de bobina**: debajo
   del disponible del pool aparece **«No se ofrecen: … (atada a COT-000002)»** para la bobina
   que ya vende otra cotización abierta. Cancelar.
4. En un pedido, **Cambiar bobina**: la misma explicación arriba del selector. Cancelar.

## 3. Factura y NC en partes cierran con el papel (D-265)

Solo en `demo`. Sobre un pedido importado con una línea de trío (p. ej. el de COT-000002 si se
confirmó en demo): facturar la mitad de los kg, registrarla a mano; facturar la otra mitad.
**Esperado:** la suma de las dos facturas es exactamente el importe, el IGV y el total del
papel (en COT-000002: 12 439.83 / 2 239.17 / 14 679.00).
