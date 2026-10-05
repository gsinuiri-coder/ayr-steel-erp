# cc21 — D-389, PR 1: autorrevisión

> **Autorrevisión: no vale como pase cruzado.** La hizo un subagente nuevo que no leyó el
> handoff de implementación ni `docs/PROGRESO.md`. Es una lista de riesgos, no una aprobación.

- Diff revisado: `30a2e1b..e1f0211` (un commit, `e1f0211`), 10 archivos.
- Contexto leído: `AGENTS.md`, la fila D-388 y la fila D-249 de `docs/ARQUITECTURA.md` §0.2.
- Corridas propias:
  - `npx jest src/production` en `apps/api`: 15 suites y 188 tests, todos verdes. Incluye
    `tolerance-override-d388.spec.ts`, `tolerance-override-d388-services.spec.ts` y
    `roofing-drafts.spec.ts`.
  - `tsc --noEmit` sin errores en `packages/shared`, `apps/api` y `apps/web`.
  - No se corrió Playwright, por instrucción del brief.

## Lo que se verificó y está bien

- **No queda ningún rechazo por pasar el 5 %.** `TOLERANCE_EXCEEDED` ya no aparece en `apps`,
  `packages` ni `e2e`. La regla vive en un solo punto, `mountedKgForReport`, con
  `overrideBands`, y la usan los cuatro caminos. Con `authorized: true` ninguno rechaza por
  porcentaje:
  - el borrador al ingresar o corregir una fila (`roofing-drafts.ts:137`);
  - el editor web (`roofing-order-panel.tsx:1533`);
  - el reporte directo (`roofing-production.service.ts:1153`);
  - `report-and-close` y `drafts/commit`, que pasan los dos por `reportInTx`.
- **El consumo nunca supera el saldo**, aunque el porcentaje sea enorme. La rama aceptada
  devuelve siempre `kg: available` (`production.ts:603-614`). Con kilos declarados, también
  sale `available`. Si lo declarado pasa lo montado, la regla de D-249 sigue rechazando, y con
  `available ≤ 0` el reporte se rechaza antes de calcular la franja. En el borrador, la fila 3
  sobre una bobina que ya vació la fila 2 se rechaza (`roofing-drafts.spec.ts:57-63`).
- **Rol:** se quitaron el `ForbiddenException` de `reportInTx` y el `isAdmin` de la web. El
  controlador sigue en `ADMINISTRADOR, SUPERVISOR_PLANTA`
  (`roofing-production.controller.ts:66`).
- **Motivos:** la web solo ofrece `TOLERANCE_OVERRIDE_REASONS_OVER`. La API rechaza
  `HEAVIER_COIL` con `assertToleranceReasonApplies` cuando la casilla se aplica. Una casilla
  marcada dentro del 1 % no deja rastro, igual que en D-388.
- **Reversa:** el kardex sale por `outKg`, la reserva baja por `outKg` y la reversa deshace el
  movimiento real. El E2E nuevo revierte y vuelve a 4 184 kg. El cierre usa la salida real por
  reporte (`reportsOutKg`), no el teórico.
- **Drywall** sigue sin `overrideBands` y conserva su rechazo. **El accesorio** sigue fuera: no
  recibe `overrideBands` y la API rechaza la casilla.

## Hallazgos

### P0

Ninguno.

### P1

**P1-1. D-389 reabre, detrás de la casilla, el caso que cerró D-249: plancha valorizada por una
fracción de su material.**

- Dónde: `packages/shared/src/schemas/production.ts:563-596` (se quitó el tope) y
  `apps/api/src/production/roofing-production.service.ts:1153-1172`.
- Escenario:
  1. Una orden tiene dos bobinas montadas. La B-2 tiene 1 kg sin rolar.
  2. El supervisor elige la B-2 por error y reporta el resto del plan: 4 043 kg teóricos.
  3. El exceso es del 99,97 %. Sin casilla llega `TOLERANCE_OVERRIDE_REQUIRED` con el texto
     fuerte. Con la casilla y «Otro: …», el reporte entra.
  4. El kardex saca 1 kg de la B-2 y da entrada a todas las planchas, valorizadas con el costo
     de 1 kg.
  5. Es exactamente el ejemplo de D-249: «un dedazo en planta terminaba como margen inflado en
     una pantalla de gerencia».
- El kardex queda cuadrado y ninguna invariante lo delata. La B-1 queda intacta y el desfase
  aparece recién al cerrar o al mirar el margen.
- Hasta D-388 el 5 % era el freno. D-389 lo quita a pedido del dueño, y la marca la puede poner
  un supervisor.
- Arreglo: no es un defecto de código, sino una consecuencia de política que conviene que el
  dueño confirme explícitamente. La fila D-389 debería decir que deja sin efecto, para coberturas
  con casilla, el freno de D-249, y aceptar ese riesgo. Si no lo acepta, hay tres mitigaciones
  posibles sin volver al tope:
  - marcar el reporte `severe` en la auditoría y en el detalle (ver P3-2);
  - pedir un detalle obligatorio cuando `severe`;
  - avisar en la pantalla de margen sobre los reportes con exceso fuerte.
- Nota: D-389 todavía no figura en `docs/ARQUITECTURA.md` §0.2 en este diff. `grep D-389` no
  da resultados.

### P2

**P2-1. Una casilla marcada para una fila con poco exceso sigue valiendo cuando esa fila pasa a
un exceso fuerte porque cambió otra fila del borrador.**

- Dónde: `apps/web/src/app/(app)/planta/roofing-order-panel.tsx:323-329`. Solo se limpia la
  casilla de la fila **editada**. El servidor tampoco compara la casilla con el exceso que vio
  quien la marcó (`roofing-drafts.service.ts:244-263`).
- Escenario:
  1. La bobina tiene 1 000 kg.
  2. La fila 1 saca 900 kg.
  3. La fila 2 suma 104 kg teóricos contra 100 kg que quedan: 3,85 %. El supervisor la marca
     con «más liviana».
  4. Después corrige la fila 1 a 990 kg. La fila 2 pasa a 104 contra 10, un 90 %, y aparece el
     aviso fuerte.
  5. La casilla de la fila 2 sigue marcada, `overridesReady` es `true` y «Ejecutar» pasa sin
     volver a confirmar.
  6. Lo mismo pasa si se quita una fila anterior o si otra pestaña reporta contra la bobina.
- Con D-388 el error quedaba acotado al 5 %. Con D-389 no tiene techo.
- Arreglo: invalidar la casilla cuando cambian el `excessPct` o el `severe` de la fila. Por
  ejemplo, guardar en `ToleranceOverrideState` el `excessKg` y el `severe` con que se marcó y
  tratar como vacía la casilla si ya no coinciden. Como alternativa más fuerte, que el commit
  mande el `excessKg` confirmado y la API rechace con `TOLERANCE_OVERRIDE_REQUIRED` si no
  coincide.

**P2-2. No hay ninguna prueba de más del 5 % en el reporte directo ni en `report-and-close`.**

- Dónde: `e2e/tests/tolerancia-reporte-d388.spec.ts:299-332`. El test de D-388 que probaba el
  `/report` directo se reemplazó por uno que solo usa `drafts/commit`.
- Escenario: si mañana alguien vuelve a poner un tope solo en `report()` o en `reportAndClose()`
  (por ejemplo, reintroduciendo un chequeo previo a `reportInTx`), ninguna suite lo detecta. El
  unitario de `reportInTx` solo prueba que no hay 403 antes de `lockOrder`.
- Arreglo: un caso E2E o de servicio de `/report` con `PIECES_OVER_5` y la casilla, y otro de
  `/report-and-close`. Los dos tienen que esperar 200, el saldo en 0 y `HEAVIER_COIL` rechazado
  con 400.

### P3

**P3-1. Quedan restos de «administrador» en comentarios, docstrings y títulos.** No cambian el
comportamiento, pero contradicen D-389 para quien lea:

- `apps/api/src/production/roofing-drafts.ts:65-66`: «entre el 1 % y el 5 % … la casilla de un
  administrador»; además describe la franja con tope.
- `apps/api/src/production/roofing-drafts.service.ts:240`: «la casilla del administrador viaja
  por fila».
- `apps/api/src/production/production-shared.ts:89-91`: «la franja 1–5 % sin casilla, o más del
  5 %».
- `apps/api/src/production/production.service.ts:1613-1614`.
- `apps/api/src/production/roofing-production.service.ts:1149-1150`: «por encima del 5 % no hay
  casilla», que ahora es falso.
- `packages/shared/src/schemas/production.ts:462` y `:714`.
- `packages/shared/src/schemas/roofing.ts:682`, `:703` y `:847`.
- `apps/web/src/app/(app)/planta/roofing-order-panel.tsx:325-326` («el administrador la vuelve a
  marcar») y `:375`.
- `apps/web/src/app/(app)/produccion/[id]/produccion-detalle-view.tsx:390`.
- El `test.describe` de `e2e/tests/tolerancia-reporte-d388.spec.ts:167`: «con la casilla del
  administrador».

Arreglo: actualizar los textos a D-389. El comentario de `roofing-production.service.ts:1149` es
el más engañoso.

**P3-2. El exceso fuerte no queda distinguido después de ejecutar.**

- `toleranceOverrideAuditAfter` (`production-shared.ts:123-147`) no guarda `severe`.
- El detalle de la orden y el badge del borrador (`roofing-order-panel.tsx:867-870`) muestran
  «Fuera de tolerancia (x %)» igual para 1,5 % que para 90 %.
- Escenario: gerencia revisa reportes con la casilla y no puede filtrar los que pasaron el 5 %
  sin recalcularlo desde `differencePct`.
- Arreglo: agregar `severe` al `after` de la auditoría y dar otro tono al badge cuando `severe`.
  Es mitigación de P1-1.

**P3-3. «5 %» está escrito a mano en el aviso del editor.**

- Dónde: `roofing-order-panel.tsx:1556-1558`, «Diferencia mayor al 5 %».
- `ToleranceOverrideRow` y `mountedKgForReport` usan `excess.maxPct`. Si cambia
  `THEORETICAL_KG_OVERRIDE_MAX_RATIO`, el editor queda desalineado.
- Arreglo: usar `${mounted.excess.maxPct}`.

**P3-4. `TOLERANCE_OVERRIDE_REASONS_OVER` está tipado como `readonly ToleranceOverrideReason[]`
y no como tupla `as const`.**

- Dónde: `packages/shared/src/schemas/roofing.ts:693`.
- No se puede usar en un `z.enum` si mañana se quiere validar la dirección en el schema. Tampoco
  hay un test que ate la lista al rechazo de la API más allá de `toEqual`.
- Es menor y no tiene escenario de fallo hoy.

**P3-5. `ToleranceOverrideRow` documenta un título «Reporte de OP-000034» que hoy no usa nadie.**

- Dónde: `tolerance-override.tsx:58`. El único llamador es `ToleranceOverrideFields`.
- No es un defecto. Conviene confirmar si es preparación para el PR 2 o quitar el ejemplo.

**P3-6. Dos detalles de los tests.**

- Al test `D-389: el borrador acepta la fila de más del 5 %…`
  (`tolerance-override-d388.spec.ts:185`) le falta afirmar el `availableKg`/`outKg` de la fila
  frente al saldo. Sí verifica `outKg = 4184.000`, así que está bien; queda anotado solo como
  cobertura.
- El unitario «un supervisor de planta con casilla no recibe 403» acepta cualquier error que
  diga «llegó a la base». Como el proxy captura cualquier acceso a `tx`, el test pasa si
  `lockOrder` es lo primero que toca la base, y deja de probar algo si alguien mueve un chequeo
  de rol después de `lockOrder`. Arreglo opcional: afirmar además que el error no es
  `ForbiddenException`.

## Regresiones buscadas sin hallazgo

- **Borrador:** la acumulación por bobina usa `mounted.kg`, que es lo que sale. La web aproxima
  `taken` con la suma de los teóricos topada en el saldo de la bobina. Eso coincide con la API
  salvo en el orden de edición, como antes del cambio.
- **Drywall:** `drywall-order-panel.tsx:184` y `production.service.ts:638` no pasan
  `overrideBands`.
- **Accesorio:** `accessory-report-card.tsx` no leía `TOLERANCE_EXCEEDED`, y el typecheck de la
  web está limpio.
