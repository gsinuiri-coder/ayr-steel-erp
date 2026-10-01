# Diagnóstico: la línea 2 de BBV1-00000341 (AUTOPERF10X1) y el despacho de comprobantes anteriores a la entrada del stock — 2026-10-01

**Solo diagnóstico y propuesta (D-374).** No hay código de producto ni escrituras. Se apoya en una
foto de producción tomada en una transacción `READ ONLY`, con el OK del dueño, el **2026-10-01 a las
11:48 UTC**. El JSON completo quedó en `local-data/despacho-pre-inventario/insp-production.json`,
fuera de git porque trae datos reales. El script de un solo uso se validó antes contra
`ayr_local_e2e` y se borró al terminar. Acá no se transcriben clientes ni importes de venta.

## 1. Resumen

- **El negativo del 03/08 no se debe al inventario inicial.**
  - La carga inicial (`IMPORT`) está fechada el **01/08**, no el 15/09: D-285 la movió (ver
    `docs/analisis/comprobantes-sin-despacho-2026-09-29.md`).
  - Además, `AUTOPERF10X1` y `AUTOPERF12X212` **no están en ella**: no tienen ninguna entrada
    `IMPORT`. Su única fuente de stock son las compras.
- **No falta ninguna compra.**
  - `AUTOPERF10X1`: entraron 700 (NF1-1 100, NF1-2 500, NF1-3 100) y salen 700 (341 100, 347 500,
    FFA1-00001378 100).
  - `AUTOPERF12X212`: entraron 500 (F001-00043612) y salen 500 (347).
- **La causa es la fecha de recepción de las compras.** Las cuatro se registraron el 28/09, después
  del día D, y su recepción no quedó con la fecha de la compra:
  - **NF1-1**, emitida el **03/08**, la misma fecha que 341 y por las mismas 100 unidades, se recibió
    con fecha **27/09**.
  - **NF1-2** (14/08) se recibió con fecha 18/08.
  - **F001-00043612** (12/08) se recibió con fecha 27/09.
  - Con esas fechas, el 03/08 no hay stock de `AUTOPERF10X1`.
- **Ya hubo una corrección de fechas el 29/09** (`fix:purchase-received-dates`,
  `docs/analisis/fechas-recibidas-compras-2026-09-29.md`):
  - **NF1-1 quedó excluida** porque moverla al 03/08 la pondría antes de la salida del 17/08
    (FFA1-00001378) y «podría recostearla».
  - **F001-00043612 sí se corrigió al 12/08, pero se deshizo a los 7 minutos.** El lote apuntaba a
    otro comprobante (FFA1-00001389) que estaba anulado.
- **Recomendación (D-374).** La salida va a la fecha del comprobante. Si ese día no hay stock porque
  la recepción de la compra quedó con la fecha de digitación, **primero se corrige la fecha de
  recepción** con la herramienta existente y después se despacha a la fecha del comprobante. Solo si
  aun así no alcanza, se despacha en la **primera fecha válida posterior** (D-364), nunca antes. La
  regla de la carga inicial (`BEFORE_OPENING` de D-285) no cambia.

## 2. Kardex de AUTOPERF10X1 (desde el 01/08)

Todos los movimientos del ítem; no hay ninguno antes del 17/08.

| Fecha (operación) | Movimiento | Cant. | Saldo | Origen                                                                            |
| ----------------- | ---------- | ----: | ----: | --------------------------------------------------------------------------------- |
| 17/08             | Entrada    |   100 |   100 | Compra NF1-3 (emitida 17/08), recibida el 28/09 con fecha 17/08                   |
| 17/08             | Salida     |   100 |     0 | DES-000036 de FFA1-00001378 (17/08), PED-000045, despacho a fecha del comprobante |
| 18/08             | Entrada    |   500 |   500 | Compra NF1-2 (emitida 14/08), recibida el 28/09 con fecha 18/08                   |
| 27/09             | Entrada    |   100 |   600 | Compra NF1-1 (emitida **03/08**), recibida el 28/09 con fecha **27/09**           |

**¿En qué fecha deja de ser negativa la línea 2 (100)?**

- Sola, con el kardex de hoy: el **18/08**. Ese día el saldo es 500 y queda en 400.
- Pero comparte stock con 347 línea 1 (500 del 14/08). Las dos juntas suman 600, que es exactamente
  el saldo final. Si 341 sale el 18/08, 347 L1 no cabe hasta el 27/09, y al revés.

**Precio de las tres compras.** Según sus totales de auditoría (5,50 / 100, 27,50 / 500 y
5,50 / 100), las tres tienen el **mismo costo por unidad**. Mover NF1-1 al 03/08 la pondría antes de
la salida del 17/08, pero **no cambiaría el promedio** con que esa salida se valorizó. El «riesgo de
recosteo» que la excluyó el 29/09 era una exclusión conservadora (toda compra con una salida
posterior), no un efecto medido. El dry-run de la herramienta lo vuelve a calcular antes de
ejecutar.

### AUTOPERF12X212

| Fecha | Movimiento       | Cant. | Origen                                                                |
| ----- | ---------------- | ----: | --------------------------------------------------------------------- |
| 12/08 | Entrada          |   500 | F001-00043612, corrección de fecha del 29/09 13:20 (lote `2266f71a…`) |
| 12/08 | Salida (reversa) |   500 | Undo del mismo lote, 29/09 13:27                                      |
| 27/09 | Entrada          |   500 | Recepción original, 28/09 con fecha 27/09                             |
| 27/09 | Salida (reversa) |   500 | Reversa de la recepción original al corregir (29/09 13:20)            |
| 27/09 | Entrada          |   500 | Reingreso al deshacer (29/09 13:27)                                   |

Saldo: 0 hasta el 27/09 y 500 desde entonces. La salida de 347 L2 (14/08) recién cabe el **27/09**.

## 3. Cómo se despacharon los demás comprobantes (jul–sep)

- **53 líneas despachadas de 42 comprobantes**, todas por el despacho a la fecha del comprobante
  (D-278/D-285/D-364) y todas con salida en el kardex.
- **32 salieron en la fecha de emisión.** Incluye todo el UPVC de agosto, que sí está en la carga
  inicial del 01/08, y FFA1-00001378 de `AUTOPERF10X1`, que salió el 17/08 de NF1-3.
- **21 salieron después de la emisión, entre el 15/09 y el 28/09.** Son todas coberturas, planchas y
  un accesorio **fabricados**. D-285 las fecha en `max(emisión, último parte de producción)`: es la
  regla de lo producido, no un problema de stock.
- **Ninguna otra línea tiene el problema de 341/347.** Las únicas líneas pendientes en producción son las 4
  líneas de 341 (anulado) y 347. 341 L1 (`UPVC36MT` 12, 03/08) cabe a su fecha: está en la carga
  inicial del 01/08 y la salida no deja negativo.

## 4. Propuesta D-374: fecha de despacho de un comprobante anterior a la entrada del stock

Regla. Se evalúa línea por línea, en el orden de los comprobantes:

1. **Ítem en la carga inicial y comprobante anterior a ella** (antes del 01/08): `BEFORE_OPENING`
   de D-285, sin cambios. Se entrega sin salida, porque esa mercadería ya no estaba al contar.
   **Impacto hoy: ninguna línea pendiente.**
2. **El stock existe a la fecha del comprobante:** la salida va a esa fecha. Es la regla del dueño:
   todo comprobante tiene su salida en el kardex con su fecha.
3. **No existe porque la compra que lo trae se recibió con la fecha de digitación**, posterior a la
   emisión de la compra, que es anterior o igual al comprobante. Primero se corrige la **fecha de
   recepción** de esa compra con `fix:purchase-received-dates`: dry-run, respaldo, OK del dueño por
   compra y undo disponible. Después se despacha a la fecha del comprobante.
   - **Cambio a la herramienta:** una compra con una salida posterior deja de excluirse si el dry-run
     demuestra que el **costo promedio de esa salida no cambia**. Por ejemplo, todas las entradas del
     ítem con el mismo costo unitario, como en NF1-1.
   - Si cambia, sigue excluida y se pasa al punto 4.
4. **Si aun así no alcanza** (la fecha de recepción real es posterior al comprobante, o la compra no
   se puede mover): la salida va en la **primera fecha válida posterior** que calcula el plan
   (D-364), con motivo. Nunca antes de que el stock exista, y nunca forzando un negativo.

### Impacto medido sobre los pendientes

**Hoy, sin mover nada (solo D-364):**

| Línea                   | Cant. | Fecha del comprobante | Fecha de salida             |
| ----------------------- | ----: | --------------------- | --------------------------- |
| 341 L1 `UPVC36MT`       |    12 | 03/08                 | **03/08** (cabe)            |
| 341 L2 `AUTOPERF10X1`   |   100 | 03/08                 | 18/08                       |
| 347 L1 `AUTOPERF10X1`   |   500 | 14/08                 | 27/09 (si 341 sale primero) |
| 347 L2 `AUTOPERF12X212` |   500 | 14/08                 | 27/09                       |

**Con D-374 punto 3:**

- Se mueven **NF1-1 al 03/08** (su emisión) y **F001-00043612 al 12/08** (ya fue «segura» el 29/09).
- **NF1-2 se deja en el 18/08** (lo registrado). Si el dueño confirma que llegó el 14/08, también se
  mueve y 347 L1 sale el 14/08.

| Línea                   | Cant. | Fecha de salida                                                                                             |
| ----------------------- | ----: | ----------------------------------------------------------------------------------------------------------- |
| 341 L1 `UPVC36MT`       |    12 | **03/08**                                                                                                   |
| 341 L2 `AUTOPERF10X1`   |   100 | **03/08** (saldo 100 → 0)                                                                                   |
| 347 L1 `AUTOPERF10X1`   |   500 | **18/08**: primera fecha válida, con NF1-2 recibida el 18/08 (saldo 500 → 0). Con NF1-2 al 14/08, **14/08** |
| 347 L2 `AUTOPERF12X212` |   500 | **14/08** (saldo 500 → 0)                                                                                   |

En los dos casos el saldo final no cambia (`AUTOPERF10X1` 0, `AUTOPERF12X212` 0) y no hay ningún
día negativo. La salida del 17/08 (FFA1-00001378) sigue igual y con el mismo costo.

## 5. Qué decide el dueño

1. **Aprobar D-374** tal como está en §4, o con cambios.
2. **Fechas reales de recepción:** NF1-1 (¿03/08?) y NF1-2 (¿14/08 o 18/08?). Son las que el papel
   o el almacén pueden confirmar; la herramienta usa la emisión de la compra como destino.
3. **Orden en la próxima ventana:**
   1. el deploy de cc07;
   2. reactivar 341;
   3. despachar 341 L1 a su fecha;
   4. corregir las fechas de compra (D-374, con dry-run y OK por compra);
   5. despachar 341 L2 y 347.

   Hasta que D-374 se apruebe e implemente, **341 L2 y 347 no se despachan**.

## 6. PED-000048 (para la reactivación de 341)

En la misma foto:

- **Sin ediciones de líneas** del pedido después de la anulación de 341 (06:19 UTC): el bloqueo
  nuevo de D-373 no aplica.
- **Sin borradores** en el pedido. El borrador del reingreso que mostraba la foto de las 09:26 UTC
  ya no está, así que el requisito §0.2 del runbook figura como hecho. **Verificarlo en la
  interfaz** antes de reactivar.

## 7. Numeración

D-374 se reservó para esta propuesta y su fila de `docs/ARQUITECTURA.md` §0.2 se escribió al aprobarla
(ver §8), igual que con D-373.

## 8. Aprobación y aplicación (ventana cc07, 2026-10-01)

**D-374 aprobada por el dueño** y registrada en `docs/ARQUITECTURA.md` §0.2. El dueño confirmó estas
fechas reales:

- NF1-1 se recibió el 03/08.
- NF1-2 se queda en el 18/08.
- F001-00043612 no se toca.

Qué pasó en la ventana:

- **341 se despachó completo el 18/08** (DES-000052), con una fecha elegida en el campo.
  **Corrección (cc09):** sin `?despacho=` el campo arranca igual en la fecha del comprobante (D-285).
  El 18/08 fue la «primera fecha válida» de la línea 2, no un default.
- **La herramienta de fechas excluye NF1-1.** Corregir NF1-1 al 03/08 (punto 3) habría exigido
  cambiar la herramienta, porque excluye toda compra con una salida posterior, y NF1-1 ya tenía dos
  (17/08 y 18/08). El dueño eligió **no cambiarla** y aplicar el punto 4: **347 L1 y L2 salieron el
  27/09** (DES-000053), su primera fecha válida.
- **Fotos `READ ONLY`, antes (13:43 UTC) y después (13:58 UTC):**
  - ninguna salida existente cambió de costo (`AUTOPERF10X1` 0,055, `AUTOPERF12X212` 0,1441,
    `UPVC36MT` 43,2203);
  - no hay días negativos;
  - no queda ninguna línea facturada sin despacho en todo el sistema.

**Sobre F001-00043612.** La corrección al 12/08 (29/09, 13:20:32 UTC) y su undo (13:27:56 UTC) los
hizo la CLI `fix:purchase-received-dates` con la cuenta administradora del dueño, en la ventana de
fechas del 29/09, con su OK. Era parte de un lote de seis compras corregidas para poder despachar
FFA1-00001389. Ese comprobante resultó **anulado**, así que el despacho no procedía y se deshizo el
lote entero (`docs/analisis/fechas-recibidas-compras-2026-09-29.md`). La compra sigue recibida con
fecha 27/09. Como el dueño decidió no tocarla, 347 L2 salió en esa fecha.

**Pendientes:**

1. Hoy 341 tiene su salida el 18/08 y no el 03/08 de su comprobante. Llevarla al 03/08 exige:
   - revertir DES-000052, que es append-only;
   - corregir NF1-1 con la herramienta ampliada;
   - volver a despachar.

   Solo se hace si el dueño lo decide.

2. El cambio de la herramienta del punto 3 (aceptar una salida posterior cuando su costo no cambia)
   no está implementado.
3. ~~**UI:** la fecha sugerida del despacho depende de `?despacho=`~~ **Descartado en cc09.** El
   default ya es la fecha del comprobante. El cambio que lo forzaba se descartó: no movía ninguna
   salida y además marcaba el despacho como «fecha elegida», con lo que D-288 dejaba de re-fecharlo.
   Ese mismo defecto existe en el camino `?despacho=` de D-373 y se corrige en el PR de cc10.
