# cc20 — autorrevisión de D-388 (tolerancia del reporte de coberturas)

> **Autorrevisión — no vale como pase cruzado.** La hizo un subagente nuevo de la misma sesión,
> sin leer el handoff de implementación ni `docs/PROGRESO.md`. Es una lista de riesgos, no una
> aprobación.

- Rama: `cc20/tolerancia-reporte`, diff `cfc72af..HEAD` (`f4a07f4`, `9c6f73b`, `a4cdc85`, `b184955`).
- Al revisar, el worktree tenía cambios **sin commitear** en `roofing-production.service.ts`,
  `tolerance-override-d388.spec.ts` y `roofing-order-panel.tsx`, que corrigen dos de los hallazgos
  de abajo. Se marcan así; hasta que se commiteen, HEAD sigue con el defecto.
- Corrido: `npx jest src/production` (14 suites, 162 tests, verde, con los cambios sin commitear
  incluidos); `tsc --noEmit` en `apps/api` y `apps/web`, limpio. No se corrió Playwright.
- Las cifras de P1-2 y P3-1 salen de llamar a `mountedKgForReport` del `dist` de `@ayr/shared`
  con la geometría del caso real (script de una vez, fuera del repo).

## Lo que se comprobó y está bien

- **Kardex (regla dura 8):** no hay escritores nuevos; la salida sigue por `InventoryService.record`
  con `outKg = mounted.kg`, que en las dos franjas aceptadas es `available` (el saldo de la
  custodia `assignedKg − consumedKg`), nunca más. La reserva se descuenta por `outKg`.
- **Reversa:** `reverseReport` revierte los movimientos por `refId` y descuenta de la custodia
  `movement.qty`, o sea exactamente lo que salió (4 184, no 4 252,805). La reserva vuelve por la
  misma suma. La E2E lo recorre con reabrir + revertir.
- **Drywall:** `production.service.ts:638` y `drywall-order-panel.tsx:184` no pasan
  `overrideBands`; la rama `overrideBands === undefined` devuelve el mensaje de siempre, sin
  `code`. Hay test.
- **Rol:** `RequestUser.role` es un solo rol; la casilla de un no ADMINISTRADOR da 403. Con los
  cambios sin commitear, el chequeo sube al principio de `reportInTx`, antes de `lockOrder`.
- **D-386:** el diff no agrega bloqueos ni cambia su orden. La auditoría nueva se escribe al
  final, en la misma transacción. `findOne`, `list()` del borrador y el lote leen sin bloquear.
- **`withRowNumber`** conserva `code` y `excess` (`{ ...body, message }`): la E2E lo verifica.
- **Kilos declarados:** el chequeo de franja va antes que el de lo declarado (D-249 se mantiene:
  declarar no salta la tolerancia); con casilla y lo declarado dentro de lo montado, sale lo
  montado.

## P0

Ninguno.

## P1

### P1-1 — Accesorio con «reportar y cerrar» en la franja 1–5 %: abre el diálogo del despunte en bucle

- `apps/web/src/app/(app)/planta/accessory-report-card.tsx:141` y
  `apps/api/src/production/roofing-production.service.ts:1157-1163` (en HEAD, 1156-1162).
- Escenario: un accesorio (reporte por metros) pasa por `reportInTx`, que ahora siempre llama con
  `overrideBands`. Si los metros reportados dan un teórico entre 1 % y 5 % sobre lo montado, el API
  responde `TOLERANCE_OVERRIDE_REQUIRED` con el mensaje «… lo autoriza un administrador, con la
  casilla y **el motivo**». La tarjeta del accesorio no conoce el código y su `onError` hace
  `variables.close && /motivo/i.test(err.message)` → abre el diálogo de motivo del **despunte**
  (D-089). El usuario escribe un motivo, se reenvía con `closeReason`, el API vuelve a rechazar con
  el mismo mensaje y el diálogo se abre otra vez. Sin cerrar, el toast le pide una casilla que esa
  pantalla no tiene.
- Antes de D-388 el mismo reporte se rechazaba con un mensaje sin «motivo»: es una regresión del
  accesorio.
- Arreglo (cualquiera de los dos, a decidir): (a) no pasar `overrideBands` cuando
  `isAccessory(product)`: el accesorio conserva el rechazo de siempre, y una `toleranceOverride` en
  un accesorio se rechaza con 400; o (b) en la tarjeta, mirar `err.code` antes del regex
  (`TOLERANCE_OVERRIDE_REQUIRED`/`TOLERANCE_EXCEEDED` → toast y salir) y cambiar el mensaje para
  que no ofrezca una casilla inexistente. (a) es lo que dice el alcance («su pantalla no tiene
  casilla»).

### P1-2 — La franja se mide sobre el reporte, no sobre la bobina: el caso real partido en dos filas queda bloqueado sin casilla

- `packages/shared/src/schemas/production.ts:571` y `:579` (base `excess ÷ theoretical` del
  reporte), con `roofing-drafts.ts:137-144` acumulando fila por fila.
- Escenario medido con la bobina del caso (XSY-ALZ-ROJO-3020-0.28-4184-10, 4 184 kg, 2,7601 kg/m):
  las mismas 428 planchas de 3,60 m cargadas en **dos filas** del borrador (300 + 128), o
  reportadas en dos partes:
  - fila 1: teórico 2 980,938 kg, cabe, sale el teórico y quedan 1 203,062 kg;
  - fila 2: teórico 1 271,867 kg contra 1 203,062 → exceso 68,805 kg = **5,41 %** de esa fila →
    `TOLERANCE_EXCEEDED`, sin casilla posible.
    Es el mismo exceso de 68,805 kg que en una sola fila da 1,62 % y se autoriza. Todo el desvío
    acumulado de la bobina cae sobre el último reporte, y cuanto más chico es ese reporte, más
    probable es que pase el 5 %. Los reportes parciales son la forma normal de trabajar (D-083,
    «parcial, N veces»).
- No es un error de implementación de lo pedido («exceso dividido por el teórico»), pero el
  resultado depende de cómo planta parta el trabajo, y el caso que motivó D-388 deja de entrar
  apenas se parte. **Requiere decisión del dueño (regla dura 16)** antes del deploy.
- Opciones: medir el exceso sobre el teórico **acumulado de la bobina en esta orden** (reportes
  vivos de esa bobina + esta fila), o sobre el nominal de la bobina, y mantener el reporte como
  unidad del tope. Si se mantiene, decirlo explícitamente en D-388 y en el UAT.

### P1-3 — «Ejecutar y cerrar» con la marca vieja abría el diálogo del despunte (corregido sin commitear)

- `apps/web/src/app/(app)/planta/roofing-order-panel.tsx`, `onError` del commit (en HEAD solo
  existía el regex `/motivo/i` con `closeMode.current`).
- Escenario: la marca `outOfTolerance` se calcula al leer. Si otra pestaña reporta contra la misma
  bobina, o la lectura quedó vieja, una fila sin marca llega al commit en la franja; el API
  responde `TOLERANCE_OVERRIDE_REQUIRED` con «… el motivo» y, si se apretó «Ejecutar y cerrar», se
  abre el diálogo de motivo del despunte, el reenvío falla igual y así sigue.
- Estado: el worktree tiene un `onError` que mira `err.code` antes del regex e invalida. Falta
  commitearlo y cubrirlo con un test.

## P2

### P2-1 — Una casilla marcada sobrevive a la edición de la fila

- `roofing-order-panel.tsx:166` (`overrides` por `draftId`) y `:173` (`overridesReady`).
- Escenario: el administrador marca la fila 2 (1,6 %, «Bobina más liviana»). Antes de ejecutar, la
  fila se edita —él mismo u otra sesión— y queda en 4,8 %. El `draftId` es el mismo, la casilla
  sigue marcada y el commit autoriza una cifra que nadie miró. Solo se limpia con un commit exitoso.
- Arreglo: guardar con la casilla la cifra autorizada (`excessKg`) y descartarla si la marca
  vigente no coincide; o limpiar la entrada al editar o borrar la fila. Si se quiere en la API:
  `toleranceOverrides[].excessKg` esperado, y rechazar si difiere.

### P2-2 — Con varias bobinas montadas, la casilla vacía una bobina sin avisar que otra tiene saldo

- `roofing-production.service.ts:1152-1163`; `tolerance-override.tsx`, texto de la fila.
- Escenario: hay dos bobinas montadas, A con 500 kg y B con 3 000 kg. Planta carga en A una fila
  de 520 kg teóricos (4 %), cuando parte salió de B. El administrador ve «la bobina queda en 0» y
  autoriza «Bobina más liviana». A queda en 0 con un faltante que está en B, el costo de la
  plancha sale por 500 kg y B queda con kilos que ya no tiene. Antes, el rechazo del 1 % decía
  «monta el material que falta».
- Arreglo: si otra bobina montada de la orden tiene saldo, decirlo en el mensaje del rechazo y en
  el aviso de la casilla («B tiene 3 000 kg montados: ¿salió parte de ahí?»). O no ofrecer la
  casilla en ese caso, a decidir por el dueño.

### P2-3 — Tests débiles en lo que mueve kardex o auditoría

- `apps/api/src/production/tolerance-override-d388.spec.ts`: prueba la función pura y
  `checkDraftRows`. No hay unitario de:
  - `appliedOverride === null` cuando la fila entra en el 1 % y viene casilla (no hay auditoría
    propia ni nota «autorizado»), en `roofing-production.service.ts:1179`;
  - el reparto por `draftId` del commit (`roofing-drafts.service.ts:243-248`): dos filas en la
    franja, casilla solo en la 1 → la 2 rechaza con «Fila 2» y no se mueve nada;
  - que las marcas de `list()`/lote (`draftDtos`) coinciden con el veredicto del commit cuando dos
    filas comparten bobina (la segunda arranca de lo que dejó la primera);
  - el accesorio en la franja (P1-1);
  - el detalle de la orden con una auditoría real: `production-list-progress.spec.ts` solo mockea
    `auditLog.findMany → []`, y el parseo de `toleranceOverrideAuditSchema` queda sin test unitario
    (solo lo cubre la E2E).
- El test del 403 existe solo en el worktree, sin commitear.

## P3

### P3-1 — El porcentaje mostrado contradice el límite en los bordes

- `packages/shared/src/schemas/production.ts:571` (`toFixed(2)` con redondeo).
- Medido: 1 000 teóricos contra 989,99 montados → `TOLERANCE_OVERRIDE_REQUIRED` con «**1.00 %** …
  pasa la tolerancia del 1 %». 1 000 contra 949,97 → `TOLERANCE_EXCEEDED` con «**5.00 %** … pasa el
  5 %, que no se puede autorizar». Mismo efecto en la etiqueta de la fila y en la auditoría
  (`differencePct`).
- Arreglo: redondear hacia arriba (`Decimal.ROUND_UP`) o mostrar tres decimales cuando la cifra
  redondeada iguala el límite (lección de «el mínimo mostrado tiene que ser tipeable»).

### P3-2 — La etiqueta «Fuera de tolerancia» sigue en un reporte revertido

- `production.service.ts:1607` y `produccion-detalle-view.tsx:391`.
- Escenario: se revierte el reporte autorizado. En el detalle queda «Revertido» y además «Fuera de
  tolerancia · 1.62 % · …». Es informativo, pero puede leerse como vigente.
- Arreglo: mostrarla atenuada o solo con `status === 'ACTIVE'`. Que lo decida el dueño.

### P3-3 — Doc comment huérfano

- `apps/api/src/production/production-shared.ts:66`: el comentario «Corta si la orden ya es
  terminal…» de `assertLive` quedó arriba del bloque D-388, separado de su función.
- Arreglo: mover las constantes D-388 por encima de ese comentario.

### P3-4 — `detail: ''` se guarda como cadena vacía

- `packages/shared/src/schemas/roofing.ts` (`toleranceOverrideSchema`): con un motivo distinto de
  «Otro», un detalle de espacios queda como `''` (no `undefined`) y la auditoría guarda
  `detail: ''` en vez de `null`. La web ya lo filtra; la API directa no. Arreglo:
  `.transform((v) => v || undefined)` o un `preprocess`.
