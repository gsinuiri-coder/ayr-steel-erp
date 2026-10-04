# Revisión de segundo modelo (Sonnet, contexto limpio) — cc19 / D-387

Alcance: todo `git diff 9d88277..HEAD` (14 archivos). Es la revisión de otro modelo, no una aprobación humana.
Verificado: `npx jest src/sales/imported-invoice-d387.spec.ts src/common` en `apps/api` (8 suites, 134 tests en verde) y `tsc --noEmit` de `apps/api` sin errores. No se corrió Playwright ni build.

## Resultado

**No encontré P0 ni P1.** El alcance por vendedor se conserva, el cambio de `QuotationDto` compila en todos los usos del API, y el componente `DispatchAtIssueDate` solo tiene un llamador (`comprobante-detalle-view.tsx:869`). Hallazgos P2 y P3 abajo.

## P2

### P2-1. El buscador mezcla el número del comprobante con el correlativo de otra cotización

`apps/api/src/common/search-seq.ts:164-169`, usado en `quotations.service.ts:1332` y `sales-orders.service.ts:3235`.
`searchSeqOf` extrae **todos** los dígitos del texto. Ahora que el buscador de cotizaciones acepta comprobantes, buscar `FFA1-1419` o `BBV1-347` produce `11419` y `1347`, y trae además `COT-011419` / `COT-001347` si existen (los datos reales ya tienen cotizaciones del orden de 341, 347, 1382). El resultado correcto se muestra mezclado con filas que no tienen nada que ver. Es comportamiento previo (`COT-000123`/`123`), pero D-387 lo vuelve visible.
Arreglo: comparar `seq` solo si el texto es un código o un número puro (`/^(COT|PED)?-?\d+$/i`), y no cuando trae una serie alfanumérica.

### P2-2. E2E frágil por el mismo motivo

`e2e/tests/comprobante-en-cotizaciones-d387.spec.ts`: `listed(api, \`search=${series}-999\`)`(esperado exactamente`[FFA1-999]`) y el `toHaveText([...-999])`de la UI.
Escenario: la serie es`Z???`sin dígitos, pero el texto`Z???-999`produce`seq = 999`. En una base de E2E longeva (los códigos de cotización crecen por corrida, ver memoria «recrear base de E2E») existirá la cotización `COT-000999`de otra prueba y la aserción de igualdad exacta falla de forma intermitente.
Arreglo: lo resuelve P2-1; mientras, buscar con`customerId` o filtrar la respuesta por cliente.

## P3

- **P3-1. `sort=invoice` trae todas las filas del filtro.** `quotations.service.ts:1426-1431`: `findMany` con `select { id, seq, notes }` sin límite, en cada cambio de página. Con miles de cotizaciones y observaciones largas es memoria por pantallazo. Acotarlo con `notes: { startsWith: 'Factura externa: ' }` por una consulta y las no importadas aparte (solo van al final por seq), o seleccionar solo la primera línea no es posible en Prisma; aceptable hoy, vale un comentario con el volumen medido.
- **P3-2. Consulta extra por cada búsqueda.** `idsByImportedInvoice` (`quotations.service.ts:1397-1411`) hace un `contains` insensible sin índice sobre `notes` en cada pulsación con debounce, aun cuando el texto no puede ser un comprobante (p. ej. nombre de cliente). Cortocircuitar si el texto no tiene la forma parcial de serie/correlativo (`/[A-Za-z0-9]{1,4}-?\d*/` mínimo) o si ya hay un `searchSeq` exacto. No hay fuga de alcance: los ids solo entran en un `OR` dentro del `where` con `quotationSellerWhere`.
- **P3-3. `%` y `_` en `contains`.** El texto buscado va tal cual al `contains` de las dos consultas; un `_` o `%` actúa como comodín en Postgres. El filtro en memoria (`includes`) lo corrige después, así que no hay falso positivo en la columna, solo candidatos de más. Menor.
- **P3-4. Desempate por `seq` siempre descendente** (`list-orderings.ts:108`), también con `dir=asc`: documentado en el comentario y el test, pero distinto al resto de columnas (donde el desempate sigue el orden de siempre). Sin impacto funcional.
- **P3-5. `DispatchAtIssueDate`.** Con la fecha del campo vacía el componente vuelve al plan por defecto (`setDispatchDate(value || undefined)`), correcto. Con error 5xx persistente se muestran dos reintentos antes del mensaje genérico; aceptable. La tarjeta se queda con `opacity-60` y el botón deshabilitado mientras recalcula: coherente con lo que prueba el E2E nuevo.

## Lo que revisé y está bien

- **Alcance por vendedor:** `idsByImportedInvoice` no filtra por vendedor, pero su resultado solo se usa dentro del `where` principal que ya incluye `quotationSellerWhere(actor)` por spread; `sort=invoice` usa ese mismo `where`. Un VENDEDOR no ve cotizaciones ajenas ni por búsqueda ni por orden.
- **Orden en memoria:** nulos al final en ambos sentidos; `compareImportedInvoiceNumbers` usa `Number` sobre ≤8 dígitos; páginas vacías y filas borradas entre las dos consultas se manejan (`flatMap`).
- **`searchSeqOf`:** el techo INT4 corrige el 500 por RUC; `'0'` sigue buscando `seq 0` sin romper.
- **Regresiones del DTO:** `externalInvoice` es requerido en `quotationSchema`; `tsc` del API compila; el único uso del componente tocado es el del comprobante.
- **Tests:** el spec unitario prueba lo que dice (columna, orden, buscador, RUC); el caso E2E de D-387 retiene la respuesta del plan y verifica mismo nodo y foco, que es la causa raíz del bug.
- **Reglas AGENTS.md:** sin migración, sin escritores de kardex, sin `number` para dinero; textos de UI en español.
