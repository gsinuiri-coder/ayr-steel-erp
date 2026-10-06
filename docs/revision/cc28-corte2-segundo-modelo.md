# Revisión de segundo modelo, cc28 corte 2

**Esto es una revisión de un modelo (Sonnet, contexto limpio), no una revisión humana.** No sustituye
la revisión del dueño al cierre de la entrega. El revisor no escribió este código.

## Alcance

`git diff origin/main...HEAD` de la rama `cc28-corte2` (30 archivos, `main` = fc1c8347):

- Reporte de ventas y margen: fila `roundingPen` (API `sales-margin.service.ts`, esquema `report.ts`,
  web `ventas-margen-view.tsx`, Excel `reports-xlsx.ts`).
- Panel: «Facturado del mes» y `billedPen`.
- Descarga por `fetch` (`download.ts`, `HeaderActions`).
- Buscador de cotizaciones y pedidos: `searchSeqOf(search, prefix)`, `compactInvoiceNumber`,
  prefiltro de `idsByInvoiceNumber`.
- Pista de otras bobinas montadas en el rechazo por tolerancia.
- Cambios de «cambios sin guardar» (despacho nuevo, `draftFingerprint`).
- Pruebas nuevas y cambiadas (unitarias y E2E).

Método: lectura del diff y del código que lo rodea, y corrida de los unitarios tocados
(`search-seq`, `sales-margin.service`, `other-mounted-coils-hint`, `imported-invoice-d387`, y los del
web `download` y `admin-dashboard`): todos en verde. No se corrió E2E, build ni servidor.

## Conclusión

No hay P0 ni P1. La aritmética de `roundingPen` es correcta para notas de crédito, pedidos excluidos
y líneas sin costo (verificado abajo). Los hallazgos son de limpieza de datos del E2E, consistencia
de la sesión en la descarga y casos límite de texto.

## Verificado sin defecto

- **`roundingPen` con notas de crédito:** `signedSubtotal` y `lineSales` o `lineTotals` aplican el
  mismo signo (`NOTA_CREDITO` = −1); el redondeo de una nota sale con signo propio y la identidad
  `Σ pestañas + «Sin línea» + roundingPen = salesPen` se mantiene.
- **Pedidos excluidos (`!inTotals`):** solo aportan a `totalSales` la venta de Servicios, y lo hacen
  con `addNoCostSales`, que suma al mismo tiempo en `lineTotals` las mismas cifras de línea. No
  generan redondeo ni lo esconden.
- **Líneas sin costo (Servicios, «Sin línea»):** `lineTotals` las incluye, así que cuentan en la
  resta. En una pestaña de línea (`viewLine !== undefined`) vale `0`.
- **Panel:** `assembleAdminDashboard` copia los campos uno a uno, así que `roundingPen` no se filtra
  al DTO del Panel. `billedPen` = `salesPen + excludedSalesPen + untraceableSalesPen` es igual a Σ de
  `signedSubtotal` de todos los comprobantes, que es lo que suma el gráfico.
- **Selectores E2E:** ningún spec busca «Facturado por día (sin IGV)», «Facturado del mes» ni «Redondeo
  al céntimo».
- **Tipos de rechazo con código:** la pista solo se agrega con `TOLERANCE_OVERRIDE_REQUIRED`; el texto
  no contiene «motivo», así que no activa los `/motivo/i` de planta. El código se atiende antes.
- **Descargas:** todos los endpoints del repo mandan `Content-Disposition: attachment`, así que
  forzar `a.download` no cambia el comportamiento de los PDF.

## Hallazgos

### SM-1 — P2 — El E2E de redondeo deja la venta de mostrador en la base y no limpia si falla

`e2e/tests/reportes-por-linea-cc23.spec.ts` (bloque nuevo, justo antes de `getJson` de `bad`, y
`await purgeSalesTrail(api, { orderIds })` unas líneas después).

- `purgeSalesTrail` anula el pedido con `.catch(() => undefined)`. La venta de mostrador nace
  despachada y con boleta emitida: anularla como pedido normal no es el camino (el resto de los
  specs de POS usan `voidPosSale(api, sale.id)`; ver `fase7b.spec.ts`). Si el `cancel` es
  rechazado, el error se traga y la boleta, el despacho y el movimiento de kardex quedan en la base de
  E2E, dentro del rango de todos los reportes de ese día.
- La limpieza va después de los `expect`, fuera de `try/finally`: si cualquier aserción cae
  (incluida la nueva `roundingPen` distinta de cero) la venta queda siempre.
- Efecto: contamina los totales que otros specs leen con `getJson` de reportes (ventas-margen,
  Panel) y el próximo `roundingPen` ya no parte de cero.

Corrección: guardar `sale.id`, envolver el bloque en `try/finally` y anular con `voidPosSale`
(o confirmar que `cancel` de pedido sirve para una venta de mostrador y entonces quitar el
`.catch` que lo esconde). Verificar con una base fresca que, tras la corrida, `roundingPen` vuelve a
`0.0000`.

### SM-2 — P2 — `downloadFile` no reintenta con el refresh del token; el resto del web sí

`apps/web/src/lib/download.ts:36-37`.

`api()` (`apps/web/src/lib/api.ts`) y la hoja de planta (`plant-sheet-buttons.tsx`, que lo comenta
expresamente) reintentan una vez tras `POST /api/auth/refresh` cuando reciben 401. `downloadFile`
llama a `fetch` una sola vez. Escenario: el usuario trabajó en una pantalla con datos ya cargados y
el token de acceso venció; al pulsar «Descargar Excel» recibe 401 y el aviso dice «Unauthorized»
(o el mensaje del API), aunque una sola llamada de refresh lo habría resuelto. Con el `<a href>` de
antes pasaba igual (se abría el JSON), así que no es una regresión, pero el cambio existe justamente
para que el rechazo sea manejable y deja esta rama sin cubrir. Falta además `cache: 'no-store'`
(lo que sí pasan `api()` y la hoja de planta).

Corrección: reutilizar la lógica de `tryRefresh` (exportarla de `api.ts`) y reintentar una vez en 401;
añadir `cache: 'no-store'`; un caso en `download.spec.ts`.

### SM-3 — P3 — La descarga no da señal de progreso y permite descargas duplicadas

`apps/web/src/components/header-actions.tsx:130-137`, `download.ts`.

El Excel de hasta 5000 filas puede tardar varios segundos. Mientras `fetch` corre no hay estado
pendiente en el enlace (a diferencia de los botones con `pending`, regla de AGENTS.md §6): quien
vuelve a hacer clic dispara otra consulta pesada y, al terminar, dos archivos. Corrección: un guard por
`href` en vuelo (un `Set` de módulo) y un `toast.loading` o `aria-busy`.

### SM-4 — P3 — La fila «Redondeo» absorbe cualquier diferencia, no solo el céntimo

`apps/api/src/reports/sales-margin.service.ts:599-604`, `ventas-margen-view.tsx:279-290`,
`reports-xlsx.ts:239-250`.

`rounding = totalSales − Σ lineTotals.sales` es una resta, no una medida del redondeo. Un
comprobante vigente sin líneas de venta (o con líneas que `salesLinesByDocument` no trae) hace que la
fila muestre su subtotal entero con la etiqueta «Redondeo al céntimo de los comprobantes» y la nota
«líneas de más de dos decimales», que dejaría de ser cierta. No se encontró un caso real en el código
revisado, pero el diseño no lo detecta. Corrección: acotar en el servicio (si `|rounding| > 0.01 ×
cantidad de comprobantes` no etiquetarlo como redondeo, o registrar un aviso), o dejar un test que
fije la cota.

### SM-5 — P3 — La pista de otra bobina no sale en el caso más probable (bobina agotada)

`apps/api/src/production/roofing-production.service.ts:1159-1177`.

La pista solo se agrega si `mounted.code !== undefined`, es decir, con `TOLERANCE_OVERRIDE_REQUIRED`.
Los rechazos sin código (`availableKg ≤ 0`: «no tiene kilos montados sin rolar», y
`declaredKg > available`) no la reciben, y son justo los de «esta bobina quedó en cero y el faltante
está en la otra». Es una decisión consistente con D-389 (esos rechazos son a propósito), pero el
objetivo declarado del P2-2 de cc20 (que no se confirme la casilla en la bobina equivocada) queda
cubierto solo en la franja con casilla. Corrección: o documentarlo en la fila de decisión, o agregar la
pista también a esos dos mensajes (solo texto).

### SM-6 — P3 — El prefiltro de la marca sigue exigiendo el texto pegado a «Factura externa: »

`apps/api/src/sales/quotations.service.ts:1468-1474`.

`startsWith: 'Factura externa: ' + series` no tolera espacios entre el prefijo y la serie
(`Factura externa:   FFA1 - 1419`). `compactInvoiceNumber` sí los tolera al comparar, pero el prefiltro
de Postgres ya descartó la fila. Hoy `externalInvoiceOf` produce la marca a partir del importador, que
no pone espacios de más, y los 78 casos de demo calzan, así que es un borde teórico. Corrección: `contains`
de la serie en vez de `startsWith`, y que `importedInvoiceNumber` decida.

### SM-7 — P3 — Un número tipeado con prefijo del otro documento ya no encuentra por `seq`

`apps/api/src/common/search-seq.ts:17-22`.

`PED-12` en la lista de cotizaciones (o `COT-12` en pedidos) devuelve `null`: es lo que fija el test
y es lo correcto para evitar falsos positivos, pero es un cambio de comportamiento visible (antes
traía el `seq` 12). Si alguien pega un código de pedido en el buscador de cotizaciones, no recibe
nada ni mensaje. Sin cambio requerido; vale una línea en D-462 si no está.

## Conteos

| Severidad | Cantidad        |
| --------- | --------------- |
| P0        | 0               |
| P1        | 0               |
| P2        | 2 (SM-1, SM-2)  |
| P3        | 5 (SM-3 a SM-7) |

Revisión de un modelo, no humana.

## Resolución (sesión cc28, corte 2)

- **SM-1 (P2), corregido:** la venta del E2E de cc23 se anula en un `finally`.
- **SM-2 (P2), corregido:** la descarga refresca la sesión una vez ante un 401 y usa `no-store`.
- **SM-3 (P3), corregido:** una descarga a la vez por enlace.
- **SM-4..SM-7 (P3):** en PROGRESO (SM-7 es intencional por D-462 y va al guion de UAT).
