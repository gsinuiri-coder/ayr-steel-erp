# Plantilla de precios de lista (D-217/RF-S1/M1c)

`precios-de-lista.csv`: carga masiva del precio de lista del catálogo, vía
`Catálogo → Cargar precios de lista` (solo ADMINISTRADOR).

## Columnas

| Columna          | Qué va                                                                            |
| ---------------- | --------------------------------------------------------------------------------- |
| `SKU`            | Código del producto, tal como está en el catálogo.                                |
| `PRECIO CON IGV` | Precio de venta **con IGV** (D-162). El sistema deriva y guarda el valor sin IGV. |

## Cómo se valida

- **SKU desconocido, precio ≤ 0 o no numérico, SKU duplicado dentro del archivo**: fila en
  `ERROR`. Cualquier `ERROR` bloquea confirmar el lote entero.
- **Precio por debajo del piso de D-163, o SKU sin costo en el kardex**: fila en `WARNING`.
  No bloquea — el piso solo prellena la línea nueva de una cotización, nunca la lista.
- Un SKU que existe en **más de una línea de negocio** también es `ERROR`: el archivo no trae
  con qué distinguir a cuál de los dos se refiere (el SKU es único por línea, no global).

## Revertir un lote

Cada carga confirmada queda con un `batchId` propio. El botón «Revertir este lote» solo está
disponible en la pantalla, inmediatamente después de confirmar; el historial de cada SKU
(«Historial» en el catálogo) también muestra de qué lote salió cada cambio. Revertir se
rechaza si algún SKU del lote tuvo un cambio de precio **posterior** — corrige ese SKU a mano
o vuelve a cargar un archivo nuevo.

`apps/web/public/plantillas/precios-de-lista.csv` es la copia servida por el botón de
descarga de la pantalla; este archivo es la fuente documentada. Mantenerlos iguales.
