# Autorrevisión (no es un pase cruzado)

cc35, corte 1, rama `cc35-producir` (commit `983f1025`), diff contra `origin/main`.
Es una lista de riesgos y no una aprobación. La hizo un subagente que no leyó el handoff de la
implementación. Se revisó el código leyéndolo: no se levantó la app ni se corrió ningún test.

Archivos: `apps/web/src/components/ui/table.tsx`, `apps/web/src/app/globals.css`, 11 vistas que
pasan a `<Table list>`, `e2e/tests/listas-scroll-cc35.spec.ts`, `docs/ARQUITECTURA.md`.

Las líneas citadas son las de `origin/cc35-producir`.

---

## P1: defecto visible serio

### P1-1. Cada nueva medición devuelve la lista al principio (se pierde el `scrollTop`)

`table.tsx:52-61` (`fit`): para medir el alto natural, `fit` pone `el.style.maxHeight = 'none'` y
luego llama a `getBoundingClientRect()`, que fuerza el layout. Con el tope quitado el contenedor
deja de desplazarse, y el navegador ajusta su `scrollTop` a 0. Cuando el tope vuelve, ese
`scrollTop` no se recupera. El `ResizeObserver` (sobre `body` y sobre la tabla) y el `resize` de la
ventana disparan `fit`, así que cualquier cambio de alto o de ancho de la tabla devuelve la lista
arriba. Casos concretos:

- **Auditoría, «Cargar más»** (`auditoria-view.tsx:332-340`): el usuario baja hasta el final de las
  filas y pulsa «Cargar más». Las filas nuevas hacen crecer la tabla, `fit` se ejecuta y la lista
  vuelve a la primera fila en vez de mostrar las nuevas.
- **Reportes con detalle desplegable** (`components/reports/report-table.tsx:162-213`, filas
  `expanded`). El usuario despliega un grupo que está a mitad de la lista y la lista salta al
  principio. Pasa en inventario valorizado, bobinas, merma, producción y ventas.
- **Reservas temporales** se refrescan cada 60 s (`reservas-temporales-view.tsx:51`). Cuando caduca
  una reserva y sale una fila, la lista vuelve arriba sin que nadie la toque.
- Pasa lo mismo al plegar o desplegar el menú lateral (cambia el ancho de la tabla), al cambiar el
  tamaño de la ventana, y cuando un refetch por foco trae datos que cambian el alto de alguna
  fila.

Arreglo: guardar `const top = el.scrollTop` (y `scrollLeft`) antes de quitar el tope y restaurarlo
después de fijar el `maxHeight` nuevo. Otra opción es medir sin tocar el contenedor: calcular
`room` con `rect.top` y lo que hay debajo, sin pasar por `'none'`. Para esto basta saber cuánto
mide lo de abajo; el alto natural de la tabla no hace falta. Conviene sumar un E2E: bajar en la
lista, desplegar una fila o cargar más, y comprobar que `scrollTop > 0`.

### P1-2. Inventario pasa a modo lista con dos tablas en la misma pantalla: las dos quedan en 240 px y la página igual se desplaza

`inventario-view.tsx:120-136` y `:174`. `LinePanel` pinta una tarjeta de resumen y debajo dos
`SummaryTable`, «Bobinas por tipo» y «Productos de catálogo», y las dos ahora son `<Table list>`.
En `fit` (`table.tsx:56-58`), el `below` de la primera tabla incluye toda la segunda tarjeta. Con
datos reales, `room` sale negativo y se aplica `LIST_MIN_HEIGHT_PX = 240`. La segunda tabla
empieza más abajo y también se queda en 240. A 1366×768 eso deja tres barras (la de la página y
las dos de las tablas) y dos tablas de unas cinco filas cada una. Antes cada una medía hasta
`100svh − 13rem` (≈ 560 px) o crecía con la página.

Por la ESPEC §5, esta pantalla es «tabla dentro de un detalle» (un resumen más dos tablas): sin
barra propia, crece y se desplaza la página. Lo mismo ya pasaba con `ReportTable` en
**inventario valorizado** (`reportes/inventario-valorizado/inventario-valorizado-view.tsx:235` y
`:261`, dos `ReportTable` a la vez, que ya eran `list`). cc35 le cambia el alto, de `100svh − 13rem`
a «lo que deja la ventana», y la deja en el mismo estado.

Además, las dos mediciones dependen una de la otra: el alto de A cambia el `top` de B, y el de B
cambia el `below` de A. Cada `fit` cambia el alto de `body` y vuelve a disparar el
`ResizeObserver` de la otra tabla. Converge por el tope de 240, pero puede dar uno o dos cuadros
de reacomodo (ver P2-1).

Arreglo: devolver `inventario-view.tsx:174` a `<Table>`. Si la cabecera fija interesa ahí, puede
quedarse por CSS, pero sin `useFillViewport`. Para pantallas con más de una lista (inventario
valorizado), hace falta una de dos: una opción para desactivar `useFillViewport` y conservar las
filas de 38 px, o decidir que el modo «llenar la ventana» solo aplica cuando hay una sola lista
en la página. Si es lo segundo, que el dueño lo decida y quede como `D-nnn`.

---

## P2: defecto menor que conviene corregir

### P2-1. Dos listas montadas a la vez se miden en cadena (posible reacomodo de varios cuadros)

`table.tsx:56-71`. Cada instancia observa `document.body`. En la página de P1-2, la fórmula de
cada una lee la altura de la otra, así que cada medición vuelve a disparar la otra. No hay bucle
síncrono: el callback solo agenda un `requestAnimationFrame`, y por eso no aparece «ResizeObserver
loop completed». Pero la secuencia A→B→A puede pintar alturas intermedias. Se resuelve con el
arreglo de P1-2. Si se mantiene el caso de dos listas, conviene coordinarlas con una sola medición
por página.

### P2-2. Un cuadro pintado con 240 px cuando llegan los datos

`table.tsx:63-71`. Mientras carga (esqueleto o pocas filas), la página es más corta que la ventana
y `room` = alto natural, así que se fija `max(natural, 240)`, normalmente 240. Cuando llegan las
filas, el `ResizeObserver` de la tabla agenda `fit` para el **siguiente** cuadro con
`requestAnimationFrame`, y el cuadro intermedio se pinta con 240 px. Se ve como un salto breve en
cada carga y en cada cambio de página.

Arreglo: hacer `fit()` directo dentro del callback del `ResizeObserver` (se ejecuta después del
layout y antes del pintado). Si con eso aparece el aviso de bucle, comparar el `maxHeight` nuevo
con el actual y escribir solo si cambia.

### P2-3. La barra horizontal fija queda tapada por `StickyActionBar` en los formularios

`table.tsx:184` (`fixed bottom-0 z-20`) contra `components/form/sticky-action-bar.tsx:102`
(`sticky bottom-0 z-20`). Los dos usan `z-20` en el mismo contexto de apilamiento, y la barra de
acciones va después en el DOM, así que se pinta encima y la tapa entera. La de acciones mide unos
56 px; la de desplazamiento, alrededor de 10. Afecta a los formularios con
`DocumentFormLayout`, `purchase-form`, `nueva-orden-view` y `nuevo-despacho-view` cuando la tabla
de líneas desborda: `sales-document-form.tsx:1408` usa `min-w-[62rem]`, y hay que verificar si
desborda a 1366 con el menú abierto. Además, la condición `rect.bottom > window.innerHeight`
(`table.tsx:147`) no tiene en cuenta que el borde visible real es el borde superior de la barra de
acciones. Ahí la ESPEC («siempre visible») no se cumple.

Arreglo: calcular `bottom` como la altura de cualquier `[data-slot=sticky-action-bar]` visible (o
una variable CSS que publique esa barra) y usarla en el estilo y en la condición. Otra opción es
subir la barra de desplazamiento a `z-30` y ponerla justo encima de la de acciones.

### P2-4. La barra fija dentro de un `Dialog` sale en el lugar equivocado

`table.tsx:178-189`. En `dialog.tsx:68`, `DialogContent` lleva `-translate-x-1/2 -translate-y-1/2`.
Un `transform` en un ancestro vuelve `position: fixed` relativo a ese ancestro y no a la ventana.
Con una tabla ancha (no lista) en un diálogo más alto que la ventana, `rect.bottom > innerHeight`
se cumple, y la barra se coloca con `left = rect.left` (coordenadas de la ventana) dentro del
diálogo. Queda corrida a la derecha el `left` del diálogo y pegada al borde inferior del diálogo,
que está fuera de la pantalla. Durante la animación de entrada de un `Sheet` (`slide-in`) pasa lo
mismo por unos 200 ms.

Arreglo: no montarla si `el.closest('[role=dialog]')` existe, o montarla con un portal a
`document.body` (`createPortal`), lo que además la saca de cualquier ancestro con
`transform`, `filter` o `contain`.

### P2-5. La barra fija es enfocable con teclado aunque tenga `aria-hidden`

`table.tsx:178-183`. Es un contenedor `overflow-x-auto` sin hijos enfocables. Chrome 130 o
posterior vuelve enfocables por teclado esos contenedores («focusable scrollers»). Cuando la barra
está visible, el Tab se detiene en un elemento `aria-hidden="true"`: es la regla de axe
`aria-hidden-focus`, y un lector de pantalla anuncia un foco sin nombre. El contenedor de la tabla
ya es enfocable y se desplaza con las flechas (cc27), así que la barra no aporta nada al teclado.

Arreglo: `tabIndex={-1}` en la barra.

### P2-6. `setBox` con un objeto nuevo en cada evento de scroll de toda la página

`table.tsx:145-149` y `:160`. `measure` escucha `scroll` en `window` con `capture: true`, así que
recibe también el scroll de **cualquier** elemento: la propia tabla, la barra, otras tablas,
sheets. Mientras la barra está visible, hace `setBox({...})` con un objeto nuevo en cada evento.
Eso significa un render por evento por cada tabla ancha montada, más el `useLayoutEffect`
(`:166-169`), que vuelve a escribir `bar.scrollLeft` mientras el usuario arrastra la barra. Hoy no
debería producir saltos (el valor coincide), pero cuesta trabajo innecesario y puede cortar el
desplazamiento suave o el de inercia del panel táctil.

Arreglo: comparar `left`, `width` e `inner` con el estado anterior y llamar a `setBox` solo si
cambian. Quitar el `useLayoutEffect` sobre `[box]` y sincronizar una sola vez al mostrar la barra.

### P2-7. El E2E no prueba los casos con riesgo y una aserción es trivial

`e2e/tests/listas-scroll-cc35.spec.ts`:

- Cubre solo `/clientes`: una lista, filtros en un renglón, a 1366×640 y no a 768. No cubre lo que
  motivó el cambio (filtros en dos renglones), ni una pantalla con dos listas (P1-2), ni que se
  conserve la posición al cargar o desplegar (P1-1), ni la barra horizontal fija, ni una tabla
  dentro de un detalle que «crece y desplaza la página». La ESPEC §5 tiene tres reglas y el spec
  prueba la primera.
- `:66-67`: `expect(title.y).toBe(titleBefore)` no puede fallar. Ya se comprobó que la página no se
  desplaza, y el scroll se aplica al contenedor y no a la ventana.
- `:62-65`: después de `el.scrollTop = el.scrollHeight` no se comprueba que `scrollTop > 0`. Si la
  cabecera no fuera fija pero el contenedor no se hubiera desplazado, la comparación `head.y ≈ box.y`
  pasaría igual. Conviene leer `scrollTop` y comparar contra la primera fila (por ejemplo, que la
  fila 0 quedó por encima de `head.y`).
- El `poll` de `scrollHeight − innerHeight ≤ 1` usa `window.innerHeight`, que incluye una eventual
  barra horizontal de la página. Es menor, pero la misma suposición está en el código (P3-2).
- Fragilidad: crea 30 clientes por corrida con llamadas en serie. Depende de que la vista de
  clientes tenga `tfoot` (lo pone `ListFooterRow`) y de que `pageSize` por defecto sea 50 o más
  (`DEFAULT_PAGE_SIZE = 50`). Si cualquiera de los dos cambia, falla lejos de la causa.
  `boundingBox()` sobre un `tfoot` que no existe espera hasta el timeout del test (180 s) en vez
  de fallar enseguida: conviene un `toBeVisible()` antes.

---

## P3: notas

### P3-1. Cabecera fija declarada dos veces

`globals.css:208-214` añade `position: sticky; top: 0; z-index: 10` a `thead` en modo lista, y casi
todas las vistas ya pasan `className="sticky top-0 z-10 bg-background"` a `TableHeader` (acabados,
auditoría, bobinas, catálogo, corte, flejes, líneas, reservas, usuarios, clientes,
`report-table.tsx:125`). No hay conflicto (los valores coinciden), pero hay dos fuentes de verdad.
Conviene quitar las clases de las vistas o dejar una nota de cuál manda. En inventario y kardex
la cabecera pasa a ser fija solo por el CSS. Kardex tiene dos renglones de cabecera agrupada, y
los dos quedan fijos juntos, que es lo esperado.

### P3-2. `window.innerHeight` en lugar de `documentElement.clientHeight`

`table.tsx:58` y `:147`. Si la página llegara a tener desborde horizontal, `innerHeight` incluye
la barra horizontal de la página. Entonces `room` sobra unos 10 px, la página se desplaza esos
10 px y vuelven las dos barras. `document.documentElement.clientHeight` no incluye esa barra.

### P3-3. `doc.scrollHeight` cuenta cualquier elemento absoluto que sobresalga

`table.tsx:57`. Un elemento `absolute` (no `fixed`) que sobresalga por debajo de la página, como
un menú, un tooltip o un popover sin portal, aumenta `below` y achica la lista mientras está
abierto. Al cerrarse, el `ResizeObserver` de `body` no siempre se entera, porque `body` no cambia
de tamaño por un desborde. Radix usa portales `fixed`, así que hoy no debería pasar. Queda como
nota.

### P3-4. La bandera `syncing` no evita nada

`table.tsx:150-155`. Los eventos `scroll` son asíncronos: cuando llega el evento del otro
elemento, `syncing` ya volvió a `false`. No hace daño, porque escribir el mismo `scrollLeft` no
dispara otro evento, pero el comentario implícito («evita el ping-pong») no es cierto. Si los
rangos difieren (por ejemplo, si el contenedor tiene borde o barra vertical y la barra no), al
final del recorrido puede haber un tironeo de un píxel. Se puede quitar, o comparar
`to.scrollLeft !== from.scrollLeft` antes de escribir.

### P3-5. Región desplazable vertical sin foco cuando no hay desborde horizontal

`table.tsx:108-117`. `tabIndex`, `role` y `aria-label` se ponen solo con desborde horizontal.
Ahora once pantallas más tienen un contenedor con desplazamiento vertical propio. En las que no
tienen nada enfocable en las filas (líneas, acabados, flejes sin acciones, el resumen de
inventario), axe `scrollable-region-focusable` puede marcarlo, y sin Chrome 130 o posterior el
teclado no puede desplazar las filas. Conviene poner `tabIndex={0}` también cuando
`scrollHeight > clientHeight` en modo lista.

### P3-6. El mínimo de 240 px deja dos barras en pantallas con contenido debajo de la lista

`table.tsx:35` y `:59`. Por diseño: si lo de arriba más lo de abajo deja menos de 240 px, la página
vuelve a desplazarse. Antes el alto era `100svh − 13rem` (≈ 560 px a 768). Una lista con
bastante contenido debajo (notas, otra sección) queda ahora más baja que antes. Hay que revisar a
1366×768 los reportes con tarjetas de indicadores arriba (`reporte-bobinas`, `ventas-margen`).

### P3-7. Sin `D-nnn` para el diseño

El diff de `docs/ARQUITECTURA.md` solo ratifica D-539 a D-544. Hay decisiones de diseño del corte
que merecen fila: el mínimo de 240 px, qué pantallas son «lista» (inventario y kardex entran), y
que la barra fija aplica a todas las tablas que no son lista. P1-2 pide además una decisión del
dueño sobre las pantallas con dos listas.

### P3-8. La barra fija tapa una franja del pie de un `Sheet`

En un `Sheet` con pie propio (botones) y una tabla ancha que pasa el borde inferior de la
ventana, la barra (`z-20`, dentro del contexto `z-50` del sheet) se dibuja sobre los ~10 px
inferiores del pie. Es menor.

---

## Lo que se miró y no dio hallazgo

- Fugas: los dos efectos quitan los listeners, desconectan el `ResizeObserver` y cancelan el
  `requestAnimationFrame`. La limpieza de `useFillViewport` deja `maxHeight = ''` y vuelve a la
  clase de cc31.
- SSR e hidratación: el alto inicial es la clase `max-h-[calc(100svh-13rem)]`, y el estilo inline
  solo lo escribe el efecto, que React no reconcilia (no hay prop `style`). `StickyHorizontalScroll`
  solo se monta tras medir en el cliente. No hay riesgo de desajuste de hidratación.
- Bucle síncrono de `ResizeObserver`: no lo hay. El callback agenda un `requestAnimationFrame`, y
  con una sola lista el alto de `body` vuelve al mismo valor dentro de `fit` (sin notificación
  nueva).
- Pestañas (catálogo, inventario): `TabsContent` de Radix desmonta las pestañas inactivas, así que
  no se mide nada oculto.
- Margen del marco: `below` incluye el `p-4` del contenedor de `AppFrame` y la paginación.
  `min-h-svh` del `SidebarProvider` hace que, con la página más corta que la ventana, `room` sea el
  alto natural (correcto).
- z-index frente a diálogos: la barra de la página (`z-20`) queda bajo el overlay `z-50` de
  `Dialog` y `Sheet`.

## Qué se hizo con los hallazgos (autor, cc35)

- **P1 posición del desplazamiento**: `fit` guarda y restaura `scrollTop`; el E2E lo comprueba cambiando el tamaño de la ventana.
- **P1 dos listas en una pantalla**: con dos o más `Table list` montadas no se reparte la ventana y las tablas crecen con la página (D-547). Inventario vuelve a `<Table>` (era un detalle con dos tablas).
- **P2 barra horizontal fija**: portal a `body`, `tabIndex={-1}`, no se monta dentro de un diálogo, se sube por encima de la barra de acciones de un formulario, solo actualiza el estado si cambia, mide con `requestAnimationFrame`, observa también la tabla (ancho interno al día) y quita la bandera inútil.
- **P2 E2E**: espera el `tfoot` y la paginación con tiempo corto, comprueba `scrollTop > 0`, que la página no se movió (`scrollY = 0`) y que volver a medir no la devuelve arriba.
- **P2 un cuadro a 240 px al llegar datos**: se deja; la medición va al cuadro siguiente para no encadenar `ResizeObserver` (riesgo de bucle). P3 sin cambio salvo `clientHeight`.
- **P3 D-nnn**: registrada D-547 (provisional).
