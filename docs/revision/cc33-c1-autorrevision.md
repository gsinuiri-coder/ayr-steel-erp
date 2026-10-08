# Autorrevisión cc33 corte 1

> **Autorrevisión**, no pase cruzado: es una lista de riesgos, no una aprobación. La hizo un
> subagente que no implementó el cambio ni leyó su handoff. Alcance:
> `origin/main...origin/cc33-correcciones` (11 archivos, commit `637ae0a2`).

## Resumen

El arreglo de N1 se sostiene para lo que entra de ahora en adelante:

- el alta rechaza con 400 en el schema, y `resolveExchangeRate` y `createInTx` fuerzan 1;
- el importador ya ignoraba el TC en soles, y ahora `createInTx` además fuerza 1;
- el pago guarda 1 cuando `rateCurrency === PEN`;
- la web limpia el TC y no lo manda.

Los pagos cruzados de moneda siguen usando el TC del input. USD contra USD queda igual que antes:
sin TC, el API pide el de SUNAT, que no cambia el saldo. Sin P0 ni P1.

## Hallazgos

- **P2-1.** Los borradores y las compras recibidas en soles ya grabados con TC ≠ 1 siguen
  propagando el TC guardado. Lo leen la recepción, `writeDraftTotals` (D-371), la edición de la
  compra recibida (D-372) y el landed cost o el costo de corte de un servicio. Sugerencia: correr
  el CLI antes del despliegue y poner una defensa (usar 1 o rechazar con 409).
- **P2-2.** El CLI sumaba compras anuladas y borradores en «totalPen de más». Sugerencia: separar
  por estado.
- **P3-1.** La cifra de kardex es un tope del impacto, no un saldo vivo. Las bobinas hijas de un
  partido heredan `coil.exchangeRate` y no se listan.
- **P3-2.** Una variable del CLI tenía nombre y comentario engañosos (`firstDays`).
- **P3-3.** El CLI compara la fecha del pago ya resuelta, no la tipeada. El comentario decía otra
  cosa.
- **P3-4.** La limpieza del E2E fallaba en silencio: la compra con pago no se anula.
- **P3-5.** USD contra USD depende del TC SUNAT aunque no afecte el saldo. Ya pasaba antes; no es
  una regresión.

## Verificado y sin hallazgo

- **Pagos.** El `exchangeRate` del pago solo se lee en `purchaseBalance` → `toPurchaseCurrency`, y
  el estado de cuenta usa el TC de la compra.
- **Web.** Ambos formularios coinciden con el criterio de `crossCurrency`. El flujo XML no fija el
  TC y no existe «duplicar compra».
- **Schemas de edición.** No aceptan moneda ni TC.
- **Tests.** Cada guard tiene su test, y el test falla si se quita.
- **CLI.** Es de solo lectura y no imprime credenciales.

## Qué se hizo con cada hallazgo

| Hallazgo | Resolución                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| P2-1     | Corregido con `assertPenRateIsOne` (D-534): 409 en recibir, recalcular el borrador y editar la recibida. En producción hay 0 casos. |
| P2-2     | Corregido: solo suman las recibidas, con un conteo por estado.                                                                      |
| P3-1     | Aclarado en el JSON (`note`).                                                                                                       |
| P3-2     | Corregido: se quitó la variable.                                                                                                    |
| P3-3     | Corregido: comentario.                                                                                                              |
| P3-4     | Corregido: el test anula el pago y registra la compra de pantalla para la limpieza.                                                 |
| P3-5     | Sin cambio (no es una regresión).                                                                                                   |
