# cc23 — Autorrevisión (no es aprobación)

> **AUTORREVISIÓN.** La hizo un subagente nuevo que no escribió el cambio ni leyó el handoff de
> implementación (AGENTS.md §2, regla 2.1, criterio de D-248). Es una **lista de riesgos**, no un
> pase cruzado ni una aprobación. La revisión que cierra es la del dueño.

- Rama: `cc23-reportes-lineas`, worktree `../ayr-cc23`.
- Diff revisado: `81cd656..HEAD` (5bd24a5, d544658, 45f4a32) más, como contexto, el spec E2E sin
  commitear `e2e/tests/reportes-por-linea-cc23.spec.ts` y las filas D-390..D-401 sin commitear de
  `docs/ARQUITECTURA.md`.
- Corridas de solo lectura (2026-10-05):
  - `jest src/reports` (API): **15 suites, 136 tests, 136 passed**.
  - `vitest run` (web): **15 archivos, 96 tests, 96 passed**.
  - No se corrió Playwright (fuera del alcance de este pase).

## Resumen

| Sev. | #   | Hallazgo                                                                                                                                    |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| P0   | —   | Ninguno.                                                                                                                                    |
| P1   | —   | Ninguno.                                                                                                                                    |
| P2   | 1   | En la pestaña Servicios, la venta de servicios de un pedido mixto queda fuera de «Venta sin IGV» por un problema de costo de **otra** línea |
| P2   | 2   | El spec E2E de cc23 no está commiteado                                                                                                      |
| P3   | 3   | `partialOrderCount` no es aditivo entre pestañas; el test lo afirma con un caso que justo cumple                                            |
| P3   | 4   | Costo de comprobante `0` (no `null`) en la pestaña de una línea que el comprobante no despachó                                              |
| P3   | 5   | El inventario redondea por pestaña: la suma de pestañas difiere de «Todas» hasta 0,0001 por línea                                           |
| P3   | 6   | «Todas» cambia en pantalla (no en números): `Bobinas (kg)` en inventario, fila de Servicios en ventas                                       |
| P3   | 7   | «Sin línea (servicios y ajustes)» sigue mostrando costo 0 y margen 100 % en «Todas»                                                         |
| P3   | 8   | Pestañas sin `TabsContent`: `aria-controls` apunta a IDs inexistentes; flechas del teclado apilan historial                                 |
| P3   | 9   | `colSpan={9}` fijo en la fila vacía de «Por pedido» con menos columnas                                                                      |
| P3   | 10  | Una bobina con línea UPVC/Reventa sumaría al «Total» de esa pestaña sin verse                                                               |
| P3   | 11  | Reventa «con la bobina entera» en inventario: la bobina vive en la línea que la compró                                                      |

No se encontró nada que cambie el resultado de «Todas» en la API: con `businessLine` ausente,
`viewCostRows === orderCostRows`, `viewDocs === docs`, `docSalesInView === signedSubtotal` y
`docCost` toma la rama original; `totalsByLine` no se filtra. El cálculo del costo
(`costsByOrder`, `resolveCostStatus`, `orderCostRows`) no cambió; solo se filtra. El presupuesto
de consultas no cambia en ninguno de los dos reportes (filtro en memoria). Las dos rutas siguen
con `@Roles(Role.ADMINISTRADOR)` y validan `businessLine` con Zod contra la matriz compartida;
`/sales-margin/xlsx` descarta la línea. El código de línea crudo (`bl."code"::text`) es el mismo
literal que `BusinessLine` de `@ayr/shared` (`'metallic-roofing'`, etc.; ver
`fromDbLineCode`), así que la comparación `business_line_code === businessLine` es correcta.

Sobre la invariante «las pestañas suman Todas» en ventas: se cumple para venta y margen **más el
grupo «Sin línea»** (D-398) y para costo sin ese término, porque la cabecera
`fiscal_documents.subtotal_pen` sale de `sumLineTotals(lines)` (`invoicing.service.ts:571`/`1098`)
y por eso es igual a Σ `fiscal_document_items.subtotal_pen`. Si algún día un comprobante tuviera
cabecera ≠ Σ líneas (descuento global, importación con redondeo propio), la invariante se rompería
sin que ningún test lo note; hoy no ocurre.

## Hallazgos

### P2-1 — Servicios pierde venta por el estado de costo de otra línea

- `apps/api/src/reports/sales-margin.service.ts:412-420` (estado por pedido) y `:511-520`
  (excluye la venta entera del pedido de los totales); `apps/web/src/app/(app)/reportes/ventas-margen/ventas-margen-view.tsx:136-141`
  (franja de Servicios) y `:213-287` (secciones «Facturación parcial» y «Costo no rastreable»).
- Escenario: pedido mixto Drywall + Servicios con una línea de drywall despachada sin salida de
  kardex (D-285) → `NO_RASTREABLE`. En la pestaña Servicios, la venta del servicio (que no tiene
  costo por definición, D-392) **no** suma a «Venta sin IGV»; aparece abajo, en «Costo no
  rastreable», con un texto que habla de costo y salidas de inventario. Lo mismo con
  `NO_COMPARABLE`. Es coherente con la fila de Servicios de «Totales por línea» en «Todas»
  (también solo cuenta pedidos en totales), así que no rompe la suma; pero para una pestaña que
  «solo muestra ventas», excluir venta por un problema de costo ajeno puede leerse como venta
  faltante.
- Arreglo sugerido: decisión del dueño. O (a) en las líneas de `NO_COST_REPORT_LINES` sumar la
  venta de todos los pedidos (perdiendo la igualdad con la fila de «Todas», que habría que
  documentar), o (b) dejarlo como está y, en la pestaña Servicios, cambiar el texto de esas dos
  secciones para decir que la venta está fuera porque el pedido tiene otra línea con costo no
  comparable/no rastreable. Como mínimo, registrar la lectura como `D-nnn`.

### P2-2 — El spec E2E de cc23 está sin commitear

- `e2e/tests/reportes-por-linea-cc23.spec.ts` aparece como `??` en `git status`; no está en
  `81cd656..HEAD`. Tampoco `docs/uat/cc23.md` ni los cambios de `docs/ARQUITECTURA.md`.
- Escenario: si se empuja la rama así, CI no corre la cobertura E2E de las pestañas, la URL, el
  400 de la API ni la suma contra «Todas».
- Arreglo: commitearlo antes del push (probablemente ya previsto en el cierre).

### P3-3 — `partialOrderCount` no es aditivo, y el test lo trata como si lo fuera

- `apps/api/src/reports/sales-margin.service.spec.ts` (bloque «por línea (cc23)», primer `it`,
  bucle `for (const key of ['partialOrderCount'])`); servicio `:521`.
- Escenario: un pedido mixto Drywall + Aluzinc con costo `PARCIAL` cuenta 1 en «Todas» y 1 en
  cada pestaña (2 en total). El test pasa solo porque el único pedido parcial del caso (o2) es de
  una línea. Además, en la pestaña de una línea totalmente despachada, el aviso «N pedidos tienen
  costo parcial… el margen de arriba es un techo» puede ser falso para esa línea (el estado es
  del pedido, como dice D-391).
- Arreglo: quitar `partialOrderCount` del bucle de sumas (o afirmar `<=`/≥ según corresponda) y
  dejar dicho en el comentario que los conteos son por pedido y no se suman. Opcional: en la
  pestaña de una línea, decir «pedidos con costo parcial (en alguna de sus líneas)».

### P3-4 — Costo `0` en vez de «—» en el comprobante de una línea no despachada

- `apps/api/src/reports/sales-margin.service.ts:470-478`.
- Escenario: factura d1 con líneas Drywall y UPVC; solo se despachó el drywall, declarando d1.
  En la pestaña UPVC, `costByDocument.has('d1')` es verdadero, el filtro por línea no deja filas
  y el comprobante muestra **costo 0,00, margen = venta, 100 %**, en vez de «—» (despacho no
  declarado). La fila del pedido lleva el badge `PARCIAL`, que lo atenúa, pero la fila del
  comprobante no.
- Arreglo: en la vista por línea, `docCost = null` cuando no hay ninguna fila de esa línea con
  `invoice_id === d.id` (usar `some` antes de reducir).

### P3-5 — Inventario: la suma de pestañas difiere de «Todas» por redondeo

- `apps/api/src/reports/inventory-valuation.service.ts:279-302`.
- Escenario: cada pestaña redondea su propio total a 4 decimales; «Todas» redondea la suma
  exacta. Con cantidad (3) × costo (4) = 7 decimales, la suma de pestañas puede apartarse hasta
  ~0,00005 por línea. El test lo documenta con tolerancia (0,0001 × líneas) y es la misma
  diferencia que ya existía entre «Totales por línea» y «Total general». Queda por debajo del
  céntimo que muestra la pantalla, pero el pedido decía «deben sumar» y la igualdad exacta no
  vale.
- Arreglo: aceptarlo y registrarlo en D-391 (parece la intención), o que `totals` en «Todas» se
  calcule como la suma de los totales por línea ya redondeados (cambia el número de «Todas» en
  la cuarta cifra decimal; no recomendado sin decisión).

### P3-6 — «Todas» cambia en pantalla

- `apps/web/src/app/(app)/reportes/inventario-valorizado/inventario-valorizado-view.tsx:91-98`
  (nueva tarjeta `Bobinas (kg)` también en «Todas», grilla de 3 a 4 columnas);
  `ventas-margen-view.tsx:313-330` (fila de Servicios de «Totales por línea» muestra «Sin costo
  registrado» en vez de costo/margen/%); `:331` («Material de OPs» se mantiene en «Todas»).
- Los números de «Todas» no cambian. La fila de Servicios está pedida por D-392; la tarjeta de kg
  en «Todas» no está pedida explícitamente por ninguna decisión.
- Arreglo: confirmar con el dueño en la UAT o mostrar `Bobinas (kg)` solo en las pestañas de
  línea con bobinas.

### P3-7 — Servicios escritos a mano siguen con margen 100 % en «Todas»

- `ventas-margen-view.tsx:313-330`.
- Escenario: un servicio facturado como línea libre (sin producto) cae en «Sin línea (servicios y
  ajustes)», que sigue mostrando costo 0, margen = venta y 100 %. D-392 apaga el costo solo para
  la fila de la línea Servicios, así que el mismo tipo de venta se ve de dos maneras según se haya
  cargado con o sin producto.
- Arreglo: decisión del dueño (relacionada con D-398); si se acepta, al menos documentarlo.

### P3-8 — Accesibilidad e historial de las pestañas

- `apps/web/src/components/line-tabs.tsx:22-37`.
- Se usa Radix `Tabs` sin `TabsContent`: cada `TabsTrigger` lleva `aria-controls` a un panel que
  no existe en el DOM (referencia IDREF rota; axe la marca). Y con la activación automática por
  defecto de Radix, recorrer las pestañas con las flechas del teclado dispara `router.push` y una
  consulta por cada pestaña que pasa: tres flechas son tres entradas de historial.
- Arreglo: `activationMode="manual"` en `<Tabs>` (Enter/Espacio confirma) y envolver el contenido
  del reporte en un único `TabsContent` del valor activo, o quitar `aria-controls`
  (`aria-controls={undefined}`) si se prefiere no tener panel.

### P3-9 — `colSpan` fijo

- `ventas-margen-view.tsx:199` — `colSpan={9}` en la fila vacía, cuando en una pestaña de línea
  hay 8 columnas y en Servicios 4. El navegador lo tolera; es cosmético.
- Arreglo: calcularlo con `cols`.

### P3-10 — Bobina con línea sin bobinas: valor oculto en el «Total»

- `inventario-valorizado-view.tsx:36` (`hasCoils`) y `:99-104`.
- Escenario: si existiera una bobina con `business_line` `roofing` o `trading` (la restricción
  vive solo en la aplicación: `purchase.ts:267`, `purchase-import-validate.ts:149`; no hay CHECK
  en la base), su valor entraría a `totals.totalValuePen` de esa pestaña y la sección de bobinas
  estaría oculta: el «Total» no cuadraría con la tabla de productos visible.
- Arreglo: mostrar la sección de bobinas cuando `coilGroups.length > 0` aunque la línea no sea
  de bobinas, o mostrar la tarjeta «Productos» además del «Total».

### P3-11 — «Reventa (con la bobina entera)» en inventario

- `inventario-valorizado-view.tsx:34-36` (comentario: «la bobina de reventa vive en la línea que
  la compró, D-116»).
- La pestaña Reventa de inventario no muestra bobinas destinadas a reventa: quedan en Drywall o
  Aluzinc. En ventas y margen sí caen en Reventa (D-247, línea del producto). La lectura es
  coherente con el modelo de datos, pero D-391 dice literalmente «Reventa (con la bobina
  entera): inventario por unidades».
- Arreglo: confirmar con el dueño en la UAT.

## Cosas revisadas sin hallazgo

- `useLineTab`: el `useEffect` de corrección hace `replace` solo cuando `valid` es falso y deja de
  dispararse en cuanto la URL se corrige: no hay bucle. `?linea=todas` cae como inválida y se
  limpia (D-394). Cambiar de pestaña usa `push` y conserva solo `keep` (`from`, `to`); el rango
  sigue con `replace` vía `useUrlState`, que parte de la URL más reciente y conserva `linea`.
  `useSearchParams` sin `Suspense` propio sigue el mismo patrón que el resto de las vistas de
  `(app)`.
- Matiz de historial (no es defecto): cambiar el rango hace `replace` sobre la entrada actual,
  así que Todas(A) → Drywall → rango B → atrás vuelve a Todas con el rango A.
- Notas de crédito: `lineSales` aplica el signo igual que `signedSubtotal` y que `totalsByLine`.
- Venta sin pedido: `orderCostRows = []`, aparece solo si tiene líneas de la pestaña; sus líneas
  libres quedan en «Sin línea» (D-398).
- Pedido con costo de la línea y sin venta de esa línea en el rango: aparece con venta 0 y su
  costo, igual que la fila de «Totales por línea» en «Todas».
- Specs existentes que leen estos reportes (`reportes-costeo-rf-s4a`,
  `normalizacion-bobinas-rf-s4b`, `ventas-material-d354`) usan la API sin `businessLine` y
  comparan `totals` antes/después del mismo DTO: el campo nuevo `coilQtyKg` no los rompe. Ningún
  spec E2E existente navega a `/reportes/ventas-margen` ni a `/reportes/inventario-valorizado`.
