# Revisión de segundo modelo — cc31 corte 1

- Modelo: Sonnet (contexto limpio). Fecha: 2026-10-07.
- Alcance: `git diff origin/main...cc31-c1` (135 archivos, solo web). Revisé a fondo `lib/format.ts`, `lib/api.ts`, `lib/notify.ts`, los componentes nuevos (`error-screen`, `connection-banner`, `list-state`, `precise-qty`, `brand-mark`), `error.tsx`/`global-error.tsx`/`not-found.tsx`, `globals.css`, `status-tone.ts`, `ui/*`, y todos los puntos donde las vistas llaman a `formatKg`/`formatMeters`/`formatQty`/`formatUnitQty`. Las vistas restantes (cambios de texto y de `toast`) las recorrí por patrones, no línea por línea.
- Límite honesto: no corrí build ni tests; todo lo de abajo sale de leer el código.

## P0

### P0-1. Un corte de red ahora descarta la clave de idempotencia y el reintento duplica el documento
- Archivo: `apps/web/src/lib/use-idempotency-key.ts:43` (disparado por `apps/web/src/lib/api.ts:102-105`).
- Qué pasa: `api()` ahora convierte el rechazo de `fetch` en `new ApiError(0, SERVER_DOWN_MESSAGE, undefined, 'NETWORK')`. `settle` decide así:
  `uncertain = error !== undefined && !(error instanceof ApiError && error.status < 500)`.
  Antes, un corte de red llegaba como `TypeError`, que no es `ApiError`, así que `uncertain = true` y la clave se conservaba (D-182). Ahora `status 0 < 500` da `uncertain = false` y la clave de ese envío se borra.
- Escenario: el usuario emite un comprobante, un cobro o un despacho, el proxy corta la conexión después de que el API ya grabó, el web muestra «El servidor no respondió», el usuario vuelve a pulsar. Sale con una clave nueva y el servidor graba un segundo documento. Es exactamente el caso que D-182 documenta como razón de ser del hook.
- Arreglo: tratar el estado 0 (o `code === 'NETWORK'`) como incierto:
  `!(error instanceof ApiError && error.status >= 400 && error.status < 500)`.
  Añadir un caso en un spec de `use-idempotency-key` (no existe hoy): `settle(new ApiError(0, …, undefined, 'NETWORK'))` debe conservar la clave.
- Relacionado, menor: `components/…/dispatch-at-issue-date.tsx:67` (`retry: … err.status < 500`) ahora tampoco reintenta un error de red. Mismo arreglo.

## P1

### P1-1. Specs E2E con cifras y textos que cambian y no se actualizaron (la suite saldrá en rojo)
Solo se tocaron 2 specs de E2E (`correcciones-03-listas-kardex`, `planta-espacio-produccion-ui`). Verificado contra el código nuevo:
- `e2e/tests/plancha-largo-d166.spec.ts:236` espera `30.000 m lineales`; el código (`sales-document-form.tsx:1869`) ahora da `30.00 m lineales`. Lo mismo en `:170` y `:176` (`= 0.003 m`, `= 3.000 m`; `product-dialog.tsx` usa `formatMeters`: `= 3.00 m`; el `0.003` conserva el tercer decimal, el `3.000` no).
- `e2e/tests/import-cotizaciones-ui.spec.ts:727` (`Los largos suman 80.000 m y la línea dice 81.900 m.`) y `:733` (`… · 81.900 m`): ahora `80.00 m`, `81.90 m`.
- `e2e/tests/planta-cola-f8s3-ui.spec.ts:131` (`40.000 m del plan`, `production-queue.tsx` usa `formatMeters`) y posiblemente `:183`, `:125`, `:273-274`.
- `e2e/tests/flujo-comercial-f8s2-ui.spec.ts:300, 354, 494, 509` (`20.000 m`, `faltan 21.200 kg`, `40.400 kg`): pasan por `formatQty` con unidad `kg`/`m`, que ahora da 2 decimales.
- Otros con 3 decimales que usan `formatQty`/`formatUnitQty` en vistas de listas/detalle: `fase2b.spec.ts`, `multi-montar-f8s3.spec.ts`, `historial-bobinas-d324.spec.ts:110`, `fase7-consolidada-subtipo.spec.ts`. Hay que revisarlos uno por uno: los de planta y bobina (`formatQtyAsIs`/`PreciseQty`) no cambian.
- Arreglo: correr la suite E2E completa (build de producción) y actualizar las aserciones; no afirmar verde sin esa corrida.

### P1-2. `errorMessage` presenta como «El servidor no respondió» cualquier `TypeError` del propio código
- Archivo: `apps/web/src/lib/notify.ts:48-51`.
- Qué pasa: `if (err instanceof TypeError) return SERVER_DOWN_MESSAGE`. Los `fetch` crudos que no pasan por `api()` (`nueva-xml-view.tsx:20`, `download.ts`, `plant-sheet-buttons.tsx`) sí lanzan `TypeError` por red, pero un `TypeError` por un defecto (`undefined.map`, un `Decimal` mal formado dentro de un `onError`/`catch`) también se mostrará como «El servidor no respondió» más el aviso «No se guardó nada. Lo que escribiste sigue en pantalla.» Eso es falso en el segundo caso y oculta el error real al dueño.
- Arreglo: comparar el mensaje (`/failed to fetch|networkerror|load failed/i`, que cubre Chrome, Firefox y Safari) o que los `fetch` crudos lancen el mismo `ApiError(0,…)`; para cualquier otro `TypeError`, devolver `fallback`.

### P1-3. `formatNumber` lanza si el valor no es un decimal válido, y `formatQty` antes toleraba cualquier cadena
- Archivo: `apps/web/src/lib/format.ts:77-84` (vía `formatQty` con `kg`/`m`, `format.ts:109-113`).
- Qué pasa: `formatQty('', 'kg')` antes devolvía `0 kg`; ahora `new Decimal('')` lanza y rompe el render de toda la vista (cae en el `error.tsx` nuevo). Hay llamadores con cadenas escritas por el usuario: `sales-document-form.tsx:2140` (`formatQty(qty, 'kg')`, `qty` pasa por `isPositiveDecimal` que hace `trim()` pero `Decimal` no admite espacios: `'12 '` lanza) y `importar-view.tsx:1432` (`toDecimal(qty.trim())` protegido por `isNumeric`, ese está bien).
- No hallé un caso concreto que hoy llegue con vacío desde el API, por eso lo dejo en P1 y no P0; el riesgo es una regresión latente en un helper que usan ~40 llamadores.
- Arreglo: que `formatNumber` devuelva `'—'` (o el texto original) cuando `value` no es numérico; o `value.trim()` antes de `new Decimal`.

## P2

- P2-1. `api.ts:70`: un 4xx sin cuerpo da `No se pudo completar la operación (404)`: el número sigue visible; la especificación pide quitar «Error 500»/números. `nueva-xml-view.tsx:29-32` hace su propia versión y no filtra el `Internal server error` genérico de Nest (usa `body.message ??`), así que ese flujo todavía puede mostrar el texto en inglés.
- P2-2. `api.ts:102`: el `.catch` convierte también el `AbortError` (navegar a otra página cancela los `fetch` en vuelo) en un toast persistente «El servidor no respondió». Excluir `DOMException` con `name === 'AbortError'`.
- P2-3. `clientes-view.tsx:257` / `list-state.tsx:76`: si hay datos en pantalla (`keepPreviousData`) y falla un refetch, `isError` añade la fila de error debajo de las filas viejas con «No es que no haya: el servidor no respondió.», que se contradice. Mostrar el estado de error solo cuando `rows.length === 0`, o un aviso aparte. Además `ListStateRows` solo lo usa Clientes: el resto de listas conserva su línea gris (la especificación pedía los tres estados en todas; confirmar que es alcance del corte 2).
- P2-4. Los límites de tolerancia y de reserva se muestran a 2 decimales mientras el servidor compara a 3 (`confirm-quotation-dialog.tsx:368`: «tiene 4,027.44 y el papel dice 4,030.00: tiene que estar entre X y Y»; `sales-document-form.tsx` «X a reservar / Y disponibles — no alcanza»). Con valores que redondean igual puede leerse «no alcanza» con X = Y, y un mínimo redondeado hacia abajo no es tipeable. Mismo problema que la nota «el mínimo mostrado tiene que ser tipeable». Mostrar esos mínimos con `formatKgPrecise` o redondeados hacia el lado seguro.
- P2-5. `formatMeters` (`format.ts:~100`) muestra el tercer decimal solo si el redondeo a 3 no es cero, pero un valor `4.2049` se muestra `4.205` aunque no sea múltiplo del milímetro: aceptable, solo recordar que `importar-view.tsx:1432` («Los largos suman 80.00 m y la línea dice 80.00 m») puede salir con dos cifras iguales cuando difieren en el cuarto decimal.
- P2-6. `ConnectionBanner` (`z-50`, fija abajo, a todo el ancho) cubre el `Toaster` (abajo a la derecha) y los botones de pie de diálogo mientras no hay red; `role="status"` sin `aria-live` explícito. Subir el toaster o dar margen inferior.
- P2-7. `Math.random()` en `error-screen.tsx` para la referencia: no es un identificador buscable en los registros del servidor (solo el `digest` lo es). Para errores del navegador conviene decir «sin referencia de servidor», o no mostrarla.
- P2-8. `ui/table.tsx`: `tabular-nums` global a todas las celdas cambia el ancho de glifos de texto libre (nombres, SKU) en todas las tablas; si la intención era solo numérica, aplicarlo a las columnas `text-right`.
- P2-9. `ui/badge.tsx`: la píldora pasa de 18 px a 20 px y de 11 px a 12 px (`text-xs`); es un cambio de densidad en cada fila con estado, no listado en la especificación §0/§8.

## P3

- P3-1. `notify.ts:25`: `persistent` con `duration: Infinity` apila avisos de error si un bucle (p. ej. importadores por fila) llama `toast.error` varias veces; considerar `id` fijo por operación para que se reemplacen.
- P3-2. `notify.ts:36`: la marca `message === SERVER_DOWN_MESSAGE` compara cadenas; mejor que `errorMessage` devuelva un objeto o que `toast.error` reciba el `ApiError` y compruebe `code === 'NETWORK'`.
- P3-3. `global-error.tsx`: queda sin la fuente de `next/font` y sin proveedor de tema; está dicho en el comentario, solo verificar en el build de producción (`next build`) que `import './globals.css'` en `global-error` no duplica estilos.
- P3-4. Todo código interno visible: barrí `RF-nn`, `D-nnn`, `ccNN` y `§` en `.tsx` y no quedan en texto visible (solo en comentarios). `audit-labels.ts` también quedó limpio. Sin hallazgos.
- P3-5. Todo `toast` y `sonner`: no queda ningún `from 'sonner'` fuera de `ui/sonner.tsx` y `lib/notify.ts`. Los `toast.warning` nuevos (pedido con faltante, reserva incompleta) y los `toast.success` de contraparte son coherentes con la regla de la especificación.

## Verificado y sin hallazgos

- `error.tsx`, `(app)/error.tsx`, `global-error.tsx` y `not-found.tsx` tienen la forma que pide Next 15 (`'use client'`, props `error`/`reset`; `global-error` trae `<html>` y `<body>`; `not-found` es un componente de servidor con `metadata`).
- `notify.ts` ↔ `api.ts` no forman ciclo (`api.ts` no importa `notify`).
- `formatNumber`: redondeo con `Decimal` `ROUND_HALF_UP`, `-0.001` → `0.00`, miles y signo correctos; `formatMeters` y `formatKgPrecise` correctos en el spec.
- No encontré ningún valor formateado que viaje al API: las cadenas formateadas solo aparecen en texto visible; los `toFixed(3)` que quedan alimentan `formatQtyAsIs` en planta/bobina y no los payloads.
- `PreciseQty` y el kardex mantienen 3 decimales.
