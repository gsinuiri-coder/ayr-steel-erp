# cc23 — Revisión de segundo modelo (Sonnet, contexto limpio) sobre el diff `81cd656..5bd24a5`

Alcance: todo `git diff 81cd656..HEAD` (15 archivos) más el spec E2E sin commitear
`e2e/tests/reportes-por-linea-cc23.spec.ts`. Corridas hechas: `jest src/reports` (15 suites, 136
tests, verdes) y `vitest run` de la web (15 archivos, 96 tests, verdes). No se corrió Playwright.
Solo se reporta lo verificado leyendo el código.

Veredicto: sin P0 ni P1. «Todas» no cambia respecto a `81cd656` (misma ruta de código cuando
`businessLine` es `undefined`; `viewCostRows`, `viewDocs` y `docSalesInView` degeneran a
`orderCostRows`, `docs` y `signedSubtotal`); lo único nuevo en su payload es `totals.coilQtyKg`
en inventario.

## Verificado y correcto

- Rol: `@Roles(Role.ADMINISTRADOR)` intacto en las dos rutas JSON. Zod en el borde:
  `salesMarginQuerySchema` y `inventoryValuationQuerySchema` rechazan con 400 una línea fuera de
  la matriz (inventario no acepta `services`). Los nombres coinciden entre la consulta cruda
  (`bl."code"::text`, que trae el valor `@map`) y `BusinessLine` de shared, así que
  `row.business_line_code === viewLine` es una comparación válida.
- D-396: el xlsx de ventas descarta `businessLine` (`reports.controller.ts` ~148) y la web solo
  ofrece «Descargar Excel» en «Todas».
- Pestaña = su fila de «Todas»: `viewCostRows` sale de las mismas `orderCostRows` que alimentan
  `lineTotals`, y la venta sale de las mismas `salesLinesByDocument`. Notas de crédito restan
  (`lineSales`, signo). Pedidos NO_COMPARABLE y NO_RASTREABLE se calculan con el estado del
  pedido entero y salen de `totals`, igual que en «Todas». Venta directa sin pedido
  (`orderId === null`, costo 0) funciona.
- URL: `useLineTab` usa `push` para cambiar de pestaña y `replace` solo para corregir una línea
  inválida; el efecto de corrección depende de `valid` y no puede hacer bucle (tras el
  `replace`, `raw` es `null` y `valid` pasa a `true`). `useUrlState` conserva `linea` al cambiar
  el rango (parte de `latest.current`). La consulta usa la pestaña ya resuelta, así que no hay
  petición con la línea inválida. `?linea=todas` se trata como inválida y se corrige (documentado).
- E2E existentes (`reportes-costeo-rf-s4a`, `normalizacion-bobinas-rf-s4b`, `ventas-material-d354`)
  solo llaman a la API sin `businessLine`; no dependen del markup de estas dos vistas. Las
  comparaciones `.toEqual` de `totals` son consistentes porque ambos lados traen `coilQtyKg`.

## P0

Ninguno.

## P1

Ninguno.

## P2

### P2-1. Lo «sin línea» no tiene pestaña: las pestañas no suman «Todas»

`apps/api/src/reports/sales-margin.service.ts:548` (`totalsByLine` conserva `SIN_LINEA` solo en
«Todas») y `ventas-margen-view.tsx` («Sin línea (servicios y ajustes)»).
Escenario: una línea de comprobante sin producto (línea libre, ajuste de nota de crédito) suma en
`totals.salesPen` de «Todas» y en su fila «Sin línea», pero ninguna pestaña la muestra. El
propio test (`sales-margin.service.spec.ts`, «las pestañas más lo que no tiene línea suman…»)
suma `noLine` aparte para que cuadre, o sea que el límite duro «los totales por línea deben sumar
el total de Todas» solo se cumple añadiendo esa fila. Un lector que sume las seis pestañas se
topa con una diferencia sin explicación en pantalla.
Arreglo sugerido: decidir con el dueño. Opción mínima: una nota bajo la franja de «Todas»
(«Las pestañas no incluyen X de ventas sin línea») o mostrar la fila «Sin línea» también como
referencia; no inventar una pestaña (D-390/D-394).

### P2-2. El spec E2E nuevo no está commiteado

`e2e/tests/reportes-por-linea-cc23.spec.ts` aparece como `??` en `git status` y no entra en el
diff `81cd656..HEAD`. Si se hace push de la rama así, CI no lo ejecuta y la cobertura de
URL/historial queda sin entregar. Arreglo: `git add` en el commit de la pieza.

### P2-3. Reventa «incluye bobina entera» no aplica al inventario

`inventory-valuation.service.ts` (filtro `inView` sobre `business_line_code` de `coils` y de
`products`) y `inventario-valorizado-view.tsx` (comentario: la bobina de reventa vive en la línea
que la compró, D-116). La pestaña Reventa de inventario muestra solo productos con línea
`trading`; una bobina entera con saldo aparece en Drywall/Aluzinc (donde fue ingresada), no en
Reventa. La matriz D-391 dice que Reventa incluye la bobina entera, así que si el dueño la lee
como «la bobina que se revende» el inventario de Reventa subestima. En ventas sí funciona (el
ingreso se imputa al SKU `trading`, D-247).
Arreglo: confirmar con el dueño que la lectura es la de ventas; si no, dejar la salvedad escrita
en la pantalla de Reventa.

## P3

### P3-1. Costo 0 con margen 100 % en un comprobante cuyo costo está en otra línea

`sales-margin.service.ts:472-478`. Con línea elegida, si `costByDocument.has(d.id)` pero ninguna
`viewCostRows` es de ese comprobante (el comprobante tiene venta en la línea y su costo en otra
línea), `docCost` es `0.0000` y la fila muestra margen igual a la venta. En «Todas» ese
comprobante mostraba su costo total. Es coherente con `lineTotals`, pero visualmente es un
margen de 100 % por línea. Arreglo: devolver `null` cuando `viewCostRows` no tiene filas del
comprobante, o cubrirlo con un test.

### P3-2. Servicios sigue mostrando las secciones de costo

`ventas-margen-view.tsx`: en la pestaña Servicios (D-392) las secciones «Facturación parcial en
el rango» y «Costo no rastreable» siguen con su texto («no se sabe su costo»). Es consistente
con los totales (esas ventas salen de `totals`), pero para una línea sin costo el texto confunde.
Arreglo: texto alternativo en `noCost` o aviso de que esas ventas quedan fuera.

### P3-3. La venta de la pestaña viene de líneas; la de «Todas», del subtotal del comprobante

`totals.salesPen` en «Todas» es Σ `signedSubtotal(doc)` y en una pestaña Σ de `fiscal_document_items.subtotal_pen`
de esa línea. Los tests usan semillas donde ambas coinciden; si en datos reales un comprobante
tuviera subtotal de cabecera distinto de la suma de sus ítems (descuento global, redondeo) las
pestañas no sumarían «Todas» ni siquiera contando «Sin línea». No lo verifiqué contra datos;
conviene comprobarlo en la demo.

### P3-4. `INVENTORY_VALUATION_LINES` y `COIL_REPORT_LINES` con usos dispares

`COIL_REPORT_LINES` (`report-lines.ts:29`) solo se usa en un spec; la vista decide
`hasCoils` con `COIL_BUSINESS_LINES` de `enums.ts`. Dos fuentes para lo mismo. Arreglo: usar una
sola o borrar la constante sin uso en producción.
