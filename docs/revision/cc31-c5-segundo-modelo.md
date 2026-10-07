# Revisión de segundo modelo — cc31 corte 5

Revisor: Sonnet (contexto limpio), 2026-10-07. Diff: `cc31-c4...cc31-c5`. Solo lectura: no se corrió ninguna suite
(ni vitest ni Playwright); todo lo de abajo sale de leer el código y el contenido de los dos extremos del diff.

## Veredicto

Sin P0. Un P1 (la coma decimal puede cambiar en silencio el valor de una cifra con miles). Los payloads de despacho,
compra, orden de corte, comprobante, producto, proveedor, tipo de cambio y motivos son idénticos a los de antes
salvo lo que el alcance pide (precio de lista con IGV, motivo compuesto, código de proveedor solo si cambió).

## Hallazgos

### P1-1. «1,500» pasa a 1.500 en vez de 1500 (cambia en silencio el valor que viaja)

- `apps/web/src/lib/decimal-input.ts:12-19`, usado por `apps/web/src/components/ui/input.tsx:11-18` en los 75 campos
  `inputMode="decimal"` (kg, S/, mm, cantidades).
- Escenario: el usuario escribe `1,500` pensando en mil quinientos kg (la coma de miles es la convención peruana y la
  propia función la trata así cuando hay punto: `4,027.44`). Con una sola coma y sin punto, la regla «una coma sola es
  la coma decimal» lo convierte en `1.500` (1,5 kg). Antes el campo lo rechazaba con error visible; ahora se acepta, el
  campo queda con otro número y no hay aviso. En dinero o peso de bobina es un error de factor 1000 que nadie ve.
- Arreglo: tratar como ambiguo (no normalizar, dejar que la validación pida punto decimal) el patrón
  `^\d{1,3},\d{3}$` (y `-` opcional); normalizar como decimal solo si hay 1-2 decimales o 4+ dígitos tras la coma, o si
  la parte entera es `0` (`0,125`). Ajustar `decimal-input.spec.ts` (hoy `0,125` y `12,5` siguen valiendo; agregar
  `1,500` y `4,027` como no normalizados).

### P2-1. El «ejemplo» de ReasonDialog sale mal en casi todos los llamadores

- `apps/web/src/components/reason-dialog.tsx:151-153`: `Por ejemplo: {placeholder}.` con el `placeholder` por defecto
  `'Por qué se anula'` (24 de 26 usos no pasan el prop) da «Por ejemplo: Por qué se anula.». Los dos que sí lo pasan
  (`pedido-detalle-view.tsx:851` «Qué material llegó», `:880` «Por qué se restaura») dan «Por ejemplo: Qué material
  llegó.», que tampoco es un ejemplo. Los diálogos con lista no muestran ejemplo, así que el defecto cae en los de
  motivo libre (anular pago, descartar borrador, liberar reserva, etc.).
- Arreglo: cambiar el default a un ejemplo real («Error de digitación en el precio») y convertir los dos placeholders a
  ejemplos («Llegaron 3 bobinas del pedido»), o dejar de mostrar la línea cuando no se pasa un ejemplo.

### P2-2. Enter sin salir del campo no normaliza: «1,5» + Enter da error o no hace nada

- `input.tsx:36-39` normaliza solo en `blur`. Un Enter dentro del campo envía el formulario con el texto crudo.
  `purchase-form`: el zod falla con «Escribe una cantidad mayor que cero» aunque el número se lea bien.
  `coil-scrap-dialog.tsx:96-103`: `canSubmit` es falso con «12,5» y el Enter se descarta sin mensaje. Con el ratón no
  pasa (el clic en el botón hace blur primero, salvo que el botón esté `disabled`, caso del diálogo de merma: el botón
  apagado no recibe el clic, así que ahí tampoco se confirma en el mismo clic).
- Arreglo: normalizar también en `onKeyDown` de Enter (antes de que el `submit` lea el valor) o aceptar la coma en los
  schemas/validadores (`isPositiveDecimal`) y normalizar al construir el cuerpo.

### P3-1. La unidad ya no está en el nombre accesible

- `purchase-form.tsx:901-925`: las etiquetas pasaron de «Ancho (mm)», «Peso (kg)» a «Ancho», «Peso», y la unidad vive
  en `InputWithUnit` con `aria-hidden` (`input.tsx:49-54`). Un lector de pantalla oye «Peso» sin «kg». Arreglo: pasar
  `aria-describedby` a un `sr-only` con la unidad, o `aria-label` «Peso (kg)» en el input.

### P3-2. El guardia de clic afuera solo cuenta eventos `input`

- `dialog.tsx:46-72`. Elegir un motivo en el Select de `ReasonDialog` (o cualquier Select/checkbox) no dispara `input`,
  así que con solo eso elegido un clic afuera sí cierra y pierde la elección. No hay burbujeo desde portales de
  Select/Popover que cause lo contrario (esos no emiten `input`), y `onOpenChange(false)` programático no pasa por
  `onInteractOutside`: sin falsos positivos. Si se quiere cubrir el caso, marcar `typed` también desde `onValueChange`
  de los Select del diálogo, o aceptarlo como está (la ✕/Cancelar/Esc siguen cerrando).

### P3-3. Diálogos de operación fuera del diff mantienen el placeholder dentro del campo

- `coil-close-dialog.tsx:190`, `coil-edit-dialog.tsx:313`, `restore-coil-dialog.tsx:136`,
  `move-to-order-dialog.tsx:267`, `reactivate-document-dialog.tsx:128`. Es la convención nueva (ejemplo debajo) solo en
  `ReasonDialog` y `CoilScrapDialog`; el resto queda a la vieja. Si el corte 5 no los cubre, anotarlo como pendiente.

### P3-4. Orden de corte: el merma esperada inválida no se marca

- `nueva-orden-view.tsx:527-556` (`planFits`): un texto que no es decimal positivo se trata como 0 y no da error, pero
  `send` manda `expectedKerfLossMm.trim() || '0'` (`:140`). Con «abc» o «-1» el API devuelve 400 (esto ya era así). No es
  regresión.

## Verificado sin hallazgo (por tu lista)

1. **Payloads.**
   - Despacho: el cuerpo de `create` es idéntico línea por línea (`nuevo-despacho-view.tsx:302-336` vs el anterior); las
     condiciones que antes apagaban el botón (pedido, cantidades, ubigeo de 6 dígitos, peso por línea, peso total,
     transporte según modalidad) están todas en `issues`, y `submit()` no llama a `backdate.attempt()` si hay alguna.
   - Compra: `toApiBody` idéntico (diff vacío de esa función); el esquema solo cambia mensajes.
   - Orden de corte: el cuerpo de `send` no cambió.
   - Comprobante: `create`/`lines` sin cambios; las tres combinaciones que no se emiten (`factureNeedsRuc`, genérico no
     boleta, tope genérico) siguen bloqueando vía `blocker`; cada línea del pedido inválida entra a `missing`.
   - Producto: al crear viaja `toFixedString(money(saleValueFromPrice(typed)), 'MONEY')`, el mismo cálculo que
     `PriceListCell`; al editar sin tocar el precio viaja el `listPricePen` guardado tal cual (evita el céntimo de ida y
     vuelta). Es el cambio pedido: la misma cifra tipeada viaja distinta porque ahora es con IGV.
   - Proveedor: `code` solo viaja si cambió (`supplier-dialog.tsx:169-178`); el API solo lo examina cuando cambia
     (`suppliers.service.ts:86`).
   - Tipo de cambio: mismo `PUT`; se agrega confirmación si la fecha y moneda ya existen en el historial cargado.
   - Motivos: lo que viaja es `composeReason`; el máximo compuesto (29 + 3 + 200 = 232) cabe en `reasonSchema` (240).
     Los diálogos sin lista bajaron de 240 a 200 caracteres (más estricto, seguro; coincide con los 200 de
     `discardDraftSchema`/`updateManualIssueDateSchema`).
2. **`input.tsx`.** `onBlur` se desestructura, así que el spread de `props` no lo pisa; se llama una sola vez y después de
   normalizar. El setter nativo + `input` burbujeante dispara `onChange` de React (controlado, `Controller` de RHF o
   estado); en inputs no controlados / `register` basta con que `onChange` lee `event.target.value`. Solo actúa con
   `inputMode="decimal"` y `^-?[\d.,]+$`, así que no toca RUC, códigos ni placas (no tienen coma). Sin doble envío: el
   evento `input` no es `submit`. Único riesgo real: P1-1 y P2-2.
3. **`dialog.tsx`.** Ver P3-2. `onInput` se desestructura de `props` (no se pisa); `typed` es un ref por montaje del
   contenido, empieza limpio en cada apertura. Los Select/Popover de Radix anidados no emiten `input`; los popovers en
   portal son capas de Radix y no cuentan como «afuera». Nota: `onInteractOutside` también cubre el foco fuera, y con
   `typed` también queda vetado, que es lo buscado.
4. **Botón principal sin apagar.** Revisados los cuatro formularios con barra de faltantes (despacho, compra, orden de
   corte, comprobante): en ninguno el handler llama al API con faltantes. Compra va por `form.handleSubmit` (el
   resolver impide `save.mutate`); `ReasonDialog`, `CoilScrapDialog` y `ConfirmDialog` siguen con guardia de estado
   actual en el momento del envío. Los `<form>` de los diálogos no están anidados en otro `<form>` de React (se revisó
   cada uso de `ReasonDialog`; `compra-detalle-view.tsx` lo renderiza fuera del `PaymentForm`), así que el `submit` no
   burbujea por el árbol de React a un formulario padre. Todos los botones internos de esos formularios son
   `type="button"` (incluido `OperationDateField`).
5. **ReasonDialog.** El detalle sin motivo cuenta como «Otro» (`effectiveChoice`), mínimo 3 caracteres sobre el texto
   compuesto; con motivo de lista el detalle corto no bloquea (correcto). Enter en el Select no envía el formulario (el
   foco está en el portal del listbox y el trigger es `type="button"`). Salvo P2-1, los llamadores con `placeholder`
   siguen funcionando.
6. **Orden de corte.** El bloqueo por plan que no cabe coincide con el API: `planFits` usa el mismo `consumed >
parentWidth` que `validateWidthBudget` (`cutting-math.ts:26-34`), el mismo mínimo de ancho de fleje
   (`MIN_CHILD_WIDTH_MM`, `widthCountSchema`) y plan vacío = «el plan necesita al menos un ancho». No es más estricto.
   Nota: antes `planFits(d) && …` era siempre verdadero (devuelve un objeto), es decir, el botón nunca bloqueaba por
   plan que no cabe y el rechazo llegaba del API; ahora se avisa antes, con la misma regla.
7. **Textos y accesibilidad.** Sin voseo, sin inglés visible ni códigos internos en los textos nuevos (`PICKUP`/`NIU`
   solo aparecen en lógica y pruebas). `aria-invalid` y `aria-describedby` presentes en cantidades, pesos y campos de
   transporte del despacho; los botones de modalidad llevan `aria-pressed` dentro de un `role="group"` rotulado.
   Excepción: P3-1.
8. **E2E.** Los selectores existentes que el diff rompe ya están actualizados: «Licencia de conducir»
   (`despacho-peso-por-linea`), `Ancho`/`Espesor`/`Peso` exactos (`fase2a`), `Detalle` en anular compra
   (`m2-reversa-pago`), «Precio de lista (S/, con IGV)» (`accesorio-edicion-m5`), `Largo de la plancha (mm)`
   (`correcciones-03-formularios`), confirmación al desactivar (`acciones-fila-d327`). El resto de los
   `getByLabel('Motivo')` apuntan a diálogos sin lista (reservas, restaurar, cierre de bobina, deshacer lote, anular pago
   y pedido), que conservan «Motivo». No encontré otros specs que dependan de los placeholders quitados.
   Riesgo no verificado: `formularios-grilla-d284.spec.ts` mide posiciones del formulario de comprobante
   (Observaciones, Cliente, botones); el comprobante cambió de `section` a `Section` y se le agregó el bloque «Qué va
   a pasar» antes de la barra, así que conviene correrlo.

## No verificado

No se ejecutó nada (ni typecheck, ni vitest, ni Playwright). Los specs nuevos (`defectos-cc31`,
`despacho-formulario-cc31`, `formularios-cc31`) no se revisaron línea por línea.
