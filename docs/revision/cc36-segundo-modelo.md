# cc36 — Revisión del segundo modelo (Sonnet)

Fecha: 2026-10-09
Alcance: `git diff 0ee7198b -- apps e2e` (incluye lo no commiteado; se ignoran `e2e/tests/zz-cc36-*.spec.ts`).
Método: lectura del diff completo contra `0ee7198b`, lectura de las rutas del API que el selector ahora usa sin filtro de línea (`GET /catalog/search`, `GET /sales/stock-panel`), `tsc --noEmit` de `apps/web` (sin errores) y `prettier --check` sobre los archivos tocados. No se corrieron E2E ni unitarios.

## Resumen

| Sev. | N.º | Hallazgo |
| ---- | --- | -------- |
| P0 | 0 | Ninguno |
| P1 | 1 | `prettier --check` falla en 3 specs E2E (la CI de formato fallará) |
| P2 | 2 | Una venta de bobina nueva ya no puede pasar a «importe sin IGV»; con «Todas» el aviso «puede haber más» se pierde en pedido directo |
| P3 | 5 | Ver abajo |

## Lo confirmado sin hallazgo (P0)

- **El JSON enviado al API no cambia por lectura.** Ningún hunk toca `buildPayload`, `validate()`, `linePricing`, `lineValues`, `sentQty`, `isUntouched`, `chooseProduct`, `setLineKind` ni `chooseSaleCoil`. El único cambio en la zona de validación es `lineIssue` (la barra inferior, solo informativa): quitó el chequeo `businessLine === ''`, que ya lo cubre `productId === ''` porque elegir producto fija siempre la línea.
- `QuietDecimalInput` / `displayDecimal` solo cambian lo que se pinta: el borrador (`l.pricePen`, `l.qty`, `l.netAmountPen`) no se reescribe al enfocar ni al salir sin teclear; solo se actualiza con `onChange`. Se usa `Decimal` (`displayDecimal`, `lineNeed`, `commitmentRows`); no hay `number` en dinero, kg ni mm. El único `Number(...)` del formulario (`piecesHint`) ya existía.
- `mmToMetersShort` vuelve a los mismos mm con `metersToMm`; el fingerprint de cambios sin guardar se calcula con la misma transformación al abrir, así que no marca el formulario como modificado.
- `/catalog/search` y `/sales/stock-panel` aceptan la ausencia de `businessLine` (verificado en `catalog.controller.ts`, `catalog.service.ts` y `stockPanelQuerySchema`). Sin línea el agregado de materia prima viene vacío, pero `rawMaterialAvailableKg` por producto sale de `productStock`, así que el estado de cada línea no depende de eso.
- `CoilSalePickerDialog` ahora se monta en todas las filas, pero su query tiene `enabled: open`: no hay consultas extra.
- Textos: tuteo correcto («Escribe…», «Corrígelo…»), sin D-nnn ni ccNN en texto visible (solo en comentarios y nombres de `describe`).
- Casos borde leídos: línea importada (el `original` se conserva igual que antes), bobina entera (`product` queda `undefined`, igual que antes porque `setLineKind` y `convertToCoil` vacían `productId`), plancha por plancha (el panel es obligatorio y la cantidad sigue en `Planchas de la línea N`), servicio sin inventario (chip neutro «Servicio · sin inventario», fuera del bloque de material), accesorio con piezas (el panel arranca abierto si `piecesHint` tiene valor).

## Hallazgos

### P1 — `format:check` falla en 3 specs E2E

- Archivos: `e2e/tests/alcance-vendedor-ui.spec.ts` (~línea 49-52), `e2e/tests/huecos-cobertura-f8s2b.spec.ts` (~línea 172-174), `e2e/tests/plancha-largo-d166.spec.ts`.
- Descripción: al borrar los pasos «Línea de negocio de la línea 1» quedaron dos líneas en blanco seguidas (y en `plancha-largo-d166` un salto de formato). `prettier --check` reporta estos tres archivos; es la CI la que lo detiene (nota de memoria: `turbo lint/typecheck` no corre Prettier).
- Reproducción: `node_modules/.bin/prettier --check e2e/tests/alcance-vendedor-ui.spec.ts e2e/tests/huecos-cobertura-f8s2b.spec.ts e2e/tests/plancha-largo-d166.spec.ts`.
- Sugerencia: `pnpm exec prettier --write` sobre esos tres archivos antes del push.

### P2-1 — Una línea de bobina nueva ya no puede cargarse por «importe sin IGV»

- Archivo: `apps/web/src/components/sales/sales-document-form.tsx` (~2103-2118, el botón «Cargar importe sin IGV» dentro del panel; `hasPanel` exige `l.kind === 'PRODUCT' && product !== undefined`, ~1693).
- Descripción: antes el botón estaba bajo el precio en toda línea no plancha, incluida la venta de bobina entera (`kind === 'BOBINA'`). Ahora solo existe en el panel de una línea de producto. Una bobina nueva solo llega a modo `AMOUNT` si viene de `convertToCoil` (línea importada). El enlace de vuelta «Cargar precio con IGV» sí sigue en la celda de precio.
- Reproducción: `/cotizaciones/nueva` → «Bobina completa» → elegir bobina → no hay forma de negociar el total en vez del precio por kg.
- Impacto: pérdida de una capacidad de UI; el JSON no cambia. Si el diseño aprobado la quita a propósito, basta registrarlo; si no, hay que dejar el enlace también para BOBINA.
- Sugerencia: mostrar el enlace bajo el precio cuando `l.kind === 'BOBINA'` (o confirmar con el dueño que no se necesita).

### P2-2 — Con «Todas», el aviso de «puede haber más» se calcula después del filtro local

- Archivo: `apps/web/src/components/sales/product-stock-picker.tsx` (~255-278).
- Descripción: `matches` ya está filtrado por `allowed` (líneas que admite el documento) y `mayHaveMore = matches.length === SEARCH_RESULT_LIMIT` se evalúa sobre esa lista. El servidor devuelve hasta 20 resultados de todas las líneas; en un pedido directo, los de líneas que exigen cotización ocupan cupo y luego se descartan. Si de 20 devueltos se descartan 3, `matches.length` es 17: el aviso desaparece y el vendedor no sabe que hay más productos que su texto no mostró.
- Reproducción: `/pedidos/nuevo` → «Producto» → «Todas» sin escribir (o con un texto que coincida con varias coberturas) → la lista queda en menos de 20 sin la advertencia.
- Sugerencia: calcular `mayHaveMore` sobre `productsSearch.data?.length` (el crudo), no sobre `matches`.

### P3 — Observaciones menores

1. **Estado de «Material que compromete» parpadea.** `sales-document-form.tsx` ~1259-1275: `commitment` solo se calcula con `stockPanel.isSuccess`, y la clave de la query cambia con cada producto elegido (`['stock-panel', línea, ids]`), sin `placeholderData`. Cada elección hace desaparecer y reaparecer el bloque (salto de altura del pie) y, mientras tanto, el chip de la línea nueva dice «Sin dato de materia prima». Sugerencia: `placeholderData: keepPreviousData` en esa query.
2. **Botón de producto con catálogo sin cargar.** ~1730-1745: al editar con el catálogo todavía en vuelo, `product` es `undefined` y el botón dice «Elegir producto» aunque la línea ya tenga `productId`. Antes decía «Producto»; ahora además invita a elegir. Sugerencia: si `l.productId !== ''` y `!product`, mostrar «Cargando…».
3. **Pérdida de descubribilidad.** «Cargar importe sin IGV», la descripción para el cliente y las piezas del accesorio quedan detrás de «⋯» salvo que ya tengan dato. Es decisión de diseño; basta confirmarla con el dueño. «⋯» tiene `aria-expanded` pero no `aria-controls`.
4. **E2E con menos fuerza que antes.** (a) `toHaveValue('11.8000')` → `'11.80'` en `busqueda-selectores`, `precios-lista-d217`, `cotizacion-sin-vencimiento`, `flujo-comercial`, `plancha-importada`: ya no se prueba el campo a 4 decimales ni, en ninguno, el valor enviado; la prueba que lo hacía (`zz-cc36-payload`) es temporal. Conviene dejar al menos una aserción permanente de la petición (`page.waitForRequest` con el cuerpo) para el precio sembrado de 4 decimales. (b) `plancha-largo-d166`: `toContainText('3.00 m')` también aceptaría «13.00 m»; mejor una regex con borde. (c) No hay prueba que verifique que `/pedidos/nuevo` no ofrece las líneas que exigen cotización en el buscador (D-065); antes lo hacía por construcción el desplegable y ahora lo hace el filtro local `allowed`. (d) Comentarios obsoletos: `alcance-vendedor-ui.spec.ts` dice «requerido para habilitar el botón de producto»; el botón ya no depende de la línea.
5. **Cambio de diálogo en el mismo tick.** `coil-sale-picker.tsx` «Vender un producto en su lugar» y el chip «Bobina completa» cierran un diálogo y abren otro en el mismo evento. No se pudo comprobar en navegador si Radix devuelve el foco al disparador del primero antes de que el segundo capture el suyo; vale una pasada manual con teclado.

## Estado de React

- `useState(autoOpenPicker)` y `useState(() => descriptionEdited || piecesHint)` leen la prop solo al montar; como las filas llevan `key={l.key}` no se remontan, así que el efecto es el deseado (abrir al nacer). `pickerFor` queda apuntando a la última fila agregada pero no reabre nada.
- `QuietDecimalInput`: `editing` solo se activa con `onChange`; con el cursor en «35.40» (borrador «35.4000») un dígito nuevo da «35.401». Es lo que el comentario declara (se guarda lo que se ve); sin hallazgo.

## Accesibilidad

- Botones de icono con `aria-label`, `sr-only` en la columna de acciones, `role="group"` con nombre en el panel, chips de estado como `button` con texto accesible. Sin hallazgo bloqueante.

## Veredicto

**Aprobado condicionado.** No hay P0. Corregir antes del deploy el **P1** (Prettier) y decidir los dos **P2** (rápidos: el segundo es una línea). Los P3 pueden quedar como deuda anotada. Lo enviado al API es igual que antes para las mismas acciones del usuario, según la lectura del diff; se recomienda además correr la comparación antes/después de `zz-cc36-payload` ya construida y la suite E2E completa con builds de producción, que esta revisión no ejecutó.

## Respuesta de la sesión (2026-10-09)

- **P1 formato de specs:** corregido (`prettier --write` sobre `e2e/tests`).
- **P2 «Cargar importe sin IGV» en la venta de bobina:** corregido; vuelve debajo del precio en la
  línea de bobina, que no tiene panel.
- **P2 `mayHaveMore` en «Todas»:** corregido; se calcula sobre lo que devolvió el servidor y, si el
  descarte por línea ocultó resultados, el buscador lo dice y sugiere filtrar por línea (D-551).
- **P3 parpadeo del bloque y del estado al elegir producto:** queda como deuda (la consulta del panel
  cambia de clave; ya pasaba con la celda anterior).
- **P3 «Elegir producto» con el catálogo sin cargar:** queda; el botón de guardar sigue apagado hasta
  que llega el catálogo, como antes.
- **P3 panel detrás de «⋯»:** decisión de diseño registrada (D-552). `aria-controls` queda pendiente.
- **P3 E2E más débiles:** la comparación del JSON enviado se hizo con un spec temporal antes y después
  (idéntico; `local-data/cc36/payload-*.json`). La regla D-065 en el buscador queda sin E2E propio
  (deuda anotada en el handoff).
- **P3 foco al pasar de un diálogo a otro:** revisado a mano en el navegador local (ver capturas).
