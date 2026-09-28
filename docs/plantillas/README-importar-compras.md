# Importar compras (D-351, D-352, D-359)

Plantilla: `importar-compras.xlsx` (vacía) y `importar-compras-ejemplo.xlsx` (los cuatro tipos de
compra). Las dos se descargan también desde **Compras → Importar compras** (`/compras/importar`).

Se importan compras **posteriores al inventario inicial**. Cada comprobante entra como una compra
**en BORRADOR**, por el alta normal: recibirla (lo que crea las bobinas y mueve el kardex) sigue
siendo el paso de siempre, compra por compra.

## Formato

- **Una fila por línea.** Las filas se agrupan en comprobantes por **RUC + tipo de comprobante +
  serie-número**; las columnas de cabecera se repiten igual en todas las filas del comprobante (si
  una fila trae otra cosa, el preview avisa y toma la de la primera fila).
- **Todas las celdas son texto.** La fecha va como `DD/MM/AAAA` (nunca como número de Excel ni
  mes/día/año). Los decimales aceptan coma (`3,20`) o punto (`3.20`); `1.234,56`, `1,234.56` y
  `1.234.567` también se leen. **Una sola coma es siempre decimal** (`3,745` es 3.745, no 3 745).
  Si una celda viene como número de Excel (por ejemplo, pegada desde otro sistema), se lee igual.
- Encabezados exactos de la plantilla (sin importar tildes ni mayúsculas). Hasta 1 000 filas por
  archivo y 200 líneas por comprobante.

### Cabecera (se repite en cada fila del comprobante)

| Columna                   | Obligatoria  | Valores                                                                                                                                                    |
| ------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TIPO DE COMPRA            | sí           | `Bobinas`, `Producto terminado`, `Servicio`, `Gasto`                                                                                                       |
| LÍNEA DE NEGOCIO          | sí           | `Drywall`, `Coberturas Aluzinc`, `Coberturas UPVC`, `Reventa`, `Servicios`                                                                                 |
| TIPO DE COMPROBANTE       | sí           | `Factura` o `Boleta` (una nota de crédito o débito no se importa)                                                                                          |
| SERIE-NÚMERO              | sí           | `F001-00012345`, tal como dice el papel                                                                                                                    |
| FECHA DE EMISIÓN          | sí           | `DD/MM/AAAA`; no futura ni anterior al inicio de la carga histórica                                                                                        |
| RUC PROVEEDOR             | sí           | 11 dígitos                                                                                                                                                 |
| MONEDA                    | sí           | `PEN` o `USD`                                                                                                                                              |
| TIPO DE CAMBIO            | en USD       | si falta, se usa el de SUNAT de la fecha de emisión y el preview lo muestra                                                                                |
| CONDICIÓN DE PAGO         | sí           | `Contado` o `Crédito`                                                                                                                                      |
| DÍAS DE CRÉDITO           | con crédito  | 1 a 365                                                                                                                                                    |
| TIPO DE SERVICIO          | en servicios | `Corte`, `Flete`, `Aduanas`, `Seguro`, `Otro`                                                                                                              |
| TASA IGV                  | no (18)      | una sola por comprobante: `18`, `18%` o `0.18` (una celda con formato de porcentaje); `0` = exonerado                                                      |
| OBSERVACIONES             | no           | se juntan las de todas las filas                                                                                                                           |
| TOTAL COMPROBANTE CON IGV | no           | **el total del papel, con IGV. Si viene, manda** (ver «Importes: el papel manda»). La plantilla anterior lo llamaba `TOTAL COMPROBANTE` y se sigue leyendo |

### Línea

| Columna                 | Bobinas                                                                  | Producto terminado        | Servicio / gasto     |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------- | -------------------- |
| SKU                     | no                                                                       | **sí** (de la línea)      | no                   |
| DESCRIPCIÓN             | opcional (se arma sola)                                                  | opcional (nombre del SKU) | **sí**               |
| CANTIDAD                | — (van los KG)                                                           | **sí**                    | **sí**               |
| UNIDAD                  | `KGM`                                                                    | la del SKU si va vacía    | `NIU` si va vacía    |
| PRECIO UNITARIO SIN IGV | **sí** (por kilo), o el importe                                          | **sí**, o el importe      | **sí**, o el importe |
| IMPORTE SIN IGV         | opcional: el valor de la línea del papel; **si viene, manda**            | igual                     | igual                |
| CÓDIGO DE ACABADO       | **sí** (de la línea de la compra)                                        | no                        | no                   |
| COLOR                   | opcional: si contradice al acabado, es error (el color sale del acabado) | no                        | no                   |
| ESPESOR MM / ANCHO MM   | **sí**                                                                   | no                        | no                   |
| KG                      | **sí**                                                                   | no                        | no                   |
| CÓDIGO EXTERNO          | opcional (el del proveedor; pasa a la bobina al recibir)                 | no                        | no                   |

## Importes: el papel manda (D-359)

Un comprobante es un documento legal: sus importes no se recalculan, se copian.

- **La línea:** si trae **IMPORTE SIN IGV**, ese es su valor y el precio unitario se deriva de él. Si
  trae solo el precio, se usa con **todos sus decimales** (500 × 0.144068 = 72.034, no 500 × 0.1441).
  Si trae los dos y no se parecen, es error de la fila (una columna pegada donde no iba).
- **El total:** **TOTAL COMPROBANTE CON IGV** se compara con valor + IGV recalculados. Una diferencia de
  redondeo (hasta S/ 0.10, o más en líneas de miles de kilos: la misma tolerancia que el importador de
  cotizaciones) se absorbe en el IGV de la última línea y la compra queda **con el total exacto del
  papel**. Una diferencia mayor es error del comprobante, con las dos cifras con IGV.
- **Al recibir,** el kardex entra por el **valor sin IGV** de la línea (× tipo de cambio en dólares), al
  céntimo; el costo por kilo o por unidad se deriva de ese valor.

## Qué revisa el preview

- **Proveedor:** por RUC. Si no está en el maestro y el padrón lo conoce, se muestra «Nuevo — se
  creará desde padrón: <razón social>» con un **código corto sugerido** (3 a 6 letras, el primer
  segmento del código de cada bobina: no se puede cambiar después), que se puede corregir ahí mismo.
  Si el padrón no responde, se crea con el alta de proveedor desde la misma pantalla.
- **Duplicado:** el mismo comprobante del mismo proveedor ya registrado en una compra viva → error.
- **Inventario inicial:** si la serie-número coincide con la «factura de referencia» de la carga
  inicial, el comprobante no se confirma hasta marcar **«Es otra compra»** (la carga no guardó el
  proveedor, así que el sistema no puede saberlo solo). La marca queda en la auditoría del lote. Si
  la fecha de emisión es anterior a la carga inicial, solo avisa.
- **SKU:** activo y de la línea de la compra; si es de otra línea, error. **Acabado:** activo,
  completo y de la línea de la compra. El producto y el acabado **no** se crean desde el
  importador de forma silenciosa: el producto se crea con el alta de siempre desde el campo.

## Confirmar y deshacer

Confirmar crea todas las compras o ninguna (si un comprobante falla, se dice cuál y no entra
nada). Cada importación es un **lote**: «Deshacer lote» (solo administrador) anula por el servicio
las compras del lote que sigan en borrador y sin pagos; las ya recibidas se nombran y no se tocan.
