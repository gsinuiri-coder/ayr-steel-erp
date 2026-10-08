# Revisión de segundo modelo — cc33 corte 1

Modelo: Sonnet, contexto limpio. Alcance: `git diff origin/main...origin/cc33-correcciones`
(11 archivos, commit `637ae0a2`). No corrió tests.

**Veredicto: sin P0 ni P1.** El cambio hace lo que dice y no rompe ningún caso legítimo. Hay 2 P2
y 3 P3.

## Comprobado

- **Pago cruzado de moneda.** Una compra en USD pagada en soles usa `rateCurrency = USD`: conserva el
  TC del input o el de SUNAT. Una compra en PEN pagada en USD usa el TC del input. Solo cambia el
  caso PEN con PEN, que guarda 1.
- **Web, pago.** `crossCurrency` sigue mostrando el campo. El envío usa el mismo criterio y no
  pierde el TC legítimo.
- **Importador.** En PEN descarta el TC con advertencia (`purchase-import-validate.ts:252-257`).
  `resolveExchangeRate` se llama solo con `USD` (`purchase-import.service.ts:305`).
- **Edición de compra recibida y landed cost.** Solo leen `purchase.exchangeRate`; ninguna ruta lo
  modifica.
- **Schema.** `toDecimal('1.0000').eq(1)` acepta `1`, `1.0000` y ausente; rechaza `0.9999` y
  `3.75`.
- **CLI de solo lectura.** Corre en `SET TRANSACTION READ ONLY`, sin argumentos ni modo execute.
  Solo hace `findMany` y `count`, llama a `assertExternalOutputsOff` y no imprime credenciales.
  La fórmula del exceso es correcta.
- **Tests.** `createInTx` prueba la defensa interna con TC 3.75. `addPayment` afirma el
  `data.exchangeRate` real. El E2E verifica el costo de la bobina en la base (`4000.0000`).

## Hallazgos

### P2-1. Los borradores en PEN ya guardados con TC ≠ 1 se reciben con ese TC

La recepción usa `purchase.exchangeRate` guardado (`purchases.service.ts:661, :691`). Un borrador
anterior al arreglo, en PEN con TC 3.75, entraría al kardex ×3.75 si se recibe después del
despliegue. Se sugiere usar 1 en la recepción cuando la compra es en PEN, o revisar con
`inspect:cc33` que no exista ninguno.

### P2-2. El schema rechaza y el servicio corrige en silencio

Por HTTP, la corrección silenciosa es inalcanzable: el usuario ve el 400. Una pestaña con el
bundle viejo (la API se despliega antes que la web) recibiría un 400 por un campo que no ve.
Es transitorio. Conviene comprobar en la UAT que el error se muestra.

### P3-1. `purchaseCreate.livePurchases` mal nombrado en el CLI

La variable `firstDays` cuenta todas las compras vivas, no las del día 1 o 2. Hay que borrarla o
implementarla.

### P3-2. El neto del kardex depende de `refType: 'PURCHASE'`

Es una estimación. Hay que contrastarla con un caso real antes de usarla para decidir.

### P3-3. Faltan casos equivalentes en el test del schema

Faltan `1.0000` y `0.9999`.

## Qué se hizo con cada hallazgo

| Hallazgo | Resolución                                                                                                                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1     | Corregido. `assertPenRateIsOne` (D-534) rechaza con 409 recibir, recalcular un borrador o editar una recibida de una compra en soles grabada con TC ≠ 1. No repara datos: en producción hay 0 casos (diagnóstico del 2026-10-08), y el diagnóstico se repite antes del despliegue. |
| P2-2     | Sin cambio de código. El formulario muestra el error del API en la raíz (`form.setError('root')`): una pestaña vieja ve «Una compra en soles va con tipo de cambio 1». Queda en la UAT.                                                                                            |
| P3-1     | Corregido: se quitó la variable.                                                                                                                                                                                                                                                   |
| P3-2     | Corregido: el JSON lo aclara (`note`); los movimientos de reversa y de `replaceEntry` conservan `refType: 'PURCHASE'`.                                                                                                                                                             |
| P3-3     | Corregido: casos `1.0000` y `0.9999`.                                                                                                                                                                                                                                              |
