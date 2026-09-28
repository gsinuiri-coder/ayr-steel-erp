# Guion UAT — Correcciones 06: bobinas que se terminan solas y rentabilidad por factura (D-360, D-361)

Para correr en **demo** (copia de producción, levantada con `pnpm dev:demo`, que desde C06 escucha solo en
`127.0.0.1`) o, lo marcado **[lectura]**, en producción después de la ventana. En producción no se pulsa nada
que escriba.

## 1. Rentabilidad de cada comprobante (D-361)

1. **[lectura]** Como **administrador**, abrir **Comprobantes → FFA1-00001352** (coberturas, agosto). Debajo
   de «Líneas» hay una sección **Rentabilidad** con el aviso «Ventas por material y la Rentabilidad de cada
   factura costean con los kilos de bobina consumidos…».
2. La línea `COB030ROJO` 226,8 m: venta S/ 2 210,34, costo S/ 1 800,64, utilidad S/ 409,70, margen 18,54 %;
   peso real 626,004 kg; por kilo 3,5309 / 2,8764 / 0,6545; por ML 9,7458 / 7,9393 / 1,8064; costo por
   unidad 7,9393; **Base de costo** «Kilos de bobina consumidos» con la bobina `SALDO-ALZ-ROJO-3020-0.28-4549-2`;
   estado **Completo**.
3. Chequeos de la fila: utilidad = venta − costo; margen = utilidad ÷ venta; por kilo = ÷ peso real; por ML =
   ÷ metros; costo por unidad = costo ÷ cantidad.
4. **[lectura]** **FFA1-00001321** (seis bobinas enteras): cada línea `BOB…` con su bobina en «Base de costo»,
   costo S/ 3,43 por kilo; total venta S/ 84 745,76, costo S/ 84 676,41, margen 0,08 %.
5. **[lectura]** **FFA1-00001356** (reventa de UPVC): las tres líneas con **Base de costo** «Salida del
   despacho (costo promedio)» `DES-000004`; por kilo y por ML en «—» (no hay kilos ni metros); total venta
   S/ 9 728,81, costo S/ 8 199,97, margen 15,71 %.
6. En demo, una factura de reventa **sin despacho declarado**: la línea dice **Sin costo aún** — «Sin
   despacho declarado en este comprobante (D-205)» —, el costo no es 0 y «Venta sin costo» al pie la
   muestra.
7. Una factura con **nota de crédito**: debajo aparece «Acreditado por FC…» con sus líneas (una línea que no
   es de Coberturas Aluzinc resta la venta con costo 0) y la fila **Neto**.
8. Como **vendedor**: el detalle del comprobante **no** muestra la sección; la ruta
   `/api/reports/documents/<id>/profitability` responde **403**.

## 2. Ventas por material: columnas por metro lineal y costo por unidad (D-361)

1. **[lectura]** **Reportes → Ventas por material**, **agosto 2026**: columnas nuevas **Precio/ML venta,
   Costo/ML, Ganancia/ML, Costo prom./unidad**. Coberturas: 9,8568 / 8,2483 / 1,6086 por ML; costo por
   unidad 8,2483 /m. Planchas: costo por unidad 53,3118 /u. El **Total** muestra «—» en el costo por unidad
   (mezcla metros, piezas y kilos).
2. El aviso nuevo, igual que en la sección y en **Ventas y margen**.
3. **Descargar Excel**: las mismas cuatro columnas; donde no hay divisor, «—» (nunca 0 ni vacío).
4. **Cuadre:** la rentabilidad de cada comprobante de agosto, sumada en Coberturas Aluzinc, da el total del
   reporte: venta S/ 282 766,69, costo S/ 250 239,23, 84 038,310 kg (verificado en la ventana).

## 3. La bobina se termina sola en 0 kg (D-360)

En **demo** (escribe):

1. Una bobina vigente con saldo: **Registrar merma** por **todo** su saldo → la bobina queda **Terminada**; en
   su historial, «Terminada automáticamente: merma de … (D-360)». El kardex tiene solo la merma (ningún
   ajuste de cierre).
2. **Anular esa merma** → la bobina vuelve a **vigente** con sus kilos, sola.
3. Otra bobina: merma por el saldo **menos 0,001 kg** → sigue **vigente** con 0,001 kg.
4. Una orden de coberturas de un pedido: montar una bobina, reportar, y mientras la orden está en curso la
   bobina no se termina aunque quede en 0. **Cerrar la orden** consumiendo el rollo entero → la bobina queda
   **Terminada**. **Reabrir la orden** → la bobina vuelve a vigente con los kilos del despunte.
5. **Vender una bobina entera** y despacharla → **Terminada** (como antes, D-170), sin aviso de anomalía.
6. **Partir** una bobina por todo su saldo → la madre **Terminada**; **revertir el partido** → vuelve a
   vigente.
7. Una bobina terminada sola en la que planta encuentra material: **Reabrir bobina terminada** (sin motivo,
   no hay ajuste que revertir) → **Terminar** declarando los kilos que quedan → entran al kardex como
   sobrante, con motivo.

**[lectura]** En producción: **Bobinas → Terminadas** incluye las 27 que se terminaron el 28-09 (lote
`964e7464-2684-4103-8d0a-f5ecc836c693`); ninguna bobina **vigente** tiene 0 kg; el **reporte mensual de
bobinas** de agosto y septiembre da los mismos saldos que antes (la tabla la decide el saldo, no el estado).
