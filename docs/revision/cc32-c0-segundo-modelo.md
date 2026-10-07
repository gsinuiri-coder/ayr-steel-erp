# cc32 corte 0: revisión del segundo modelo

Revisor: segundo modelo (Sonnet, contexto limpio). Diff `origin/main...origin/cc32-c0`.
No se ejecutó nada: lectura estática del diff y de los archivos completos de la rama.

## Resumen

El corte es pequeño y casi todo está bien razonado. `download.ts`, los plurales, los ejemplos
bajo el campo y el `MutationCache` son correctos. Hay un problema que pone el E2E en rojo
(P1): la unidad ahora entra en el nombre accesible de los campos con `<label for>`, y varios
specs usan `getByLabel(..., { exact: true })` con el rótulo sin unidad. El corte solo arregló
el spec de despacho, que usa `aria-label`.

## P0

Ninguno.

## P1

### P1-1. Specs E2E con `exact: true` se rompen con el nuevo nombre de `InputWithUnit`

- Archivos: `apps/web/src/components/ui/input.tsx:86-102` (efecto que fija `aria-labelledby`);
  specs afectados:
  - `e2e/tests/fase2a.spec.ts:155,156,157,247,411,416,426,427,433,434`
  - `e2e/tests/formularios-cc31.spec.ts:68,69,81,93`
- Escenario: en `purchase-form.tsx` (`Ancho` y `Espesor` con unidad `mm`, `Peso` con `kg`),
  el campo va dentro de `FormFieldCell`, o sea `<label for>`. El efecto no ve `aria-label`,
  encuentra la etiqueta y pone `aria-labelledby="<label> <unit>"`. El nombre pasa de «Peso» a
  «Peso (kg)». `getByLabel('Peso', { exact: true })` ya no coincide: el fill falla por
  timeout y el `toBeFocused` también. Playwright resuelve `getByLabel` por `aria-labelledby`
  antes que por `label.for`. El propio corte tuvo que quitar `exact: true` en
  `despacho-formulario-cc31.spec.ts` por lo mismo, pero solo cubrió el caso `aria-label`.
- Arreglo: pasar esas llamadas a `getByLabel('Peso')`, `getByLabel('Ancho')` y
  `getByLabel('Espesor')`, sin `exact`, o a `{ name: /^Peso\b/ }`. Ojo: sin `exact`, «Peso»
  también coincide por subcadena con otros campos de peso en la misma página. Mejor un
  regex anclado `/^Peso \(kg\)$/` y `/^Ancho \(mm\)$/`, que además fija el comportamiento
  nuevo. Correr la búsqueda de `exact` otra vez antes del merge: no se vio ninguno más
  contra los rótulos de `bobinas`, `corte` y `despacho` (`Peso bruto total`, `Merma
esperada`, `Kilos de merma`), pero la suite completa debe confirmarlo.

## P2

### P2-1. Cada mutación exitosa dispara hasta 5 consultas, sin filtrar por tipo

- Archivo: `apps/web/src/app/providers.tsx:15-23`; `apps/web/src/lib/pending.ts:44-50`.
- Escenario: `MutationCache.onSuccess` global invalida las 5 claves vivas tras cualquier
  `useMutation` (hay unos 59 archivos que los usan), incluidos inicio de sesión, ediciones
  de maestros, vistas previas y recálculos que no mueven ningún pendiente. Los pasos por
  lote (importadores, acciones fila por fila) repiten 5 refetch por paso. `invalidateQueries`
  cancela y reinicia la petición en curso (`cancelRefetch` por defecto), así que no se
  acumulan, pero el API tiene un límite de peticiones compartido (D-488 lo menciona) y
  `/sales/orders/with-shortfall` es de las consultas pesadas. Solo se piden las consultas
  montadas (la campana está siempre montada, así que hoy son 3 a 5 por mutación).
- Arreglo: dos opciones baratas. (a) Rebote: acumular y disparar una sola invalidación por
  ventana corta (por ejemplo 500 ms), con `setTimeout` guardado en el closure del cache.
  (b) Un `meta: { skipPendingRefresh: true }` en vistas previas y mutaciones de solo
  cálculo, leído en `onSuccess(_d, _v, _c, mutation)`. Como mínimo, dejar escrito en la
  decisión que el costo se aceptó.

### P2-2. La campana no tiene «Reintentar»; solo el Panel

- Archivo: `apps/web/src/components/pending-bell.tsx:174-178`.
- Escenario: el encargo dice que `pending-bell.tsx` también recibe el estado de error con
  «Reintentar». El diff solo agrega `failed` y `retry` al hook; la campana sigue mostrando
  «No se pudo calcular todo: puede faltar algún pendiente.» sin botón. Quien abre la campana
  tras un fallo espera hasta el siguiente ciclo (1 minuto o 10 minutos para las lentas).
- Arreglo: un `Button variant="link"` «Reintentar» con `onClick={sources.retry}` junto al
  aviso. Si se decide no ponerlo, corregir el texto de la tabla de P3 y del encargo.

### P2-3. `aria-labelledby` fijado a mano, sin reacción a cambios posteriores

- Archivo: `apps/web/src/components/ui/input.tsx:86-102`.
- Escenario: el efecto solo corre cuando cambian `named`, `unitId`, `unit` o `props.id`.
  (1) Si la etiqueta aparece después del primer commit (campo dentro de un contenido
  condicional que monta la etiqueta por separado), el nombre queda sin unidad para
  siempre. (2) Si `unit` cambia de «kg» a «m», el `aria-labelledby` se reescribe bien, pero
  si el texto de la etiqueta pasa a incluir la unidad, queda el atributo viejo (la salida
  temprana `return` no lo quita). (3) Si `named` pasa de `false` a `true`, queda un
  `aria-labelledby` que gana sobre el `aria-label`. Hoy ningún uso cambia esas propiedades
  en caliente, así que es latente.
- Arreglo: en las salidas tempranas llamar `input.removeAttribute('aria-labelledby')` cuando
  el atributo lo puso este efecto (guardarlo en un ref), o resolver la unión en render:
  aceptar `label` opcional en el componente y no tocar el DOM. La segunda opción evita el
  efecto imperativo por completo y es más fácil de probar.

## P3

### P3-1. `label.id` se asigna a un nodo ajeno

- `input.tsx:99`: `label.id = \`${unitId}-label\``modifica una etiqueta que pertenece a
otro componente. Si ese componente la vuelve a pintar con su propio`id`, React lo pisa y
el `aria-labelledby`apunta a un id que ya no existe. En`FormFieldCell`la etiqueta no
tiene`id`, así que hoy sirve. Misma raíz que P2-3.

### P3-2. Sin prueba unitaria de `InputWithUnit`

- No hay spec de `withUnit` ni del efecto. Una prueba de render con `@testing-library`
  (nombre con `aria-label`, con `<label for>`, sin etiqueta, con unidad vacía) habría
  detectado P1-1 antes del E2E. `withUnit` es pura y se prueba sin DOM.

### P3-3. Descarga con 401 o 400 sin motivo

- `download.ts:44-45`: queda «No se pudo descargar el archivo.» sin causa. Un 401 tras el
  refresh fallido merecería «Tu sesión venció: vuelve a ingresar.». El 400 sin cuerpo es
  raro. No bloquea.
- Prueba correcta para el resto: 5xx genérico, 403, 404, 429, corte de red y `AbortError`
  (este último no tiene prueba, solo los otros). Los mensajes están en español, tuteo
  correcto («No tienes permiso…»).

### P3-4. Lo lento no se refresca tras una emisión

- `pending.ts`: «Cotizaciones por vencer» y «Precios bajo el piso» quedan fuera de la
  invalidación (decisión razonable por costo). Emitir o vencer una cotización deja el
  contador del menú hasta 10 minutos atrás. Dejarlo anotado en la decisión o en el handoff.

### P3-5. Docs

- `docs/ARQUITECTURA.md`: D-480..D-501 pasan de «provisional» a «ratificada por el dueño el
  2026-10-07». No puedo verificar la ratificación desde el repo; el dueño debe confirmarla
  al cierre. El cambio de texto es mecánico y consistente (22 filas).
- `docs/handoff/ventana-cc31.md` remite a `docs/handoff/ventana-cc32.md`, que no existe en
  la rama (solo `ventanas/cc32-especificacion.md`). Debe crearse al cerrar cc32 o ajustar la
  referencia.
- Correr `pnpm format:check` antes del push: la tabla nueva de P3 tiene filas más anchas que
  su cabecera (por ejemplo la del Panel) y Prettier las reformatea.

## Revisado sin hallazgos

- `providers.tsx`: la referencia a `queryClient` dentro del callback es válida (se evalúa
  después de construirse); la anotación `: QueryClient` evita el implícito `any` de TS.
  `void` en `invalidateQueries` es coherente con el lint del repo.
- `LIVE_PENDING_QUERY_KEYS` con `as const` y las claves por índice: legible pero frágil
  (`[0]`..`[4]` son posiciones). Nombrarlas en un objeto sería más seguro; no se pide.
- `panel-today.tsx`: `Button` ya estaba importado; `retry` por tarjeta correcto; con
  `failed` no hay enlace (se conserva). `void seller.refetch()` correcto.
- `app-sidebar.tsx` y `admin-dashboard.tsx`: plurales correctos («1 cotización vence» /
  «3 cotizaciones vencen»; «1 orden esperando» / «órdenes esperando»). El `title` recibe
  un `number`, y el `?? 0` es redundante pero inocuo.
- Diálogos de bobina, traslado y reactivación: el ejemplo pasa de `placeholder` a un `<p>`
  con `id` referenciado por `aria-describedby`; cumple accesibilidad (el `placeholder` no
  es descripción) y el tono («Di por qué…») usa tuteo.
- `InputWithUnit`: el manejo de `ref` como prop (React 19) y la combinación con el `ref` de
  `react-hook-form` (`{...field}`) es correcta; el `span hidden` sigue siendo referenciable
  por `aria-labelledby`; la unidad visible mantiene `aria-hidden`, sin doble lectura.

## Veredicto

Con cambios. Corregir P1-1 antes del merge (el CI de E2E quedaría en rojo) y decidir P2-1 y
P2-2; P2-3 y los P3 pueden quedar anotados. El resto del corte puede entrar tal cual.

## Estado tras las correcciones (autor del corte)

- P1-1 descartado: `getByLabel(..., { exact: true })` de Playwright coincide con el texto del
  `<label>` aunque el campo tenga `aria-labelledby`; `fase2a` y `formularios-cc31` pasaron en local
  con esos selectores.
- P2-1: refresco de la campana en lote (1,5 s), con `cancelRefetch: false`, y sin refresco al
  cerrar sesión (`meta.skipPendingRefresh`).
- P2-2: «Reintentar» también en el aviso de error de la campana.
- P2-3: el efecto quita `aria-labelledby` al desmontar o cambiar la unidad.
- De la autorrevisión: rechazos genéricos en inglés de las descargas, en español; un sondeo de
  fondo que falla no tapa la última cifra; unidades «/m» fuera del nombre accesible.
