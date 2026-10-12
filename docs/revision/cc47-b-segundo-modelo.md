# cc47 corte B — revisión del segundo modelo (Sonnet)

Rango revisado: `84c616ed..49828815` (32 archivos, solo web + E2E). Revisión estática del diff y de los
archivos completos en `49828815`; además `tsc --noEmit` en `apps/web` y `eslint` sobre los archivos más
tocados: ambos limpios. No corrí Playwright (ninguna aserción E2E está verificada en ejecución).

## Veredicto

Sin P0 ni P1. El componente compartido (`TableToolbar`, `FiltersDialog`, `FilterField`, `ToolbarSearch`) está
bien armado: el borrador se descarta al cerrar, «Aplicar» escribe todo en un solo `replace`, «Limpiar» aplica
el vacío y cierra, y el conteo de activos sale de la URL. Los filtros y el buscar siguen en la URL en todas
las listas que ya los tenían. Hay cuatro hallazgos P2 y varios P3.

## P0 / P1

Ninguno.

## P2

### P2-1. Aserciones de ausencia que ya no prueban nada (`e2e/tests/fase7e-ajustes-d121.spec.ts:58,70,82`)

Las tres líneas hacen `expect(page.getByRole('combobox', { name: 'Estado' })).toHaveCount(0)` en las pestañas
«Disponibles», «En corte» y «Terminadas» de `/bobinas`. Antes el selector vivía en la barra y la aserción
demostraba que no aparecía fuera de «Todas». Ahora el selector solo existe dentro del modal cerrado, así que el
conteo es 0 siempre: si el campo «Estado» se mostrara en todas las pestañas dentro del modal, el test seguiría
verde.
Corrección: en cada pestaña abrir `openFilters(page)` y comprobar
`modal.getByRole('combobox', { name: 'Estado' })` con `toHaveCount(0)`, cerrando con Escape (como ya se hace
en «Todas», líneas 91-94).

### P2-2. El PDF del reporte de bobinas no recibe el buscar (`apps/web/src/app/(app)/reportes/bobinas/reporte-bobinas-view.tsx`, `aside`, enlace `/api/reports/coils/pdf?${qs}`)

Mes = septiembre, pestaña Drywall, buscar «azul»: el Excel se pide con `xlsxHref(..., searchText)` y trae solo
las bobinas que se ven; el PDF se pide con `month=…&businessLine=…` y trae todas. El pedido dice «Excel y PDF con
el mismo contenido y recibiendo buscar y filtros activos». Es previo al corte B (el PDF ya era así), pero el
corte B lo puso junto al buscar en la línea estándar, que ahora sugiere que lo respeta. No toqué el API: si
`/reports/coils/pdf` no acepta `search`, queda como excepción a documentar; si lo acepta, basta `&search=…`.
Confirmar con el dueño cuál de las dos.

### P2-3. «Cada pestaña con su línea estándar» (D-617) no se cumple parejo

- `inventario-view.tsx` (`LinePanel`): «Bobinas por tipo» lleva `TableToolbar` (solo el Excel), «Productos de
  catálogo» no lleva línea alguna.
- `reporte-bobinas-view.tsx` pone buscar, mes y Excel/PDF una sola vez encima de las pestañas
  «Selladas/Abiertas»; `inventario-valorizado-view.tsx` repite la línea dentro de cada pestaña. Mismo patrón,
  dos soluciones.
  Corrección: elegir una regla (la línea dentro de cada pestaña, o una vez encima cuando es común) y aplicarla
  a las tres pantallas, o documentar que sin buscar, filtros ni Excel una pestaña no lleva línea.

### P2-4. Tablas sin línea estándar, por decisión implícita

Páginas con tabla de lista fuera de `TableToolbar`: `acabados`, `lineas`, `usuarios`, `reservas-temporales`,
`configuracion/tipo-cambio`, `configuracion/margenes`, `proveedores/[id]/estado-cuenta`. Ninguna tiene buscar,
filtros ni exportación, así que una línea vacía no aportaría; pero el pedido dice «encima de toda tabla del
sitio». Conviene que el dueño confirme «sin buscar, sin filtros y sin Excel no hay línea», y que el E2E de «sin
línea» la fije (hoy solo recorre `/clientes`, `/proveedores` y `/reportes/inventario-valorizado`).
No encontré ningún filtro suelto (`FilterChip`, `StatusFilter`, `Segmented` de filtro, `<Select>` de filtro,
`type="search"`) fuera del modal en listas y reportes. Los que quedan fuera son el «Ver por» (a la derecha,
correcto) y el `StatusFilter` de `components/production/order-history.tsx` (detalle de OP, fuera de alcance).

## P3

- P3-1. JSDoc huérfano: en `reporte-bobinas-view.tsx` (bloque «cc24 (D-408, D-418)…» sobre `LINE_TABS`) y en
  `ventas-material-view.tsx` (bloque de `VentasMaterialView`) el comentario largo quedó pegado a lo nuevo
  (`/** cc47 (D-617)… */ const TABLE_TABS`, `/** cc47 (D-615)… */ type MaterialFilters`) porque se insertó código
  entre el comentario y su dueño. El IDE mostrará la documentación equivocada.
- P3-2. `kardexCustomPatch` (`apps/web/src/lib/kardex-range.ts`) ya no la usa ninguna pantalla (la reemplazó el
  borrador del modal); queda exportada y con spec. Retirarla o anotar por qué se conserva.
- P3-3. `ventas-material-view.tsx`: «Aplicar» escribe `from`/`to` con `setUrl` directo y no por
  `periodState.setPeriod`, así que `chosen` (atajo elegido) no se actualiza. Solo importa cuando dos atajos dan
  las mismas fechas (en enero, «Este año» y «Este mes»): el botón mostrará 0 filtros aunque se eligiera «Este
  año». Sin efecto en datos.
- P3-4. Auditoría: los filtros siguen en estado de pantalla y no en la URL (como antes; el pedido dice «como
  hoy»), y ahora «Aplicar» es la única vía; refrescar los pierde. Aceptable; anotarlo en el UAT.
- P3-5. `Tabs` con `activationMode="manual"` (Inventario, Inventario valorizado, Reporte de bobinas): con las
  flechas se enfoca pero hay que pulsar Enter/Espacio para activar. Difiere de las pestañas de línea; confirmar
  que es lo querido.
- P3-6. `reportes-seis-cc32.spec.ts` (última prueba, ~líneas 356-363) fija `from=2026-09-01&to=2026-09-30` y
  espera «Filtros, 2 activos». Hoy (octubre 2026) septiembre es «Mes anterior» y desde noviembre un rango libre:
  en ambos cuenta como filtro y pasa; solo fallaría ejecutada en septiembre de 2026. Mejor derivarlo de
  `previousMonth(today)` como el resto del archivo.
- P3-7. Cosmético: los botones de `HeaderActions` (Excel, PDF) en la línea estándar son `Button` de tamaño
  normal junto a un buscar `h-8` y un «Filtros» `sm`; alturas distintas en la misma fila. Mirar en el UAT visual.
- P3-8. `FiltersDialog`: el `aria-describedby` del error está en el `<form>` y solo aparece tras intentar
  aplicar; el mensaje se anuncia igual por `role="alert"`. Sin pérdida real.

## Lo que revisé y está bien

- **Estructura D-616.** Reportes: título, pestaña de línea, totales (`Figures`/`StatStrip`), línea estándar,
  tabla, totales por línea en `Section` (franja gris: «Totales por línea de negocio» en Inventario valorizado,
  «Subtotales por tipo» en Ventas por material). Los avisos de periodo inválido pasaron debajo de la línea con
  «Elige otro periodo en “Filtros”».
- **URL.** Compras, comprobantes, bobinas, pedidos, cotizaciones, despachos, catálogo, corte, flejes, CxC y
  ventas por material: «Aplicar» llama a `setUrl` con todas las claves; `useUrlState` borra las que valen su
  default y vuelve a la página 1. Kardex traduce el borrador a `range`/`from`/`to` sin cambiar el contrato.
  Pestañas de tabla (`?tabla=`) con `useUrlTab` (`router.push`), y `tabla` agregado a `keep` de las pestañas de
  línea.
- **Periodo entre reportes.** `useReportPeriod`/`useReportMonth` siguen guardando el periodo en la sesión;
  «Aplicar» y «Limpiar» pasan por `setPeriod`/`setMonth` (salvo P3-3), así que el siguiente reporte parte del
  periodo elegido.
- **Excel.** Todos los Excel que tenían buscar o filtros siguen armándose con los mismos `params` o
  `xlsxHref(..., searchText)`; solo cambiaron de lugar. Compras conserva «Recibir seleccionadas» a la derecha.
- **Sin filtros, sin botón.** `/clientes`, `/proveedores`, `/reportes/inventario-valorizado`: línea sin
  `FiltersDialog`.
- **E2E tocados** (auditoría, catálogo-inactivos, correcciones-03 listas/kardex, cxc/merma, film-bobina,
  reportes-por-línea, reportes-seis, excel-listas): abren el modal, aplican y verifican URL y contador «Filtros,
  N activo(s)»; film-bobina y reportes-seis cambian de pestaña de tabla antes de mirar «Abiertas»/«Productos».
  `headerAction` (acotado a `[data-slot="header-actions"]`) encuentra el Excel en la línea estándar, así que
  `excel-listas-cc26` sigue válido. Los `getByLabel('Buscar …')` funcionan con `type="search"`. Busqué en
  `e2e/` nombres de selectores, chips y textos de la UI vieja («Mes actual», «Solo con saldo», «Vendedor»,
  «Atendidos», placeholders, `periodo*`) y no quedan specs sin tocar que dependan de ella.
- **Riesgo de CI.** La primera prueba nueva recorre 18 pantallas en una sola prueba (300 s). Con builds de
  producción en CI es holgado; con dev builds locales puede acercarse al tope por la compilación en frío. Si
  aparece rojo, clasificarlo como infraestructura antes que producto.

## Qué se hizo con cada hallazgo

- **P2-1 (E2E de bobinas sin fuerza):** corregido; las reglas por pestaña (estado solo en «Todas», film en «Disponibles» y «Todas») se comprueban dentro del modal. El test del estándar también busca `<select>` nativos sueltos.
- **P2-2 (PDF del reporte de bobinas sin buscar):** sin cambio. El PDF lo arma el API y ya no recibía el buscar antes de cc47; agregarlo es una pieza de API. Queda anotado para el dueño.
- **P2-3 (D-617 desparejo):** en el reporte de bobinas la línea queda encima de las pestañas a propósito: lleva el mes, que tiene que poder corregirse aunque el mes de la URL sea inválido (con un mes inválido las pestañas no se pintan). En `/inventario`, «Productos de catálogo» no tiene buscar, filtros ni descargas: no lleva línea.
- **P2-4 (listas sin línea):** las listas sin buscar, sin filtros y sin descargas no llevan línea (no hay qué poner). Queda como decisión registrada para que el dueño la confirme.
- **P3:** el atajo elegido en Ventas por material se recuerda (`choosePreset`); «Aplicar» o «Limpiar» sin cambios ya no escriben la URL. Se anotan los demás.
