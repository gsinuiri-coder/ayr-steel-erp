# cc51 corte A — revisión del segundo modelo (Sonnet, contexto limpio)

Alcance: `git diff origin/main...cc51-a-auditoria` (13 archivos), solo lectura.

Resumen: P0 ninguno · P1 ninguno · P2 ninguno · P3 4.

- D-639 correcto: el registro está en la misma transacción; la prueba de rollback es real (registro
  forzado a fallar después de las reversas de kardex; la compra sigue recibida y los movimientos no
  cambian). Cubre monto y flejes, borrador, anulación repetida y una compra que no es de corte.
- D-640: no toca texto libre y elige el enum correcto según la acción; pantalla y Excel comparten
  `auditValueText`.

P3 (anotados):

1. Los booleanos anidados salen «Sí/No» dentro del JSON (es lo pedido).
2. `value` y `kind` anidados se traducen por nombre en cualquier acción; hoy ningún emisor choca.
3. Los prefijos generales (`cutting.`, `invoicing.`) traducirían mal una acción nueva con otro enum;
   falta un centinela que recorra las acciones reales.
4. La serie F995 del caso H1 de `seed:escenarios` (no choca: el número es único por corrida).
