# Revisión de segundo modelo — cc67 (D-720, notas de crédito aparte en «Ventas y margen»)

- **Modelo:** Sonnet 5.5 (contexto limpio; no leyó el handoff de implementación)
- **Rama:** `cc67-nc-reporte`
- **Rango:** `3ab9bbd5..HEAD` (13 archivos, +1306/−8)
- **Alcance:** diff completo, contrastado con AGENTS.md y las filas D-646/647/654/663, D-409/412/419 y D-615/617. Lectura de código; se corrieron `jest sales-margin.service.spec.ts reports-xlsx.spec.ts` (69 pasan) y `vitest sales-margin-credit-notes.spec.ts` (3 pasan). No se corrieron db-spec ni E2E.

## Resumen

Sin P0 ni P1. El requisito duro (netas = `totals` al céntimo) se cumple **por construcción**: la parte de NC se acumula en el mismo recorrido y con las mismas funciones que los totales (`docSalesInView`, `docNoCostInView`, `viewCostRows`), y brutas = netas − NC. Hay un P2 (un chequeo de E2E que no mide lo que dice) y varios P3.

## Hallazgos

### P0

Ninguno.

### P1

Ninguno.

### P2

**P2-1. El chequeo «sin scroll horizontal en el modal» del E2E es vacuo.**
`e2e/tests/ventas-margen-nc-cc67.spec.ts` (bloque final del primer test): busca `t.closest('.overflow-auto')`. Pero `Table` (`apps/web/src/components/ui/table.tsx`) se envuelve en su propio contenedor `data-slot="table-container"` con `overflow-x-auto`, que **no** coincide con `.overflow-auto`. El `closest` salta al `div.max-h-[65vh].overflow-auto` de `credit-notes.tsx:163`. Si la tabla fuera más ancha que el modal, quien desborda es el contenedor interno (que ya es `overflow-x-auto`); el externo nunca desborda y `scrollWidth - clientWidth` da 0 siempre.
Escenario: cualquier cambio que ensanche columnas pasa el test aunque aparezca la barra horizontal que D-615/617 prohíben.
Propuesta: medir `t.closest('[data-slot="table-container"]')` (o ambos) y afirmar `scrollWidth <= clientWidth`.

### P3

**P3-1. La hoja «Notas de crédito» del Excel se emite siempre**, también sin NC (queda solo la cabecera). El requisito es «sin NC no se muestra nada nuevo»; en la pantalla se cumple, en el Excel no. `reports-xlsx.ts`, `build([... creditSheet ...])`. Propuesta: incluirla solo si `report.creditNotes.length > 0`, como ya se hace con `byLine`. (Hay precedente de hoja vacía en «Facturación parcial», así que es criterio.)

**P3-2. La fila «Total en los totales» de esa hoja no es la suma de la columna cuando hay NC fuera de los totales.** Una NC de un pedido no comparable se lista con su venta completa (p. ej. −40) y costo vacío, pero el total solo suma su parte de Servicios (−10). El rótulo lo aclara («en los totales») y la columna «En los totales» lo marca, pero quien sume la columna en Excel no cuadra. Lo mismo en el resumen web (NC −180 vs. tabla −210 en el caso del spec). Propuesta: aceptable; opcionalmente, mostrar la venta de las que están fuera como «—» o añadir una fila «Fuera de los totales».

**P3-3. Resumen web con todas las NC fuera de los totales.** En una pestaña (p. ej. Cobertura metálica en el caso del spec) donde la única NC es de un pedido no comparable, `CreditNotesSummary` muestra brutas = netas con la fila de NC en 0,00 y el enlace «Ver la nota de crédito»: un bloque nuevo sin información. Propuesta: mostrar la grilla solo si alguna NC `inTotals`, o conservar el enlace y omitir la grilla.

**P3-4. Cabecera fija que no queda fija.** `credit-notes.tsx:163-172`: `TableHeader sticky top-0` dentro de `Table`, cuyo contenedor interno (`overflow-x-auto`) es el ancestro con scroll que usa `sticky`; el `max-h-[65vh] overflow-auto` externo no lo gobierna (el propio comentario de `table.tsx` describe este problema; el patrón se copió de `ventas-material-view.tsx:1006`). Con muchas NC la cabecera se va al hacer scroll. Propuesta: `Table list` o quitar el `sticky`.

**P3-5. Accesibilidad de la grilla de resumen.** `role="table"` con filas `display: contents` (`className="contents"`) pierde la semántica en navegadores que quitan roles a elementos `contents`, y la explicación («una devolución resta costo; un descuento, no») vive solo en `title` (invisible a teclado y táctil). Propuesta: usar `<table>` real o `<dl>`, y poner la nota como texto visible.

**P3-6. Cobertura de pruebas.** No hay caso del filtro «A costo» con NC (la consulta lo aplica a las NC por `sales_order_id` del propio comprobante; una NC sin pedido sale siempre del conjunto bajo `aCosto`, igual que sus totales, así que cuadra, pero nada lo fija). Tampoco un caso con fila de costo no-`RETURN` imputada a una NC (entra a `creditCost` aunque no sea devolución; el invariante bruto + NC = neto se mantiene igual). El segundo test E2E («sin NC») intercepta la respuesta y vacía `creditNotes`: prueba la pantalla, no el caso real sin NC.

**P3-7. Ortografía de mes.** La pantalla muestra «setiembre 2026» (`monthLabel`) y el Excel `2026-09`; inofensivo, solo inconsistente.

## Verificado sin hallazgo

- **Cuadre netas = `totals`.** Tres rutas revisadas: (a) pedido en los totales: `ncSales = signedSubtotal`/`lineSales` y `ncNoCost = noCostSalesOf`/`noCostView`, idénticos a los de la fila y a `lineTotals` (que usa el mismo signo por línea, incluida «Sin línea» de D-419); (b) pedido fuera, en «Todas»: solo se suman las líneas de `NO_COST_REPORT_LINES`, igual que `addNoCostSales` (sin «Sin línea», igual que `noCostSales` del total, que solo toma de `lineTotals` lo que entró); (c) pedido fuera en pestaña de línea: no aporta, y `totalSales` tampoco. En la pestaña de Servicios, `noCostView` vuelve `inTotals` verdadero, `ncNoCost = ncSales` y el margen de la NC es 0.
- **Signos.** `creditSales`/`creditCost` quedan negativos; bruto = neto − crédito; margen de NC = venta − sin costo − costo (devolución −100 +60 = −40; descuento −50). `grossMarginPct` usa base `marginBase − (creditSales − creditNoCost)` y costo `totalCost − creditCost`; `null` si la base no es positiva.
- **Una devolución resta costo, un descuento no:** el costo de la NC sale de las filas de costo imputadas a su `invoice_id` (RETURN/DEV-, D-647) o de la declaración en cero de los motivos de descuento; sin fila, 0.
- **Fechas.** `issue_date` es `DATE`; `toISOString().slice(0,10)` es estable (medianoche UTC) y `affectedEarlierMonth` compara `YYYY-MM` como texto, correcto también entre años. El orden por fecha y número no depende de la zona.
- **Consulta.** El `LEFT JOIN afd` es 1:1 (no duplica filas) y ya existía para el vendedor. No hay migración ni escritura; el kardex no se toca.
- **Permisos.** Sin endpoints nuevos: `sales-margin` y `sales-margin/xlsx` siguen bajo el guard de ADMINISTRADOR; el costo viaja solo en ese reporte.
- **Excel.** `keepColumns` quita costo y efecto en Servicios por índice original; las filas de «Totales» (brutas, NC, netas) se añaden en las dos ramas (Todas y pestaña) y solo si hay NC; `num()` convierte porcentajes nulos a vacío.
- **Web.** Buscar primero (`ToolbarSearch` antes de la tabla), búsqueda local al modal que no toca la tabla del reporte ni la URL, limpia al cerrar; enlaces `/comprobantes/<id>` para la NC y el afectado; marca «mes anterior»; sin NC no se renderiza nada (`return null`); sin columnas de costo en Servicios. `filterBySearch` cubre NC, afectado, pedido, cliente, RUC y motivo.
- **Esquemas y DTO.** `salesMarginSchema` extendido; los dobles de `admin-dashboard.spec.ts` y `reports.controller.spec.ts` se actualizaron.
- **Pruebas unitarias.** El spec recorre las seis pestañas (`it.each`) con el invariante exacto (`toEqual` sobre venta, costo, margen y porcentaje) y un caso con los tres comportamientos (devolución, descuento, no comparable con Servicios, NC sin pedido); el db-spec de cc52 comprueba el mismo invariante con datos reales.

## Qué se hizo con los hallazgos (sesión cc67)

- **P2-1:** corregido. El E2E mide `[data-slot="table-container"]`.
- **P3-1:** corregido. La hoja «Notas de crédito» sale solo si hay NC.
- **P3-2:** aclarado. La fila se rotula «Lo que entra a los totales» y el modal dice que de una NC fuera de los
  totales solo suma su venta de Servicios.
- **P3-5:** corregido. El resumen es una `<table>` con su nota visible (`aria-describedby`).
- **P3-3, P3-4, P3-6, P3-7:** quedan anotados, sin cambio. P3-4 es el mismo patrón que `ventas-material-view.tsx`.
- **Margen % de las brutas:** retirado por decisión del dueño. El margen % se muestra solo en la fila de netas, en la
  web y en el Excel, y `grossMarginPct` salió del DTO.
- **Autorrevisión, P1 (NC 01 sin DEV-):** el dueño decidió que la reversa del despacho del mismo pedido se cuenta en
  la NC. Va con prueba unitaria y db-spec, y el cuadre local contra el cálculo anterior da 0 diferencias en 60
  consultas.
