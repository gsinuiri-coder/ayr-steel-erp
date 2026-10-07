# cc32 corte 2 - revision de segundo modelo (Sonnet, contexto limpio)

Alcance: `git diff origin/cc32-c1...origin/cc32-c2` (20 archivos), contra `origin/main` y el API.
Solo lectura: no hice checkout ni corri las suites (pnpm, Playwright). Todo sale de leer el
codigo, el API (`sales-by-material.ts`, `coil-waste.ts`, `production-summary.ts`) y los specs.
Es un modelo, no una persona: no cierra la revision.

## Resumen

El corte cumple lo que promete: es presentacion. Lo que se le pide al API es identico a main en
los seis reportes (mismas rutas, mismo orden de parametros, mismo Excel y PDF, mismos filtros).
Los totales con busqueda usan `Decimal` y repiten las cuentas del API (cocientes de sumas,
teorico y merma solo de bobinas comparables, % de produccion = (salido - teorico + despunte) /
teorico, tramos de CxC). Sin busqueda se muestra el total del API (`allRows`). Las fechas salen
de `businessToday()` (Lima); `Date.UTC` solo se usa para calendario. Los enlaces apuntan a
rutas que existen (`/bobinas/[id]`, `/produccion/[id]`, `/pedidos/[id]`, `/comprobantes/[id]`).
No encontre P0 ni P1. Hay dos P2 y varios P3.

## Verificado sin hallazgo

- Parametros al API vs main: ventas-material (`from,to,businessLine,kind,thicknessMm,color`),
  CxC (`sellerId`), inventario (`businessLine`), bobinas (`month,businessLine`), merma y
  produccion (`from,to,businessLine`). Excel de ventas-material solo en Aluzinc, de inventario
  solo en "Todas", de produccion y bobinas con el periodo; merma sin Excel. Igual que main.
- Claves de consulta: `[...scope, from, to]` con `keepPreviousInScope(scope)`; el alcance
  incluye linea, filtros y vendedor, asi que el dato viejo solo se arrastra dentro del mismo
  alcance. En ventas-material las dos consultas (con y sin filtros) comparten clave cuando no
  hay filtro y entonces tambien comparten `queryFn` (`qs === base`): sin choque.
- Efectos que escriben la URL (`report-period.tsx:64-70`, `:200-204`): solo corren si falta el
  periodo o el mes, con `search` en las dependencias para rehacer el relleno si otro `replace`
  lo pisa. `setUrl` parte de la URL mas reciente (`latest`), asi que no pierde `color`, `linea`
  ni `sort`.
- Rango o mes invalido: `enabled: valid`, `loading` no depende del `isPending` de una consulta
  deshabilitada y las tablas no se montan: no hay esqueleto eterno.
- Alineacion de las filas de detalle con las columnas: merma (10 columnas), produccion (orden y
  pedido, con y sin costos), inventario (colSpan 4 + 3 = 7), CxC. Correctas.
- Specs modificados: coherentes con el codigo nuevo (`&to=` agregado, `periodo-rango`,
  `piezas`, detalle con chevron). `reportes-seis-cc32` usa fixtures por `page.route` y solo lee.
- Textos: tuteo ("Abre", "Elige", "Haz clic"), sin D-nnn a la vista, "pzs" y "OP" quitados.

## Hallazgos

### P2-1. Error de carga duplicado en el Reporte mensual de bobinas

`reporte-bobinas-view.tsx:303-321` (y `:92-97`, `:212`, `:224`). Las dos `MonthTable` reciben
el mismo `query`; si `/reports/coils` falla, `ListStateRows` pinta "No se pudo cargar el
reporte" con su boton de reintento dos veces (Selladas y Abiertas).
Escenario: API caido o 500 en el mes elegido.
Arreglo: dejar el error en una sola tabla (pasar `isError: false` a la segunda) o mostrarlo
una vez arriba y no montar las tablas.

### P2-2. Ningun test comprueba que los parametros al API no cambiaron

`e2e/helpers/report-fixtures.ts:445-468`, `e2e/tests/reportes-seis-cc32.spec.ts`. `mockReports`
responde por ruta e ignora `businessLine`, `kind`, `sellerId` y el resto; solo se comprueba el
`href` del Excel. El criterio central del corte ("no cambia lo que se pide al API") queda
protegido solo por lectura de codigo.
Escenario: una refactorizacion cambia `month=` o quita `businessLine` y la suite sigue verde.
Arreglo: en dos o tres pruebas esperar la peticion (`page.waitForRequest`) y afirmar su
`search` exacto (produccion: `from=..&to=..&businessLine=metallic-roofing`; bobinas:
`month=..&businessLine=..`; CxC: `sellerId`). Costo bajo.

### P3-1. El spec de film pierde una afirmacion

`e2e/tests/film-bobina-d328.spec.ts:405-414`. Se cambio "Subtotal Abiertas" por la presencia
del encabezado "Abiertas". Es razonable (el pie solo sale con filas), pero ya no prueba que la
bobina abierta aparece en esa tabla. Si la prueba la abre, puede afirmar su fila en la region
"Bobinas abiertas".

### P3-2. Codigos crudos de tipo en tablas y en el desglose

`reporte-bobinas-view.tsx:360` (`r.typeKey`), `merma-view.tsx:250`,
`ventas-material-view.tsx:956` (`coil.typeKey`). La especificacion pide el nombre cuando el
dato ya viene; aqui el DTO solo trae `typeKey`, asi que omitirlo es correcto, pero conviene
anotarlo en el informe de la pieza como pendiente de API (nombre del tipo).

### P3-3. Unidad repetida y abreviaturas en el desglose de Ventas por material

`ventas-material-view.tsx:983-984`: encabezados "Kg atribuidos (kg)" y "ML atribuidos (m)".
Basta "Atribuido (kg)" y "Atribuido (m)". "Costo prod." tambien es abreviatura a la vista;
"ML" ya era vocabulario del cliente (D-197).

### P3-4. Cantidad de produccion sin separador de miles

`produccion-view.tsx:466`: `${o.quantity} piezas` muestra la cadena del API ("1500 piezas")
mientras el resto lleva "1,500". Formatear con el helper de cantidades. Los conteos
`String(documentCount)` de CxC e inventario tienen el mismo detalle, menor.

### P3-5. Fila interactiva sin rol ni pista para lector de pantalla

`report-table.tsx:159-176`. La fila de Ventas por material tiene `tabIndex=0`, Enter y espacio
y `title`, pero es un `<tr>` sin rol: el `title` no siempre se lee. Agregar
`aria-haspopup="dialog"` (o un boton en la primera celda) la hace descubrible. El foco vuelve a
la fila al cerrar el dialogo (Radix): bien.

### P3-6. Enlaces viejos de Ventas por material con `?range=`

Los marcadores guardados con `?range=prev|custom` ahora se ignoran y se abre "Este mes" sin
avisar. La especificacion no pide compatibilidad; si importa, mapear `range=prev` a "Mes
anterior" al completar el periodo, o anotarlo en el UAT.

### P3-7. Busqueda y orden al cambiar de pestana, criterio desigual

`ventas-material-view.tsx:75-79` solo conserva `from,to`; merma y produccion conservan
`sort,dir` pero no `search`; inventario y bobinas conservan el orden de sus tablas. Es
coherente con "los filtros son de la linea", pero unificar el criterio evita sorpresas.

### P3-8. El total con busqueda puede diferir en el ultimo decimal

`report-totals.ts` recalcula los cocientes (costo/kg, precio/ML) con cifras de fila ya
redondeadas (kg a 3, dinero a 4); el API divide sumas sin redondear. Sin busqueda se usa el
total del API, asi que solo se ve con busqueda parcial y en el cuarto decimal. Esta dicho en el
codigo y en "Como se calcula"; es una nota, no un defecto.

## Veredicto

Aprobado con condiciones menores: sin P0 ni P1. Recomiendo corregir P2-1 y P2-2 antes del
deploy (ambos chicos) y decidir los P3 con el dueño; ninguno cambia datos ni reglas de negocio.
No pude correr lint, typecheck ni E2E desde esta sesion: el "verde" sigue pendiente de la
corrida del autor y de la CI.

## Estado tras las correcciones (autor del corte)

- P2-1: si falla `/reports/coils`, el error sale una sola vez (Abiertas no se pinta, D-526).
- P2-2: `reportes-seis-cc32` afirma el `search` exacto de Merma y de Ventas por material filtrada
  con `waitForRequest`, y el `href` del Excel de Producción.
- De la autorrevisión: Merma vuelve a mostrar el consumo de las bobinas comparables (franja, pie y
  «Cómo se calcula»); cantidad de la orden en la primera celda del detalle por pedido; avisos de
  kilos sin reporte y de bobinas sin teórico a la vista; el selector de vendedor no se vacía; los
  enlaces con `range=` se traducen (D-525); filas clicables con `aria-haspopup` y `aria-label`.
- P3 corregidos: total no trazable del API, «Atribuido (kg)», miles en piezas, espesores con
  Decimal, contador de Bobinas con la búsqueda (D-527).
