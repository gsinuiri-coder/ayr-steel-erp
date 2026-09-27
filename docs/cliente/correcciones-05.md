# Correcciones 05 del cliente — 27 de septiembre de 2026

Texto íntegro del cliente, tal como llegó. Las capturas no se versionan (muestran datos reales):
están en `local-data/corr05/` del checkout principal.

1. quiesiera poder ver en los pedidos a que factura esta asociado. en la tabla y detalles o tu reco.

2. ver en los comprobantes el despacho asociado, en la tabla y detalle. o tu reco

3. en la tabla de bobinas el metro lineal teorico es del peso y no del disponible.

4. Reporte mensual de bobinas, solo es de 2 estados, abiertas y selladas. las otras no, como
   anuladas o terminadas o otro si hubiese.

5. quiero que priorices este tipo de reporte, ponlo en donde creas que deba ir, grill si es
   necesario, adjunto foto

## Capturas

| Archivo                           | Qué muestra                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reporte-ventas-material.png`     | Planilla de ejemplo del punto 5: filas «coberturas», «accesorios», «bobinas» y «planchas» (espesor 0.30, color rojo) bajo «ventas general»; columnas espesor, color, ml vendido, peso teórico del ml, peso real (producciones), costo prod total, utilidad, cost x kg compra, cost x kg venta, margen x kg; y la nota «modal cuantas bobinas para cob y acc, y pl (independiente o desglosado)». |
| `bobinas-ml.png`                  | Punto 3: la tabla de Bobinas con «Metro lineal teórico» calculado sobre el disponible (p. ej. 206.325 kg disponibles → 55.080 m sobre un peso de 4 544 kg).                                                                                                                                                                                                                                      |
| `inventario-bobinas-por-tipo.png` | Punto 3: Inventario → Coberturas Aluzinc, tabla «Bobinas por tipo» (tipo, descripción, ítems, físico, reservado, disponible, costo prom., valorizado), sin metro lineal.                                                                                                                                                                                                                         |

## Dónde quedó cada punto

| Punto | Milestone | Estado   | Dónde |
| ----- | --------- | -------- | ----- |
| 1     | M4        | En curso |       |
| 2     | M5        | En curso |       |
| 3     | M3        | En curso |       |
| 4     | M2        | En curso |       |
| 5     | M1        | En curso |       |
