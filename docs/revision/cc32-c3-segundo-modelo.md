# cc32 corte 3 — revisión de segundo modelo (contexto limpio)

Diff: `origin/cc32-c2...origin/cc32-c3` (10 archivos). Solo lectura; no se corrió nada.

## Resumen

El corte cumple la espec §2 y no toca reglas de negocio ni lo que se pide al API: las
condiciones de emitir (`canIssueNote`) y de revertir (`canReverse`) son idénticas a main; solo
cambió el rótulo «Emitir guía de remisión» a «Emitir guía» (ningún spec en e2e/ ni en web usa el
rótulo viejo). `printFile` reutiliza `fetchFile` (sesión, 401, mensajes). No hay P0. Hay dos
puntos P1/P2 de experiencia en producción (comprobantes manuales / PSE apagado) y un defecto
real del ciclo de vida del iframe cuando se imprime dos veces seguidas.

## Hallazgos

### P1

**P1-1. Producción (PSE apagado): la impresión del mostrador y de la guía nunca se habilita y el
texto promete algo que no va a pasar.**
`apps/web/src/app/(app)/pos/pos-view.tsx` (SaleDoneDialog, `printable`, `title`, texto
`fiscalPending`) y `despacho-detalle-view.tsx` (`noteOnTheWay`, footer).
Escenario: hoy el comprobante de una venta en prod queda en `ISSUED`/`DRAFT` y no avanza
(`PSE_ENABLED` sin definir, fail-closed). El diálogo muestra «Imprimir comprobante»
deshabilitado y la frase «Se imprime cuando SUNAT lo acepte», que no ocurrirá nunca; el vendedor
de mostrador queda sin ninguna salida de impresión y sin «Descargar PDF» (antes el enlace estaba
siempre, aunque diera 404). Los comprobantes manuales son `ACCEPTED` pero sin `pdfKey`
(`registerManual` no corre `storeFiles`; `file()` da 404), así que «ACCEPTED» no implica «hay
PDF».
Arreglo: (a) decir la causa real cuando el entorno no emite (el web ya conoce `pseOff` en el
despacho; en el POS, exponerlo o usar `invoicing settings`): «Este entorno no emite
electrónicamente; el comprobante se registra a mano en Comprobantes»; (b) en la guía y en el POS
condicionar «imprimible» a que el PDF exista (`hasPdf`/campo equivalente en el DTO) y no solo a
`ACCEPTED`; si no es viable en este corte, dejarlo como decisión del dueño (regla 16) y como
mínimo no prometer «cuando SUNAT lo acepte» si `pseOff`.

### P2

**P2-1. Imprimir dos documentos seguidos antes de que cargue el primero abre una pestaña con un
blob revocado.** `apps/web/src/lib/print.ts` `printBlob`: `current?.cleanup()` quita el iframe
y revoca la URL, pero la promesa anterior sigue sin `settled` y su `loadTimer` (20 s) dispara
`fallbackToTab` → `window.open(url)` con una URL ya revocada (pestaña en blanco/error).
`inFlight` es por `href`, así que dos botones distintos (hoja de planta y cotización, o guía y
comprobante) lo permiten. Arreglo: en `cleanup` (o al reemplazar) marcar `settled = true` y
limpiar `loadTimer`, resolviendo o rechazando la promesa anterior; test en `print.spec.ts`.

**P2-2. El plan B de la pestaña nueva casi nunca funciona.** `print.ts` `fallbackToTab`: se
llama desde un `setTimeout`/`load` después de `await fetch`, sin gesto del usuario; los
bloqueadores de ventanas emergentes lo cortan, y se cae al error genérico tras 20 s de espera.
Arreglo: documentarlo como mejor esfuerzo y bajar `PRINT_LOAD_TIMEOUT_MS` (p. ej. 8 s) o abrir
la pestaña en el clic (antes del `await`) solo si el iframe falla; o quitar la promesa del
comentario de cabecera. Los mensajes quedan bien (sugieren descargar).

**P2-3. «Imprimir» del menú «Más opciones» no da señal de espera.** `header-actions.tsx`
`MenuAction`: el menú se cierra y, si el PDF tarda, no hay indicio; el usuario vuelve a abrir el
menú y pulsa otra vez (el `inFlight` lo ignora en silencio). Arreglo: un `toast.info('Preparando
la impresión…')` o el mismo `role="status"` que ya usa `pendingSecondary`.

### P3

- P3-1. `pos-view.tsx`: el botón deshabilitado explica el motivo solo por `title`; si el estado
  no es `fiscalPending` (p. ej. `DRAFT`) no hay texto visible. Mostrar siempre una línea.
- P3-2. `pos-view.tsx`: el diálogo guarda la venta tal como la devolvió `sell`; si SUNAT acepta
  segundos después no se refresca y no hay reintento sin cerrar. Aceptable, pero conviene
  decirlo en el UAT.
- P3-3. `header-actions.tsx` `ActionButton`: `printing` vive en el botón; si el componente se
  desmonta (cambio de estado del despacho) el `finally` llama a `setPrinting` sin efecto. Sin
  daño en React 19.
- P3-4. `documentos-cc32.spec.ts`: `channel: 'chromium'` es válido con Playwright 1.62.1 y la CI
  instala `playwright install --with-deps chromium` (ci.yml:149 y 226), que trae el Chromium
  completo además del shell: correcto. Ojo en máquinas locales que solo tengan el shell. El
  spec suma `waitForTimeout(1_000)` fijo; es tolerable porque busca ausencia de evento.

## Revisado y sin hallazgo

- Foco del POS: `onOpenAutoFocus` con `preventDefault` y foco manual, Enter imprime, y
  `onAfterPrint` + `finally` llevan el foco a «Nueva venta»; doble clic cubierto por `printing`
  y por `inFlight`.
- Ciclo de vida normal: `afterprint` una sola vez (`notified`), `cleanup` idempotente, timer de
  10 min como red, `revokeObjectURL` siempre. El iframe usa `aria-hidden`, `tabIndex -1` y
  título.
- `fetchFile`/`downloadErrorMessage` con `verb`: textos en español con tuteo correctos.
- Despacho: la principal sigue el estado; los estados `STANDING` distintos de los tres de espera
  (p. ej. `VOID_PENDING`) dejan solo «Ver la guía» en el menú, razonable.
- Comprobante: «Imprimir» solo con `hasPdf`; cotización y hoja de planta imprimen el PDF real.

## Veredicto

Aprobado con cambios: corregir P1-1 (o registrar la decisión del dueño sobre el texto y la
condición «imprimible» en producción) y P2-1 antes del deploy; P2-2/P2-3 y P3 pueden ir en el
mismo corte si son baratos o quedar anotados. Sin P0.

## Estado tras las correcciones (autor del corte)

- P1-1: en producción no se pierde nada (los manuales nunca tuvieron PDF; el «Descargar PDF» del
  Mostrador daba 404). Los textos ya no prometen lo que no ocurre: con la guía en camino la
  principal es «Ver la guía» (D-528) y el 404 «sin archivo» dice que el documento no tiene PDF
  guardado (D-530).
- P2-1: cada impresión se cancela entera al empezar otra (D-532), con unitarios.
- P2-2: el respaldo a pestaña nueva sale a los 4 s (D-529) y el aviso llega enseguida.
- P2-3: «Preparando la impresión…» desde «Más opciones» (D-531).
- De la autorrevisión: foco restaurado tras imprimir, iframe sin `aria-hidden`, listener de
  `afterprint` quitado al limpiar, motivo del botón del Mostrador en texto visible.
