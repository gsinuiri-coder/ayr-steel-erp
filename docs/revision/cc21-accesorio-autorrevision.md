# cc21 PR 2 — accesorio con la casilla de tolerancia (D-389): autorrevisión

> **Autorrevisión — no vale como pase cruzado.** La hizo un subagente nuevo de la misma sesión, sin
> leer el handoff de implementación ni `docs/PROGRESO.md`. Es una lista de riesgos, no una
> aprobación (AGENTS.md §2, regla 2.1).

- Diff revisado: `origin/cc21/tolerancia-aviso..HEAD` (commit `d02ad6f`), 4 archivos:
  `apps/api/src/production/roofing-production.service.ts`,
  `apps/web/src/app/(app)/planta/accessory-report-card.tsx`, `apps/web/src/lib/api.ts`,
  `e2e/tests/tolerancia-accesorio-d389.spec.ts`.
- Leído además: `tolerance-override.tsx`, `mountedKgForReport` / `mountedKgRejection` /
  `appliedToleranceOverride` / `assertToleranceReasonApplies`, `reportAndClose`,
  `useIdempotencyKey`, `claimIdempotencyKey` y el uso de la tarjeta en `roofing-order-panel.tsx`.
- Corrido: `tsc --noEmit` de `apps/web` y `apps/api` (limpios);
  `npx jest src/production/tolerance-override` desde `apps/api`: 2 suites, 51 tests en verde.
  No se corrió Playwright (fuera del encargo), así que el spec E2E nuevo está **sin ejecutar** en
  esta revisión.

## Resumen

Sin P0. Un P1: la casilla queda viva si cambia la bobina elegida o el saldo de la bobina, y el
servidor la acepta para **cualquier** exceso. Lo demás son P2 y P3: accesibilidad del aviso,
cobertura de tests y un caso límite del regex `/motivo/` al que hoy no se llega desde la UI.

Los puntos del encargo que se comprobaron y **están bien**:

- **Diálogo del despunte con un rechazo de tolerancia:** no se abre. `onError` mira
  `err.code === TOLERANCE_OVERRIDE_REQUIRED` y hace `return` antes del regex
  (`accessory-report-card.tsx:159-164`). En `reportAndClose`, `reportInTx` corre antes que
  `closeInTx` dentro de la misma transacción, así que el rechazo de tolerancia llega siempre antes
  que el del despunte. Después de marcar la casilla, si el cierre pide el motivo del despunte, se
  abre el diálogo y el reenvío lleva las dos cosas (`tolerance` solo se limpia al tener éxito o al
  cambiar los metros). No hay bucle.
- **`ApiError` sin `details`:** `toError` arma `details` solo si el cuerpo trae `excess`
  (`api.ts:58-64`). Con el código y sin `excess`, la tarjeta deja `tolerance` en `null` y muestra
  el mensaje en un toast (`:160-162`). No se queda bloqueada.
- **Idempotencia:** la huella es `JSON.stringify(body)` y ahora incluye `toleranceOverride`, así
  que el reenvío con la casilla lleva una clave nueva. Además, el 400 anterior ya había descartado
  su clave (`settle` con un 4xx). Un corte de red con la casilla puesta conserva su clave para el
  reintento con el mismo cuerpo. Está bien.
- **Rechazo de otra regla:** «sin kilos montados», «se declaran X kg consumidos: corrige la
  cifra», «la orden tiene varias bobinas», el tope del plan y otros llegan sin `code`. Caen en el
  toast y no tocan el aviso. Con la casilla autorizada, unos kilos declarados de más dan el rechazo
  plano de siempre (`mountedKgForReport`, rama `declared > available`). Es lo correcto.
- **Auditoría del accesorio:** `applied` se calcula en el camino común y la entrada
  `TOLERANCE_OVERRIDE_AUDIT_ACTION` se escribe sin condicionarla al subtipo
  (`roofing-production.service.ts:1413`). Las cifras auditadas las calcula el servidor, no las
  manda el cliente.

## Hallazgos

### P1-1 — La casilla sobrevive a un cambio de bobina o de saldo y el servidor la acepta para cualquier exceso

- **Dónde:** `apps/web/src/app/(app)/planta/accessory-report-card.tsx:76-78` y `:225-230`. Solo
  el `onChange` de los metros limpia `tolerance`/`override`. `coilId` llega por prop
  (`roofing-order-panel.tsx:701`) y su cambio no limpia nada. En el servidor,
  `roofing-production.service.ts:1154`: `overrideBands: { authorized: override !== undefined }`,
  sin ninguna cifra contra la que comparar.
- **Escenario A (bobina):** una OP de accesorio tiene montadas BOB-A y BOB-B. El operario elige
  BOB-A, escribe 255 m, pulsa «Reportar» y recibe el aviso del 2,94 %. Marca la casilla con
  «Bobina más liviana». Luego cambia el selector a BOB-B, a la que le quedan 20 kg: el exceso real
  es del 98 %, aviso fuerte. `overrideInput(override, tolerance)` sigue dando una casilla válida,
  porque `forExcessKg` coincide con el `tolerance` **guardado**, que sigue siendo el de BOB-A. El
  botón está habilitado, el cuerpo lleva `toleranceOverride` y el servidor acepta el 98 %: la
  BOB-B queda en 0 y el producto entra valorizado por 20 kg. La pantalla nunca mostró ese 98 %.
- **Escenario B (saldo):** un segundo operario reporta contra la misma bobina entre el rechazo y
  el reenvío, o se corrige un reporte anterior. El saldo baja y el exceso crece. La casilla
  marcada para el 2,94 % autoriza lo que haya en ese momento. La auditoría deja la cifra real, pero
  quien confirmó vio otra.
- **Por qué importa:** `ToleranceOverrideState.forExcessKg` existe justo para que «un 3 %
  confirmado no pueda pasar como un 90 %» (`tolerance-override.tsx:21-25`). En el borrador de las
  planchas esa cifra la recalcula el servidor en cada fila. En el accesorio solo la ata el cliente,
  y atada a una foto vieja.
- **Arreglo:**
  1. En la tarjeta, guardar con `tolerance` la huella de lo que se rechazó (`coil?.coilId` y
     `typedMeters`) y no mandar ni mostrar la casilla si la huella actual no coincide. Otra opción
     es limpiar `tolerance` y `override` con un efecto cuando cambia `coil?.coilId`.
  2. Para el escenario B (y como defensa en el servidor), mandar `toleranceOverride.expectedExcessKg`,
     o un campo equivalente, y que `reportInTx` rechace con `TOLERANCE_OVERRIDE_REQUIRED` y las
     cifras nuevas si el exceso actual es mayor que el confirmado. Es un cambio de contrato: lo
     decide el dueño (regla 16). Como mínimo, el punto 1.

### P2-1 — El aviso aparece sin anunciarse y el foco queda en un botón deshabilitado

- **Dónde:** `accessory-report-card.tsx:303-317` y `:322`/`:333`.
- **Escenario:** con lector de pantalla, el operario pulsa «Reportar y cerrar». El 400 monta el
  bloque `tolerance-override`, que no tiene `role="alert"` ni `aria-live`, y el botón con el foco
  pasa a `disabled` (`toleranceBlocked`). El foco se pierde (en Chromium vuelve a `body`) y no se
  anuncia nada: el usuario no se entera de que hay una casilla que marcar. En el borrador de
  planchas el aviso sale de los datos del servidor, pero acá es la respuesta directa a un clic.
- **Arreglo:** poner `role="alert"` (o `aria-live="polite"`) en el contenedor del aviso y, al
  recibir el rechazo, llevar el foco a la casilla. Se puede hacer con una `ref` desde
  `ToleranceOverrideRow` o con `document.getElementById(\`${id}-check\`)`en un efecto sobre`tolerance`.

### P2-2 — No hay ningún test unitario ni de servicio para el accesorio con la casilla

- **Dónde:** se quitó la excepción en `roofing-production.service.ts:956-963` y el `...(accessory ? {} : …)`
  de `:1153-1154`, pero ningún spec de jest cubre ese camino. Los 51 tests de
  `tolerance-override-d388*.spec.ts` prueban `mountedKgForReport` y la ejecución del borrador, no
  `reportInTx` con `meters`. La única cobertura es el spec E2E, que no se corrió en esta revisión.
- **Escenario:** alguien vuelve a poner el `if (accessory && override !== undefined)` o la rama
  `accessory ? {}` y no falla nada de lo que corre en `pnpm test`.
- **Arreglo:** agregar a la suite de servicio (`apps/api/src/production/…`, con el mock de `tx` que
  ya usa `tolerance-override-d388-services.spec.ts`) dos casos de un accesorio:
  - sin casilla, el rechazo trae `code` y `excess`;
  - con casilla, entra y escribe la auditoría `TOLERANCE_OVERRIDE_AUDIT_ACTION`.

### P2-3 — El E2E no ejercita «Reportar y cerrar» con kilos al cerrar ni el despunte después de la casilla

- **Dónde:** `e2e/tests/tolerancia-accesorio-d389.spec.ts:135-175`.
- **Escenario:** el spec deja vacío «kg que consumió la bobina al cerrar». No prueba la secuencia
  que motivó el orden de `onError`: rechazo de tolerancia, luego la casilla, luego el despunte que
  pide motivo, luego el diálogo y luego el reenvío con la casilla **y** `closeReason`. Si un cambio
  futuro limpiara `tolerance` al abrir el diálogo, el tercer envío saldría sin casilla. El
  servidor volvería a pedir la casilla y la secuencia se haría circular, sin ningún test en rojo.
- **Arreglo:** un segundo caso de pantalla que llene el campo de cierre con una cifra que deje
  despunte sobre el umbral de D-089. Tiene que comprobar dos cosas:
  - que aparece el diálogo «Cerrar con despunte alto» **después** de marcar la casilla;
  - que el cierre termina, con `status: 'CLOSED'` y la entrada de auditoría.

### P3-1 — Aserciones débiles en el caso API del E2E

- **Dónde:** `tolerancia-accesorio-d389.spec.ts:124-125` y `:127-129`.
- **Escenario:** el `HEAVIER_COIL` solo comprueba `status 400`. Un 400 por cualquier otra causa
  (la validación del esquema o una orden ya consumida) también pasaría. El caso aceptado no mira
  que haya quedado la auditoría ni la desviación «Fuera de tolerancia, confirmado con la casilla»
  en el reporte.
- **Arreglo:** comprobar el mensaje («no explica que lo reportado pase lo montado») y, en el
  aceptado, la entrada de auditoría o el campo del reporte. Agregar un caso de más del 5 % para
  `severe: true`, que hoy no tiene cobertura en el accesorio.

### P3-2 — El regex `/motivo/` todavía atrapa rechazos sin código que mencionan «motivo»

- **Dónde:** `accessory-report-card.tsx:166`, frente a `assertToleranceReasonApplies`
  (`production-shared.ts:247-249`: «…elige otro motivo») y al error de esquema de `OTHER` sin
  detalle.
- **Escenario:** en el modo de cierre, una casilla con un motivo que no aplica a un exceso hacia
  arriba da un 400 **sin código** cuyo texto dice «motivo». Eso abre el diálogo del despunte, que
  es el bucle de cc20 por otra puerta. Hoy no se llega desde la UI: el `<select>` solo ofrece
  `TOLERANCE_OVERRIDE_REASONS_OVER` y `overrideInput` valida con `safeParse`. El riesgo es latente.
- **Arreglo:** dar un código propio al rechazo del despunte (p. ej. `CLOSE_REASON_REQUIRED` en
  `closeInTx`) y que la tarjeta lo use en lugar del regex. El panel de planchas usa el mismo
  patrón, así que hay que decidir el alcance antes de tocarlo.

### P3-3 — Comentario y cifra del spec

- **Dónde:** `tolerancia-accesorio-d389.spec.ts:18` dice «un 2,93 % más» y el test espera
  `'2.94'` (`:122`, `:148`).
- **Escenario:** es coherente, porque `excessPct` redondea hacia arriba, pero el comentario induce
  a error a quien ajuste las cifras.
- **Arreglo:** escribir «2,94 % (redondeado hacia arriba)».
