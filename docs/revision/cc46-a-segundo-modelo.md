# cc46 corte A: revisión de segundo modelo (282143ee..9e7004b8)

## Resumen

Revisé todo el diff (12 archivos) leyendo por SHA. No encontré P0, P1 ni P2. Cada corrección conserva el momento y los valores con que corre cada efecto, o los hace más estables, y no hay camino a bucles, peticiones repetidas, `router.replace` repetidos, guardados duplicados ni pisadas de lo que el usuario escribe. Dejo dos P3 y una nota de método: no corrí eslint, porque la consigna prohíbe tocar el repo, así que el «14 hallazgos corregidos» y «lint verde» no los verifiqué yo.

## Hallazgos

### P0 / P1 / P2

Ninguno.

### P3-1: `ventas-material-view.tsx:143`, el efecto de traducción de `range` ahora también depende de `url.from`/`url.to`

- Antes corría solo al cambiar `url.range`. Ahora también si cambian `from`/`to` mientras `range !== ''`.
- Escenario: enlace viejo `?range=month`. `useReportPeriod` y este efecto llaman a `setUrl` en el mismo tick, y `latest.current` fusiona ambos parches (el último escribe `range:''` y las fechas). Si por una carrera llegara una URL intermedia con `range` aún puesto y `from/to` distintos, el efecto se repite una vez. Es idempotente: quita `range` y converge.
- No hay bucle posible, porque la condición de salida (`range === ''`) la produce el propio efecto. No requiere cambio; lo anoto por trazabilidad.

### P3-2: refs escritos durante el render (`plan-adjust-dialog.tsx` openWith, `use-url-state.ts` commitRef)

- `openWith.current = ...` y `commitRef.current = commit` se asignan en el render, igual que el patrón ya existente `editsRef.current = edits` en `use-block-drafts.tsx`. Bajo render concurrente descartado, el ref puede quedar con valores de un render no confirmado.
- Impacto práctico nulo aquí: el efecto lee el ref tras el commit de la misma pintura, y en `plan-adjust` solo se lee al abrir. La regla `react-hooks/refs` del compilador queda fuera a propósito (D-606). Se puede dejar tal cual.

## Verificado sin hallazgos

- **`setUrl` estable** (`use-url-state.ts`): `useCallback([router, pathname])`. `useRouter()` del App Router de Next 15 es estable, y `pathname` solo cambia al navegar (el componente se desmonta o cambia de ruta). Los efectos de `report-period.tsx` (`useReportPeriod` y `useReportMonth`) y de `ventas-material` corren igual que antes. Los mocks de `useRouter` de los specs devuelven un objeto nuevo por render, pero solo `use-url-state.spec.ts` y `line-tabs.spec.ts` los usan y ninguno monta `useReportPeriod`, `useReportMonth` ni las vistas de reportes.
- **`report-period.tsx:70`, `url` en deps**: `url` es un `useMemo([searchParams])` y `search` (ya en deps) es `searchParams.toString()`. `url` cambia exactamente cuando cambia `search`, así que no hay ejecuciones nuevas. El efecto sale con `complete`, y `setUrl` lo hace verdadero: no hay bucle.
- **`mutate` estable** (`importar-compras-view.tsx`): en `@tanstack/react-query@5.102.8`, `useMutation` devuelve `mutate = useCallback(..., [observer])` y el observer es un `useState` fijo. Verificado en el fuente instalado. El efecto sigue disparándose solo con `docs`/`dirty`, con el mismo debounce, y el cleanup cancela el timer. La guarda de versión (`version.current`) no cambia.
- **Comprobante nuevo**: `linkableDispatches` pasa a `useMemo([dispatches.data])` y el efecto de preselección a `[salesOrderId, linkableDispatches]`. Antes dependía de `[salesOrderId, dispatches.data]`, así que dispara exactamente en los mismos casos. El filtro solo usa `dispatches.data` y constantes de módulo. Con `structuralSharing` de TanStack, un refetch con datos iguales conserva la identidad. `dispatchTouched` sigue protegiendo lo que eligió el usuario. Sin cambio de comportamiento.
- **Despacho nuevo**: `theoreticalLineWeight` pasa a función de módulo con `qtyByLine` como parámetro. Los dos efectos del peso (total y por línea) conservan sus deps, `[suggestedWeight]` y `[selectedLines, qtyByLine]`, y la lógica de «autollenado hasta que el usuario escribe» (`lastSuggestedWeightRef`, `wasAutoFilled`) quedó intacta. El `qtyByLine` que se pasa es el del mismo render, igual que la clausura anterior.
- **`importar-view.tsx` (cotizaciones)**: `allProducts` pasa a `useMemo([products.data])`. Solo estabiliza identidad mientras carga (`[]` nuevo por render) y los memos de abajo ya dependían de ella. Sin riesgo.
- **Planta, `planta-view.tsx`**: `belongs` es `useCallback([salesOrderId])`, y los memos pasan de `salesOrderId` a `belongs`. Cambian en el mismo momento (solo cuando cambia el pedido), así que `rows` y los efectos que dependen de `rows` no se repiten. La identidad de `pedidoRoofing`, `pedidoQueue` y `queueByOrder` es la de antes.
- **Planta, `plan-adjust-dialog.tsx`**: el efecto sigue con `[open]`. Los valores se leen del ref, que en el commit en que `open` pasa a `true` tiene lo mismo que habría capturado la clausura antes. Un refetch con el diálogo abierto no re-ejecuta el efecto ni pisa las filas. Sin cambio visible.
- **Planta, `produce-accessory.tsx` (migración del navegador)**: el efecto gana deps (`orderCoils`, `onSaved`, `putDraft`, `touchedDraft`) y puede re-ejecutarse en cada refetch de bobinas, pero la guarda `migrated.current === order.orderId` sale antes de cualquier lectura o escritura, y se fija antes del trabajo asíncrono. En StrictMode ocurre lo mismo. No hay segunda subida ni petición duplicada. La cadena asíncrona usa los valores de la primera ejecución (`orderCoils`, `putDraft`, `touchedDraft`), igual que antes con `order.coils` y `drafts`. `touched` lee `versions.current` en el momento de la llamada, así que «lo escrito gana» sigue funcionando. `onSaved` (`useDraftsCache`) es `useCallback([queryClient])`: estable.
- **`use-block-drafts.tsx`**: `touched` y `latestDrafts` pasan a `useCallback([])` y solo leen refs, por lo que el valor leído es siempre el vigente. Se quita una fuente de identidades cambiantes y no se altera `saveNow`, `enqueue`, `edit`, `put`, `flush` ni el cleanup de desmontaje (`[enqueue]`). Los dos usuarios del hook (`produce-blocks.tsx`, `produce-accessory.tsx`) pasan `onSaved` estable y un adaptador constante, así que el autoguardado no cambia de identidad por render. Los consumos `drafts.touched(...)` y `drafts.latestDrafts()` siguen compilando con la misma firma.
- **`useUrlSearchInput`**: `commitRef` lee el `commit` del último render al ejecutarse el efecto de `[debounced]`. Antes se usaba el `commit` del render en que `debounced` cambió, que es el mismo render en que corre el efecto. El efecto no se vuelve a disparar sin cambio del valor debounced, y `lastCommitted`/`ownCommits` siguen evitando commits repetidos y el pisado por ecos.
- **Configuración ESLint** (`packages/eslint-config/next.mjs`): `rules-of-hooks` y `exhaustive-deps` quedan como `'error'` explícitos. Es la forma correcta ante el preset de v6 sin `.rules`. No hay ningún `eslint-disable` en el diff, y `git grep react-hooks/` solo encuentra estas dos líneas.

## Límites de esta revisión

- No ejecuté eslint, typecheck ni specs (instrucción: no tocar el repo ni levantar procesos). Que no queden `exhaustive-deps` abiertos en el resto de `apps/web` y que los 14 hallazgos estén cubiertos lo debe demostrar la corrida de lint de la sesión o la CI.
- Sobre el 14, el diff muestra correcciones en 11 archivos de web, que cuadra con la cuenta, pero no lo cuento a partir del lint.
