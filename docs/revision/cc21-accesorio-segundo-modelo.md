# Revisión de segundo modelo (Sonnet, contexto limpio)

Entrega: cc21 PR 2 (D-389), accesorio. Diff revisado: `origin/cc21/tolerancia-aviso..HEAD`
(servicio de producción, `accessory-report-card.tsx`, `api.ts`, E2E `tolerancia-accesorio-d389`).
Es la revisión de otro modelo, no una aprobación humana. No se corrió Playwright ni build.

**Resultado: no hay P0 ni P1.** El orden de los `if` del `onError` es correcto (el rechazo con
código va antes que `/motivo/i`), no hay bucle del despunte y el servidor decide siempre.

## P2

### P2-1. El aviso queda viejo si cambian la bobina o el kg consumido

`apps/web/src/app/(app)/planta/accessory-report-card.tsx` (~224-231 y ~283-296): solo el campo de
metros limpia `tolerance`/`override`. El exceso también depende de la bobina elegida (`coilId`, ancho
y saldo distintos) y de `consumedKg` (`declaredKg` entra en `mountedKgForReport`).
Escenario: aviso a la vista con la bobina A, el operario cambia a la bobina B (o escribe kg
consumido) y la tarjeta sigue mostrando cifras de A, con los botones bloqueados hasta marcar la
casilla aunque ya no haga falta. Si el reenvío vuelve a exceder, el API trae otro `excess` y la
casilla se desmarca sola (`forExcessKg`), así que no hay daño de datos; es confusión y un clic de
más. Arreglo: limpiar `tolerance` y `override` también al cambiar `coilId` (efecto sobre la prop) y
en el `onChange` de `consumedKg`.

### P2-2. Cobertura de pruebas estrecha

- `e2e/tests/tolerancia-accesorio-d389.spec.ts`: la pantalla solo prueba «Reportar y cerrar». El
  camino de «Reportar» (sin cierre), el aviso fuerte (>5 %, `severe`), el reinicio al cambiar los
  metros y el caso de que el cierre pida además motivo de despunte después de la casilla (casilla
  conservada, un solo diálogo) no tienen prueba. Ese último es el mismo patrón que causó el bucle.
- No hay jest nuevo para el servicio: se quitó el rechazo del accesorio con casilla
  (`roofing-production.service.ts` ~956) y la nueva rama solo la cubre el E2E de API. Falta un
  spec de servicio con accesorio + `toleranceOverride` (entra topado, auditoría con `severe`) y
  uno con motivo `HEAVIER_COIL` rechazado.
- El E2E de API fija `excessPct: '2.94'` mientras el comentario del encabezado dice 2,93 %: frágil
  ante redondeo; conviene calcularlo o comentar el valor correcto.

## P3

### P3-1. Accesibilidad del aviso

`accessory-report-card.tsx` ~303-316: el bloque aparece tras una petición sin `role="alert"` /
`aria-live` ni mover el foco, y los dos botones quedan deshabilitados sin decir por qué (un lector
de pantalla no anuncia el aviso). Arreglo: `role="alert"` en el contenedor (o `aria-live="polite"`)
y `aria-describedby` en los botones hacia el aviso.

### P3-2. Rechazo con código pero sin `excess`

`accessory-report-card.tsx` ~160-164: si llegara `TOLERANCE_OVERRIDE_REQUIRED` sin `excess`
(proxy que reescriba el cuerpo, versión desalineada), solo hay un toast y `tolerance` queda `null`:
el operario no tiene casilla y reintenta el mismo rechazo. Es inalcanzable con el API actual;
conviene al menos un mensaje que diga que recargue.

### P3-3. `ApiError.details` solo conoce `excess`

`apps/web/src/lib/api.ts` 18-22, 58-64: tipado estrecho y propagación correcta; los otros
`new ApiError(...)` (xml, importar precios) no pasan el cuarto y quinto parámetro y siguen igual.
Sin regresión. Si más códigos traen datos, convendrá un `details` genérico.

## Verificado sin hallazgo

- Idempotencia: la clave depende de `JSON.stringify(body)`, que ahora incluye `toleranceOverride`;
  el reenvío con casilla lleva clave nueva y el rechazo previo (400 dentro de la transacción) no
  consume la clave en `report-and-close` (el claim se revierte con la transacción).
- `report-and-close`: si el reporte entra con casilla y el cierre pide motivo de despunte, la
  transacción entera se revierte; el diálogo del despunte reenvía con la casilla (el estado se
  conserva) y no hay doble efecto.
- `reasonToSend.current = null` al recibir el código evita arrastrar un motivo de despunte viejo.
- Reglas del servidor: motivo `HEAVIER_COIL` rechazado (`assertToleranceReasonApplies`), casilla
  dentro del 1 % sin rastro (`appliedToleranceOverride`), consumo topado en lo montado.
- Regresión del accesorio sin casilla: sigue con el rechazo con código y las cifras.
