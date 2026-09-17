# Handoff — RF-S3: Hardening (búsqueda server-side, card sin-stock agregado, PITR)

## 1. Resumen

Ventana de hardening sobre lo entregado en S1/S2: selectores de cliente/producto pasaron de
precargar el maestro completo a buscar en el servidor (M1), la card "Cotizaciones sin stock
disponible" pasó de un número de consultas que crecía con cada cotización emitida a una consulta
agregada de presupuesto fijo (M2), se ensayó una restauración PITR real sin tocar `production`
(M3) y se implementó la card sacrificable "SKUs con lista bajo piso" que RF-S1 había diseñado
sin código (M4). `revisor` encontró 2 hallazgos ALTO (uno de seguridad, uno funcional) y varios
menores, todos corregidos; `qa` encontró 7 regresiones reales en specs preexistentes por el
cambio de M1, las 7 corregidas y re-verificadas en verde con build de producción. Sin push
(regla dura 6): comandos al final de este documento.

## 2. Hecho

- **M0 — el flaky de `precios-lista-d217.spec.ts:255` no era un bug.** Reproducido con
  `--repeat-each=10`; causa real confirmada: prefetch de rutas de un `next dev` recién
  levantado (Fast Refresh se dispara varias veces por segundo mientras el sidebar precompila
  rutas en frío), no una carrera del producto ni contaminación entre agentes. Sin cambios de
  código de producto. Detalle completo en `docs/PROGRESO.md`.
- **M1 — búsqueda server-side (D-229).** `GET /customers/search` y `GET /catalog/search`
  (`packages/shared/src/schemas/search.ts`: `SEARCH_MIN_CHARS=2`, `SEARCH_RESULT_LIMIT=20`,
  `rankSearchMatches` — prefijo antes que contiene). `q` vacío u omitido es válido (primeros N
  sin filtro), 1 carácter muestra el aviso de mínimo. `SearchSelectField`/`SearchSelectModal`
  (`apps/web/src/components/search-select-modal.tsx`) ganan modo async con debounce de 250ms,
  loading e hidratación por id (`selectedOption`/`selectedOptionLoading`) para que editar una
  cotización/pedido viejo nunca muestre el selector vacío. `ProductStockPickerDialog`
  (`apps/web/src/components/sales/product-stock-picker.tsx`) cambia de fuente sin cambiar de
  forma (D-188 intacto). Sin índice nuevo (D-229, volumen de hoy no lo justifica).
- **M2 — card sin-stock agregado (D-228).** `findStockShortages`
  (`apps/api/src/sales/sales-orders.service.ts`) reescrito: `resolveLinesForShortages` +
  `availabilityForShortages` con consultas batcheadas — presupuesto fijo, no crece con N
  cotizaciones ni con M líneas. `available = baseAvailable(item) + ownTemporary(Q, item)`,
  algebraicamente equivalente al `{exceptQuotationIds:[Q]}` de antes. Test de invariancia de
  conteo de consultas + equivalencia funcional contra casos de borde
  (`apps/api/src/sales/stock-shortages.spec.ts`).
- **M3 — ensayo de restauración PITR**, con OK del dueño por nombre. Rama
  `ensayo-pitr-20260917` creada y restaurada (~1h atrás) con el patrón de dos pasos de
  `neonctl` (`branches create --parent production`, después `branches restore <rama>
"production@<timestamp>"`). Retención real medida: 6h (no los 7 días del plan). Conteos de
  tablas clave idénticos entre la rama y `production`. Procedimiento completo, RPO/RTO y cómo
  repuntar la API en un incidente real en `docs/ENTORNOS.md`.
- **M4 (sacrificable) — card «SKUs con lista bajo piso» (D-224).** `findPriceListFloorSummary`
  (`apps/api/src/catalog/catalog.service.ts`) reusa `computePriceFloors` (D-150) batcheado
  sobre el catálogo activo. `GET /catalog/price-list/floor-summary`, solo ADMINISTRADOR.
  Card nueva en el Panel (`apps/web/src/app/(app)/price-floor-summary-card.tsx`), con link a la
  fila resaltada en `/catalogo?bajoPiso=<id>`.
- **Correcciones de `revisor`:** falta de `@Roles(Role.ADMINISTRADOR)` en el endpoint de M4
  (ALTO, seguridad); `SearchSelectField` mostraba "no está entre las opciones" mientras
  hidrataba (ALTO, funcional); montos de M4 sin `formatMoney`; paralelización de specs de
  materia prima en M2; constante compartida para el sentinel `?bajoPiso=`; 400 en
  `businessLine` inválido de `/catalog/search`; test de dos líneas de una cotización compitiendo
  por el mismo ítem.
- **Correcciones de `qa` (7 regresiones reales de M1 en specs preexistentes, no en M1 mismo):**
  (A) 5 specs pasaban la etiqueta compuesta "Nombre — RUC/DNI" completa como texto de búsqueda,
  que ya no matchea contra un `WHERE` que busca `name`/`docNumber` por separado —
  `chooseOption` (`e2e/helpers/ui.ts`) gana un parámetro `searchText` opcional, los 5 specs
  pasan el RUC/DNI. (B) el selector de cliente no mostraba nada al abrir sin escribir, rompiendo
  D-156 — corregido con `q` vacío válido (ver M1 arriba), no solo en los tests. Una sexta falla
  (mismo archivo, no reportada por `qa`) por un texto de UI que M1 cambió ("N de M productos" →
  "N resultados"). Los 5 specs afectados re-verificados con build de producción: 18/18 verde.

## 3. Decisiones tomadas

- **D-228** — presupuesto de consultas fijo para `findStockShortages`, independiente de N
  (cotizaciones) y de M (líneas por cotización); verificado con test de invariancia.
- **D-229** — sin índice nuevo para la búsqueda server-side de M1; el volumen actual de
  clientes/productos activos no lo justifica.

## 4. Bloqueos / pendientes

Nada bloqueado al cierre. Deuda que esta sesión deja o hereda sin cambios:

1. **Rama Neon `ensayo-pitr-20260917`**: se borra solo con OK del dueño por nombre, y solo
   después de que confirme que ya la revisó.
2. **Repuntar la API a una rama restaurada (secretos + deploy) no se ensayó** — es el paso real
   de un incidente que esta ventana no simuló; procedimiento documentado en `docs/ENTORNOS.md`,
   sin ejecutar.
3. **Nadie cargó todavía precios de lista reales contra el catálogo de `production`** (deuda de
   D-217/D-224, sin cambios): la card de M4 no tiene nada que mostrar en producción hasta que
   eso pase.
4. **Drift de schema en `production`** (deuda S3 #1, heredada, sin tocar): defaults de
   `operation_date` en 5 tablas, 5 FK recreadas, 2 índices y un renombre.
5. **El guard por línea de pedido no descuenta notas de crédito** (D-223, heredada, sin tocar).
6. Suite E2E completa re-corrida una vez más tras las correcciones para confirmar el número
   final de cierre — ver `docs/PROGRESO.md` para el resultado (pendiente al momento de escribir
   este handoff, corriendo en background).

Ninguno requiere acción humana externa (proveedor, soporte) salvo la aprobación de borrado de
la rama de ensayo Neon (punto 1) y la carga de precios de lista reales (punto 3), ambas del
dueño.

## 5. Cómo verificar

```bash
# Tests nuevos de esta ventana
pnpm --filter @ayr/api test -- stock-shortages price-list-floor-summary catalog.controller
pnpm --filter @ayr/shared test -- search

# Suite E2E completa (worktree, build de producción — en dev el host hace OOM cerca del test 308)
pnpm exec playwright test

# Un spec puntual afectado por M1
pnpm exec playwright test e2e/tests/busqueda-selectores-rf-s3-m1.spec.ts

# Búsqueda server-side a mano (con sesión activa)
curl -s "http://localhost:3000/customers/search?q=ac" -H "Cookie: <cookies de sesión>"
curl -s "http://localhost:3000/catalog/search?q=bo" -H "Cookie: <cookies de sesión>"

# Card de M4 (solo ADMINISTRADOR)
curl -s "http://localhost:3000/catalog/price-list/floor-summary" -H "Cookie: <cookies de sesión>"
```

Rama de ensayo PITR (borrar solo con OK del dueño por nombre):

```
# el dueño confirma por nombre "ensayo-pitr-20260917" antes de correr esto
neonctl branches delete ensayo-pitr-20260917 --project-id <project-id>
```

## 6. Siguiente sesión

**S4 (Opus) — inventario valorizado/merma + CxC**, por plan. Antes de arrancar, revisar si el
dueño quiere resolver primero alguna de las deudas de la sección 4 (en particular el guard de
notas de crédito, que toca facturación real, y la carga de precios de lista reales que M4
necesita para mostrar algo en producción).
