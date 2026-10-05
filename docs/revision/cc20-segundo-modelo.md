# Revisión de segundo modelo (Sonnet, contexto limpio)

Entrega: cc20 (D-388), `git diff cfc72af..HEAD` (4 commits, 13 archivos). Es la revisión de un modelo, no una aprobación humana ni la del dueño.

Verificado: `npx jest src/production/tolerance-override-d388.spec.ts src/production/production-list-progress.spec.ts` (29 pasan) y `tsc --noEmit` en `apps/api` limpio. No corrí Playwright, `next build`, `dev` ni `test:db`: lo que dicen los E2E de `e2e/tests/tolerancia-reporte-d388.spec.ts` lo leí, no lo ejecuté.

## Veredicto

**Sin P0 ni P1.** Las franjas, la autorización, el consumo y la consistencia borrador/commit están bien. Hay 3 P2 y 4 P3.

Lo que revisé y no encontró defecto:

- **Franjas y bordes** (`packages/shared/src/schemas/production.ts`, `mountedKgForReport`): `excess.gt(tolerance)` deja el 1 % exacto dentro; el 5 % exacto es autorizable (`gt`, no `gte`); más de 5 % da `TOLERANCE_EXCEEDED` aun con casilla; saldo 0 sigue con el mensaje de «monta más material», sin código. Drywall no pasa `overrideBands` y conserva el rechazo de siempre. «Sale menos de lo montado» no se tocó.
- **Autorización en la API** (`roofing-production.service.ts:1399-1404`): el rol se valida en `reportInTx` con `actor.role`, antes de evaluar la franja. Por la puerta del borrador (`commit`) y por la directa (`report`, `reportAndClose`) pasa el mismo código. Un no administrador con casilla recibe 403 aunque la fila no la necesitara.
- **Kardex**: `kg` sale de `available` (`rowRemainingKg`), nunca del teórico, en las dos franjas; no hay escritor nuevo de `inventory_movements` (regla 8). La reversa es la de D-246, sin cambios. No se añadió ningún bloqueo de fila: la auditoría se escribe al final de la misma transacción, así que el orden de D-386 no se altera. `list()` y el batch leen sin bloquear y solo para marcar.
- **Borrador contra commit**: `checkDraftRows` usa la misma `mountedKgForReport` que `reportInTx`, con `authorized: true` solo para marcar. La revalidación de `commit` y `reportInTx` descuenta lo que ya ocupan las filas previas de la misma bobina (la segunda fila sobre una bobina topada falla con el mensaje de siempre). `withRowNumber` conserva `code` y `excess` (hace spread del cuerpo), así que el rechazo por fila sale con su código y su «Fila N:».
- **Idempotencia**: el `claimIdempotencyKey` va dentro de la transacción, así que el 400 por casilla faltante lo deshace y reintentar con casilla no choca con la clave.
- **UI**: el bloque aparece solo con filas marcadas (`rows.length === 0 → null`); el no administrador ve el bloqueo y no tiene casilla; los botones de ejecutar quedan deshabilitados sin casilla y motivo completos; el aviso usa `tone-warning`, sin rojo; la casilla, el motivo y el detalle llevan `aria-label` con fila y orden. Las casillas de filas que dejaron de estar fuera de tolerancia no viajan (se filtran por `outOfTolerance`).
- **Auditoría y etiqueta**: entrada propia en `production_orders`, con el `reportId` dentro; el detalle la lee con una sola consulta por orden y `safeParse`, tolerante a entradas ajenas.

## P2

### P2-1. El accesorio pasa a la franja autorizable pero su pantalla no tiene casilla

`apps/api/src/production/roofing-production.service.ts:1156-1161` y `apps/web/src/app/(app)/planta/accessory-report-card.tsx:121`.

`reportInTx` también atiende al accesorio (D-343), que llega por `/production/roofing/:id/report` y `report-and-close` desde `AccessoryReportCard`. Esa tarjeta no manda `toleranceOverride` ni lo ofrece. Escenario: un accesorio con metros que pasan lo montado en 1,5 %. Antes era un rechazo sin más. Ahora el rechazo dice «hasta el 5 % lo autoriza un administrador, con la casilla y el motivo», pero ningún usuario, tampoco un administrador, tiene dónde marcarla en esa pantalla. El efecto sobre el kardex no cambia (sigue bloqueado), pero el mensaje promete algo que la pantalla no ofrece.

Arreglo: o bien dar a la tarjeta del accesorio la misma casilla (reusar `ToleranceOverrideFields` con el código `TOLERANCE_OVERRIDE_REQUIRED` de la respuesta), o bien pasar `overrideBands` solo si `!accessory` y dejar el accesorio con su rechazo de siempre. Es decisión de alcance del dueño (regla 16): el brief hablaba del reporte de coberturas por borrador.

### P2-2. El texto del rechazo dispara el diálogo de motivo del despunte

`apps/web/src/app/(app)/planta/roofing-order-panel.tsx` (`commit.onError`, `/motivo/i.test(err.message) && closeMode.current`) contra `packages/shared/src/schemas/production.ts` (mensaje de `TOLERANCE_OVERRIDE_REQUIRED`: «…con la casilla y el motivo»).

Escenario: el administrador pulsa «Ejecutar y cerrar» con el borrador que la pantalla creía dentro del 1 % (lista vieja o cambio de montado desde otro puesto) y la API responde `TOLERANCE_OVERRIDE_REQUIRED`. Su mensaje contiene «motivo», así que `onError` abre el diálogo del motivo de despunte (`setAskingReason(true)`) y se traga el error, sin mostrar las cifras. Lo mismo con el 400 de Zod «Con «Otro», explica el motivo».

Arreglo: que la rama de despunte compruebe también que el cuerpo no trae `code` de tolerancia (por ejemplo `err.body?.code === undefined`), o quitar la palabra «motivo» del mensaje de la API. Un test de componente o un E2E con la lista vieja lo cubriría.

### P2-3. La autorización de servidor, la auditoría y la casilla por fila del commit solo las prueba el E2E

`apps/api/src/production/tolerance-override-d388.spec.ts`.

El spec unitario prueba bien `mountedKgForReport`, `checkDraftRows` y el esquema del motivo. Pero nada unitario ejecuta `reportInTx`: el 403 de rol, que la auditoría se escriba solo si la casilla hizo falta (la «casilla de más» sin rastro), la aserción de `toleranceOverrides` por `draftId` en `commit` y el mapeo `reportToleranceOverrides`. Todo eso queda detrás de Playwright, que además es la suite más lenta y la que más se salta. Ese es el punto donde la regla dura de autorización vive.

Arreglo: un spec con `RoofingProductionService` y Prisma simulado (hay patrón en `production-list-progress.spec.ts`) con tres casos: rol distinto de ADMINISTRADOR con override da 403; administrador con override dentro del 1 % no llama a `audit.write`; administrador con override en 1–5 % lo llama con `reason` y `differencePct`.

## P3

1. **`HEAVIER_COIL` no puede explicar este exceso** (`packages/shared/src/schemas/roofing.ts`, `TOLERANCE_OVERRIDE_REASONS`). El exceso se da cuando lo montado es menor que el teórico; una bobina más pesada que su nominal tendría más kilos, no menos. El motivo «Bobina más pesada que el nominal» solo sirve de dato equivocado. Si el dueño lo pidió así, déjalo; si no, retirarlo o confirmarlo.
2. **`excessPct` redondeado a dos decimales** (`production.ts`, `excess.div(theoretical).times(100).toFixed(2)`). Un exceso de 1,004 % se muestra «1.00 %» junto a «pasa el 1 %». El veredicto es correcto (se compara con Decimal sin redondear), solo la cifra confunde. Mostrar tres decimales o `>1.00` en ese borde.
3. **`toleranceOverrides` con `draftId` repetido o ajeno** se ignora en silencio (`roofing-drafts.service.ts`, `new Map(...)`: gana la última; un id que no es del borrador no da error). No hay efecto en kardex, pero un cliente mal escrito no se entera. Rechazar ids que no estén en el borrador.
4. **Una consulta más a `audit_log` por cada detalle de orden**, también en drywall (`production.service.ts`, `reportToleranceOverrides`, con `hasReports`). Va por el índice `(entity, entity_id, at)` y es una sola; si hay presupuestos de consultas para `findOne`, comprobar que el de drywall no los rompa. Se podría saltar la consulta cuando la orden no es de coberturas.

## Tests que no prueban lo que dicen

No encontré ninguno. El nombre «el borrador acepta la fila y la marca» (`tolerance-override-d388.spec.ts`) sí comprueba `outOfTolerance` y `outKg`; el caso del 5 % exacto comprueba los dos lados del borde. Una observación menor: `reportedMeters: theoretical.minus(theoretical)` es un cero escrito de forma rebuscada, legible pero engañoso.
