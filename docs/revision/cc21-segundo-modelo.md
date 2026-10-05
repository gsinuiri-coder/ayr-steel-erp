# Revisión de segundo modelo (Sonnet, contexto limpio)

Entrega cc21, D-389 PR 1 (`30a2e1b..e1f0211`). Es la revisión de otro modelo, no una aprobación humana. Corrí jest de `tolerance-override*` y `roofing-drafts` (57 pruebas en verde). No corrí Playwright, build, dev ni `test:db`.

**Veredicto: sin P0 ni P1.** La regla de D-389 queda bien implementada en los tres lugares que la leen (`mountedKgForReport`, `checkDraftRows`, `resolveDraft` del web). Los hallazgos son residuos de la lógica de D-388, huecos de prueba y un riesgo de política.

## Lo que verifiqué y está bien

- Sin tope, sin 403: el chequeo de `Role.ADMINISTRADOR` salió de `reportInTx`. El controlador (`roofing-production.controller.ts:66`) ya limita a ADMINISTRADOR y SUPERVISOR_PLANTA.
- Kardex: `outKg = mounted.kg = available` en toda rama aceptada; el consumo no pasa el saldo y la bobina no queda en negativo. No se tocó ninguna puerta de `InventoryService`.
- Motivo en la API: `assertToleranceReasonApplies` corre dentro de la transacción, antes de la auditoría, el consumo y el kardex. Con `HEAVIER_COIL` el commit del borrador se deshace entero. El e2e lo cubre (la fila 236 espera 400 y comprueba que el saldo no cambió).
- El motivo solo se valida cuando la casilla se aplicó. Una casilla de más dentro del 1 % no deja rastro ni falla.
- `severe` en el borde exacto: 5 % exacto no es severo, y el redondeo hacia arriba de `excessPct` no contradice a `severe`.
- Accesorio y drywall no cambian: el accesorio no pasa `overrideBands` y drywall tampoco.
- Sin migración.

## P2

### P2-1. Un exceso sin tope entra valorizado por una fracción del material (riesgo de política, D-249)

`packages/shared/src/schemas/production.ts:566-593`, `apps/api/src/production/roofing-drafts.ts:137-165`.

Escenario: un borrador de 7 piezas (teórico 32 kg) sobre una bobina con 19 kg libres porque la fila 1 ya la consumió. Antes se rechazaba con «monta más material». Ahora entra con la casilla y el aviso fuerte, el kardex sale por 19 kg y la plancha queda valorizada con ese costo parcial. Es el mismo riesgo que D-249 describe: margen de RF-S4a inflado.

El aviso fuerte lo advierte pero no lo evita, y la casilla se marca igual. Es la decisión del dueño, así que no la cambio. Pido que quede escrito en D-389 como riesgo aceptado y que el reporte de márgenes pueda distinguir esas filas. La auditoría `report-tolerance-override` ya guarda `differencePct`, así que se puede.

### P2-2. El motivo que se ofrece puede ser falso cuando el exceso viene del propio borrador

`apps/web/src/app/(app)/planta/tolerance-override.tsx:104-116`.

Si el exceso nace de que otra fila del borrador ya ocupó la bobina, «Bobina más liviana que el nominal» no es la causa real. El mensaje de la fila no distingue «la bobina rindió menos» de «ya no queda acero». Queda como cuadro de «Otro» con detalle, pero el flujo empuja a «más liviana».

Arreglo: cuando `checkDraftRows` sabe que `alreadyKg > 0`, mostrar en el aviso cuánto ocupó el borrador. Opcionalmente exigir detalle en ese caso.

### P2-3. Todavía hay caminos que rechazan sin casilla

`packages/shared/src/schemas/production.ts:530-535` y `:600-608`.

- Con `available <= 0` (bobina agotada) el rechazo sigue sin código y sin casilla. Es coherente con «ninguna bobina en negativo», pero contradice la frase «el reporte nunca se rechaza». El texto del brief y del guion UAT debe decir «nunca por porcentaje».
- Con `declaredKg > available`, tras aceptar la casilla, sigue el rechazo sin código «monta más material o corrige la cifra». La pantalla no ofrece salida, porque solo escucha `TOLERANCE_OVERRIDE_REQUIRED`. Es el comportamiento previo, pero ahora es el único rechazo visible en la franja aceptable.

Arreglo: dejarlo y documentarlo en D-389. Sería P1 solo si el dueño espera aceptación literal sin condiciones.

## P3

### P3-1. Comentarios y documentación de D-388 que ya no son verdad

- `packages/shared/src/schemas/roofing.ts:682` ("por qué un administrador autoriza").
- `packages/shared/src/schemas/roofing.ts:704`, `:774-775` ("Solo ADMINISTRADOR (la API lo valida). Fuera de esa franja no se usa") y `:847`.
- `packages/shared/src/schemas/roofing.ts:873-874` ("entre el 1 % y el 5 %", "casilla de un administrador").
- `apps/api/src/production/roofing-drafts.ts:65-66` y `:142`.
- `apps/api/src/production/production-shared.ts:89-91` ("o más del 5 %") y `:113` ("franja autorizada").
- `apps/api/src/production/roofing-production.service.ts:1151-1152` ("por encima del 5 % no hay casilla") y `:1159` ("Las franjas son de las planchas").
- `packages/shared/src/schemas/production.ts`: la descripción de `TOLERANCE_OVERRIDE_REQUIRED`, el nombre `THEORETICAL_KG_OVERRIDE_MAX_RATIO` («OVERRIDE_MAX» ya no es un tope) y el campo `maxPct` en `MountedKgExcess`.

El comentario de `:774` es el más peligroso: dice que solo un administrador puede usar la casilla, y la API ya no lo valida. Arreglo: actualizar los textos; el renombre es opcional pero evita confusiones.

### P3-2. Pruebas débiles

- No hay prueba unitaria de que `reportInTx` lance 400 con `HEAVIER_COIL` aplicado. Solo se prueba el helper aislado (`tolerance-override-d388-services.spec.ts`) y el e2e. Si alguien quita la llamada en `roofing-production.service.ts:1167`, las pruebas unitarias siguen en verde.
- La prueba «un supervisor no recibe 403» solo demuestra que la ejecución llega a la base y falla ahí (`tolerance-override-d388.spec.ts`, `reportInTx`). No prueba la regla.
- Falta una prueba de que la casilla con `HEAVIER_COIL` dentro del 1 % no falla ni deja auditoría. Es la propiedad que justifica validar solo cuando `applied !== null`.
- Falta la rama donde `declaredKg` rechaza tras aceptar (P2-3).

### P3-3. UI menor

- La insignia de la tabla de borrador (`roofing-order-panel.tsx:867-869`) muestra «Fuera de tolerancia (x %)» igual con `severe` y sin él. Conviene variante `destructive` o texto «revisar» cuando `severe`.
- El texto fuerte aparece dos veces para el usuario: en el aviso de la fila al agregarla (`resolveDraft`) y en el panel de la casilla. Es redundante pero inofensivo.
- El aviso `ToleranceOverrideRow` dice «Para confirmar, marca la casilla…» y repite «se descuentan los N kg montados y la bobina queda en 0». Correcto, sin hallazgo.

### P3-4. D-389 no está en `docs/ARQUITECTURA.md` §0.2 en este diff

Los comentarios de código citan D-389, pero la fila no está en este rango. Si va en el PR siguiente, no hay problema. Si no, la regla dura 16 pide que la decisión quede registrada.
