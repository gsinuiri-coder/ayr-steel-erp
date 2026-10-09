# Revisión de segundo modelo (Sonnet) — cc35 corte 1

Alcance: `git diff origin/main...origin/cc35-producir` (15 archivos): `table.tsx` (`useFillViewport`, `StickyHorizontalScroll`), `globals.css`, 11 vistas que pasan a `<Table list>`, `ARQUITECTURA.md` (ratificaciones D-539..D-544) y `e2e/tests/listas-scroll-cc35.spec.ts`. Solo lectura del código; no se corrió nada.

Resultado: sin P0. Un P1 (pantallas con dos tablas apiladas), cuatro P2, tres P3.

## P1

### P1-1. Pantallas con dos tablas en modo lista: las dos quedan en 240 px y la página vuelve a desplazarse

- Archivos: `apps/web/src/components/ui/table.tsx:55-60` (cálculo de `below`/`room`). Afecta a `apps/web/src/app/(app)/inventario/inventario-view.tsx:174` (dos `SummaryTable` seguidas: «Bobinas por tipo» y «Productos de catálogo») y a `apps/web/src/app/(app)/reportes/inventario-valorizado/inventario-valorizado-view.tsx:235` y `:261` (dos `ReportTable` en secciones apiladas). Mismo patrón posible en `reportes/produccion`, `ventas-margen` y `ventas-material` (dos `ReportTable` en el mismo archivo; verificar si se muestran a la vez o alternan).
- Escenario: en `/inventario` la primera tabla calcula `below = scrollHeight - rect.bottom`, que incluye entera la tarjeta de la segunda tabla. `room = innerHeight - top - below` sale ≤ 0 y se aplica el piso `LIST_MIN_HEIGHT_PX = 240`. La segunda tabla empieza más abajo del borde de la ventana y también recibe 240. Resultado: la página se desplaza y además cada tabla tiene su barra vertical propia: tres barras, lo contrario de «una sola barra». Antes de este corte `inventario-view` no usaba `list` y tenía un único desplazamiento con las filas completas; es una regresión de usabilidad (cada tabla enseña unas 6 filas).
- Arreglo sugerido: decidir el modo por pantalla, no por tabla. (a) En pantallas con más de una tabla, solo la última del flujo lleva `list` y las anteriores crecen; (b) repartir el alto disponible entre tablas hermanas; o (c) en esas pantallas, `Table` sin `list` (crece y la página se desplaza, la regla de detalle). ESPEC §5 no cubre pantallas con dos listas: conviene preguntarlo al dueño. Añadir un caso al E2E (P2-4).

## P2

### P2-1. La barra fija es `aria-hidden` pero puede recibir foco

- Archivo: `table.tsx:176-187` (div de `StickyHorizontalScroll`, `aria-hidden="true"` con `overflow-x-auto`).
- Escenario: Chrome (desde la 130) hace enfocables por teclado los contenedores con desplazamiento que no tienen hijos enfocables. Un elemento `aria-hidden` enfocable incumple la regla axe `aria-hidden-focus` y el usuario de teclado cae en un control invisible para lectores. El proyecto corre axe en detalles (cc27).
- Arreglo: `tabIndex={-1}` en la barra (la tabla real ya es la región enfocable con nombre).

### P2-2. `position: fixed` falla dentro de ancestros con `transform`/`translate` (diálogos y hojas laterales)

- Archivo: `table.tsx:176-187`; medición en `:150-153`.
- Escenario: una tabla no-lista más ancha que su contenedor dentro de un `Dialog` o `Sheet` de Radix (p. ej. `edit-received-purchase-dialog.tsx:358`, `sales-document-form.tsx:2674`, `confirm-quotation-dialog.tsx:142`). El contenido del diálogo se centra con `translate`, que crea un bloque contenedor para `fixed`: `left`/`bottom` se interpretan respecto al diálogo y no a la ventana, de modo que la barra sale desplazada o tapa contenido. Además `rect.bottom > innerHeight` compara con la ventana aunque quien recorta sea el diálogo. La ESPEC habla de páginas de detalle, no de diálogos.
- Arreglo: no montar la barra si `el.closest('[role="dialog"]')`, o renderizarla con `createPortal(..., document.body)` y medir en coordenadas de ventana.

### P2-3. `StickyHorizontalScroll`: trabajo por cada evento de scroll y ancho interno que puede quedar viejo

- Archivo: `table.tsx:148-170`.
- Rendimiento: el listener `scroll` en captura sobre `window` atiende todo desplazamiento (también el horizontal de la propia tabla y cualquier otro contenedor) y `setBox` guarda un objeto nuevo cada vez, así que cada evento re-renderiza aunque nada cambie. Con varias tablas anchas en un detalle hay un listener y un `getBoundingClientRect` por tabla por evento.
- Corrección: `inner: el.scrollWidth` solo se refresca cuando cambia el tamaño del contenedor (`observer.observe(el)`). Si las columnas se ensanchan por datos que llegan sin cambiar el ancho del contenedor, el recorrido de la barra fija difiere del de la tabla hasta el siguiente scroll de página o resize.
- Arreglo: comparar con el estado previo antes de `setBox` (devolver `prev` si es igual), y observar también `el.firstElementChild`. Agrupar mediciones con `requestAnimationFrame`.
- Nota: la bandera `syncing` (`:146-153`) no hace nada: los eventos `scroll` se despachan de forma asíncrona y la bandera ya volvió a `false`. La sincronización termina porque asignar el mismo `scrollLeft` no genera evento. Se puede quitar.

### P2-4. El E2E no demuestra todo lo pedido

- Archivo: `e2e/tests/listas-scroll-cc35.spec.ts`.
- Prueba bien: en `/clientes` a 1366x640 la página no se desplaza (`scrollHeight - innerHeight <= 1`), la tabla sí, el pie y la paginación quedan dentro de la ventana y la cabecera queda pegada tras bajar.
- Falta:
  1. Nada de la barra horizontal fija (`data-slot="table-sticky-scroll"`): aparición cuando el pie de la tabla queda bajo la ventana, ancho y posición, sincronía de `scrollLeft`, ausencia cuando cabe. Es la mitad de ESPEC §5 sin cobertura.
  2. Ninguna tabla dentro de un detalle (crece, la página se desplaza, sin barra vertical propia).
  3. Ni redimensionado tras la carga ni filtros partidos en dos renglones (el caso motivador de `useFillViewport`).
  4. Ninguna de las otras 10 pantallas que pasan a `list`, ni las de dos tablas (P1-1): solo se cubre `/clientes`.
  5. La aserción «el título no se movió» es trivial si la página no puede desplazarse.
- Arreglo: añadir un caso de detalle con tabla ancha (barra fija visible y sincronizada) y uno de `/inventario` con sus dos tablas; un cambio de `setViewportSize` en `/clientes`.

## P3

### P3-1. Estilos duplicados para la cabecera fija

- `globals.css` (bloque nuevo `thead` sticky para `data-density='list'`) y las vistas siguen poniendo `className="sticky top-0 z-10 bg-background"` en `TableHeader`. Redundante e inofensivo; dejar una sola fuente en un corte posterior. A comprobar a mano: con `border-collapse`, el borde inferior de una cabecera sticky no viaja con ella; si se nota, usar `box-shadow: inset 0 -1px 0 var(--border)`.

### P3-2. La fórmula depende del marco actual

- `table.tsx:52-70`. Funciona porque el documento es el que se desplaza y el alto del `body` lo fija el contenido (`min-h-svh` del `SidebarProvider`, `sidebar.tsx:146`). Si el marco pasa a `h-svh` con desplazamiento interno en `<main>`, `scrollingElement` y `scrollY` dejan de ser la referencia y falla sin avisar. Un comentario que ate la fórmula al marco y el E2E de redimensionado (P2-4) lo vigilan. No se encontró bucle de reajuste: `fit` deja el mismo alto si nada cambió, y `schedule` agrupa `resize` y observador.

### P3-3. Regla sin número de decisión

- `docs/ARQUITECTURA.md` solo ratifica D-539..D-544; la regla nueva (una sola barra en listas, tablas de detalle que crecen, barra horizontal fija al pie) no tiene `D-nnn` en este corte. Registrarla al cierre si queda como regla de producto.

## Revisado sin hallazgo

- `useFillViewport`: limpieza completa (cancela rAF, `disconnect`, quita `resize`, restaura `maxHeight`). Medir con `maxHeight: none` y fijar en el mismo cuadro evita parpadeo. Con pocas filas el alto es el natural (el `scrollHeight` mínimo del documento es la ventana, así que `below` descuenta el hueco). El primer pintado usa el `max-h-[calc(100svh-13rem)]` de cc31.
- `Table` sin `list` conserva `overflow-x-auto` y no tiene alto máximo: crece y la página se desplaza, como pide la ESPEC.
- Kardex: el `div.overflow-x-auto` que envuelve `<Table list>` (`kardex-sheet-table.tsx:67`) es un contenedor extra sin altura; no rompe nada y puede retirarse.

## Qué se hizo con los hallazgos (autor, cc35)

- **P1 posición del desplazamiento**: `fit` guarda y restaura `scrollTop`; el E2E lo comprueba cambiando el tamaño de la ventana.
- **P1 dos listas en una pantalla**: con dos o más `Table list` montadas no se reparte la ventana y las tablas crecen con la página (D-547). Inventario vuelve a `<Table>` (era un detalle con dos tablas).
- **P2 barra horizontal fija**: portal a `body`, `tabIndex={-1}`, no se monta dentro de un diálogo, se sube por encima de la barra de acciones de un formulario, solo actualiza el estado si cambia, mide con `requestAnimationFrame`, observa también la tabla (ancho interno al día) y quita la bandera inútil.
- **P2 E2E**: espera el `tfoot` y la paginación con tiempo corto, comprueba `scrollTop > 0`, que la página no se movió (`scrollY = 0`) y que volver a medir no la devuelve arriba.
- **P2 un cuadro a 240 px al llegar datos**: se deja; la medición va al cuadro siguiente para no encadenar `ResizeObserver` (riesgo de bucle). P3 sin cambio salvo `clientHeight`.
- **P3 D-nnn**: registrada D-547 (provisional).
