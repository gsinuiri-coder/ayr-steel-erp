# cc32 corte 1 - revision de segundo modelo (Sonnet, contexto limpio)

Diff revisado: `origin/cc32-c0...origin/cc32-c1` (20 archivos, +2294/-306). Solo lectura: no se
corrio la suite ni la app; todo sale de leer el codigo y razonar los specs contra el fixture.
Es un modelo, no una persona: no cierra la revision (AGENTS.md 2.2).

## Resumen

El corte es presentacion pura. Lo que se pide al API (`from`, `to`, `businessLine`, queryKey)
y el filtro de filas que suman (`inTotals`, `excluded`, `untraceable`) son los de `main`. Las
fechas se manejan como texto AAAA-MM-DD con `businessToday()` (Lima); `Date.UTC` solo sirve
para aritmetica de calendario. Totales y grupos usan `Decimal` y redondean al mostrar
(`formatAmount`); la suma de los grupos es la del pie de la tabla por pedido porque ambos
parten de las mismas `included`. El fixture del e2e cuadra a mano (venta 13,768.80, costo
10,555.31, margen 3,213.49, 23.34 %, Marco T. 8,957.62). No hay P0 ni P1. Hay cuatro P2
(dato viejo sin aviso mientras carga, anio basura que se guarda, conteo de pedidos que no
coincide, busqueda en "Ver por" con totales del grupo entero) y varios P3.

## Hallazgos

### P0

Ninguno.

### P1

Ninguno.

### P2

**P2-1. Dato anterior sin ninguna marca mientras carga el nuevo.**
`ventas-margen-view.tsx:89-94,106-111` (`placeholderData: keepPreviousData`; `loading` solo
mira `isPending`). Escenario: de "Todas" a la pestana Servicios, o de un periodo a otro, la
franja y la tabla muestran las cifras anteriores con el rango y el boton de Excel ya del
periodo nuevo. En Servicios la franja rotula "Venta" con el total de "Todas" hasta que llega
la respuesta. La especificacion pide conservar el dato, no esconder que es el viejo.
Arreglo: usar `report.isPlaceholderData` para `aria-busy` en el contenedor y bajar la
opacidad de la franja y la tabla (o un "Actualizando..." con `role="status"`).

**P2-2. Un anio a medio teclear se consulta y se guarda como periodo recordado.**
`report-period.ts:33-39` (`isValidDate` acepta `0002-10-01`), `report-period.tsx:59-61` y
`:120-134`. Escenario: en "Otro periodo...", Chrome dispara `change` en cada digito del anio
del `<input type=date>`; cada valor intermedio (0002, 0020, 0202) es una fecha valida, asi
que se reemplaza la URL, se pide el reporte con ese rango y `writeStoredPeriod` lo guarda. Si
el usuario sale a otro reporte o a `/reportes` antes de terminar, el siguiente reporte abre
con ese periodo basura. El codigo anterior tenia el mismo disparo, pero no lo recordaba.
Arreglo: en `periodError` (y por tanto en `parseStoredPeriod`) exigir un anio razonable (p.
ej. desde 2020 y no mas de un anio sobre hoy) con mensaje en espanol; opcionalmente aplicar
las fechas libres con un debounce corto.

**P2-3. El conteo de "pedidos" no coincide entre la franja y la tabla.**
`ventas-margen-view.tsx:334` cuenta solo `salesOrderId !== null`; el pie (`footerLabel`,
:207) y la columna "Pedidos" de los grupos (`sales-margin-groups.ts:42`,
`count: orders.length`) cuentan tambien las ventas directas sin pedido. Escenario: con 12
pedidos y 1 venta de mostrador, la franja dice "12 pedidos" y el pie "Total · 13 pedidos".
Arreglo: una sola definicion en los tres sitios (o llamarlas "ventas" cuando hay filas sin
pedido) y un caso con venta sin pedido en `sales-margin-groups.spec.ts`.

**P2-4. La busqueda en "Ver por" filtra grupos pero no recorta sus totales.**
`ventas-margen-view.tsx:601-609` (el texto buscable del grupo incluye todos sus pedidos y
comprobantes) y `:593-594` (el pie suma los grupos enteros). Escenario: en Vendedor, buscar
el comprobante `F001-00000003` deja el grupo de Gabriela con sus dos pedidos y su total
completo; el pie dice "Total" sin avisar que es de los grupos que coinciden. En la vista por
pedido el pie si es exacto. No rompe el cuadre, pero "busqueda vs totales" queda distinto
segun la vista. Arreglo: (a) rotular el pie "Total de los grupos que coinciden" y decirlo en
"Como se calcula", o (b) filtrar los pedidos del grupo antes de sumarlo. Decide el dueno;
se recomienda (a).

### P3

**P3-1.** `ventas-margen-view.tsx:71-91,121`: los hooks (periodo, consulta, escritura de URL
y de `sessionStorage`) corren antes de `RoleGate`. Un no administrador que pega la URL dispara
`/reports/sales-margin` (403) y se le reescribe la URL. Ya pasaba en `main`; mover la consulta
a un subcomponente dentro del gate.

**P3-2.** `sales-margin-groups.ts:75`: "Cliente" agrupa por nombre porque el DTO no trae id
(`report.ts:323`). Dos clientes homonimos se funden en un grupo. La suma sigue cuadrando.
Anotarlo en "Como se calcula" o sumar `customerId` a la lista de pedidos para una pieza de API.

**P3-3.** `report-table.tsx:79`: las filas abiertas sobreviven al cambio de vista (misma
instancia de `ReportTable`). Hoy es inofensivo por el prefijo `g:`, pero un vendedor y un
cliente con el mismo nombre compartirian apertura. Poner `key={view}` a cada `ReportTable`.

**P3-4.** `report-period.ts:100-104` y `report-period.tsx:60`: se guarda el rango, no el
atajo. Con la pestana abierta de un dia al siguiente, "Este mes" recordado abre el otro
reporte con `to` = ayer. Guardar tambien el atajo y resolverlo con `businessToday()`.

**P3-5.** `ventas-margen-view.tsx:414,419-420`: dentro de "Como se calcula" quedan "el margen
de arriba" y "los totales de arriba", ahora en un panel. Decir "el margen de la franja".

**P3-6.** `ventas-margen-view.tsx:793`: `keep` conserva `sort` y `dir` al cambiar de pestana;
en Servicios, `sort=cost` no tiene columna y se ignora sin indicador (coherente con
`sort-rows.ts`, pero conviene saberlo).

**P3-7.** `report-table.tsx:167-184`: el pie queda al final del contenedor con scroll
(`Table list`, `max-h`), no pegado abajo; con muchas filas hay que desplazarse para verlo.
`sticky bottom-0` en `TableFooter` lo resuelve.

**P3-8.** `sales-margin-groups.ts:40-52`: el margen del pie suma `marginPen` de las filas con
margen sobre la venta de esas filas; la franja usa los totales del API. El texto de ayuda ya
avisa que "puede no coincidir" (:430-432), pero ningun test cubre una fila mixta (producto +
servicio). Agregar ese caso al spec de grupos.

## Revisado sin hallazgo

- Fechas: atajos, mes anterior en enero, ultimos 3 meses y ultimo dia del mes, todo sobre
  texto; el e2e usa `businessToday()` del paquete compartido.
- Efectos de URL: el relleno de `from`/`to` depende de `[complete, search]` y converge frente a
  la correccion de `?linea=` invalida (el ajuste de cc23 a la URL completada es correcto). La
  lectura de `sessionStorage` ocurre en un efecto, no al pintar: sin desajuste de hidratacion.
  `/reportes` hace lo mismo.
- `keepPreviousData`: el error y el rango invalido no muestran dato viejo
  (`data = valid ? report.data : undefined`) y no queda un esqueleto eterno.
- Roles en `/reportes`: las secciones salen de `NAV` filtrado por rol; Planta ve bobinas y
  produccion, Vendedor ve el mensaje vacio. El API sigue mandando.
- Accesibilidad: grupos con `aria-pressed` y nombre, buscador con `aria-label`, chevron con
  `aria-expanded` y nombre por fila, popover de Radix con Escape, `role="alert"` en errores.
- Textos en espanol con tuteo ("revisa", "Elige", "No tienes reportes disponibles").
- Specs: los cinco casos de `reportes-plantilla-cc32.spec.ts` cuadran con el fixture y los
  selectores (`data-column` existe en el pie). El cambio en `reportes-por-linea-cc23.spec.ts`
  es el esperado. Nada mas en `e2e/` busca los textos retirados ("Por pedido", "Material de
  OPs", el `aviso-costeo` de esta pantalla).

## Veredicto

Aprobable para seguir: sin P0 ni P1. Corregir antes del deploy P2-2 (es el unico que deja
datos incorrectos persistidos en la sesion) y decidir con el dueno P2-1, P2-3 y P2-4; los P3
pueden ir al siguiente corte o al registro de deuda.

## Estado tras las correcciones (autor del corte)

- P2-1 (dato anterior sin marca, también P1 de la autorrevisión): `isPlaceholderData` pone
  `aria-busy`, atenúa franja y tablas y muestra «Actualizando…»; al cambiar de pestaña de línea no
  se conserva el dato de otra línea (`keepPreviousInScope`).
- P2-2: años de 2000 a 2100; un periodo inválido no se guarda.
- P2-3: un solo criterio de conteo (pedidos; las ventas sin pedido se nombran aparte), D-518.
- P2-4: con «Ver por», la búsqueda filtra filas y después agrupa: el pie suma solo lo que coincide.
- De la autorrevisión: el atajo se guarda y se resuelve con la fecha de hoy; «sin servicios ni
  líneas sin producto» bajo Margen y Margen %; «Cómo se calcula» explica la venta de Servicios de
  los pedidos excluidos (D-412); `key` por vista; la insignia de costo del detalle de grupo.
