# Autorrevisión — cc18, D-386: orden único de bloqueos

Fecha: 2026-10-04. La hizo un subagente nuevo, que no leyó el handoff ni PROGRESO, sobre
`git diff origin/main...HEAD` en `5baeee0`.

**Es una autorrevisión: una lista de riesgos, no una aprobación** (AGENTS.md §2.2.1). La
resolución de cada hallazgo está al final.

## Veredicto

No hay P0 ni P1. El orden canónico (documento → reservas → bobinas con agregado → saldos) está
aplicado en los caminos que lista el mapa. En las operaciones tocadas no queda ningún saldo
tomado antes que una bobina ni ninguna reserva tomada después de bobinas o saldos.

Se respetan la regla dura 8 y `Decimal`.

Quedan riesgos de comportamiento en caminos poco frecuentes:

- el `NOWAIT` puede devolver 409 donde antes se esperaba;
- un UUID en mayúscula cambia el comportamiento;
- el db-spec puede pasar sin haber ejercitado nada.

## Hallazgos

1. **P2: falsos 409 del `NOWAIT`** cuando la operación no tomó el agregado al inicio o lleva la
   bobina a otro agregado.
   - Enviar a corte (`cutting.service.ts`) usaba `lockCoilRows` sin el agregado.
   - Editar una bobina con cambio de acabado (`coil-operations.service.ts`).
   - «Editar compra» con cambio de color o espesor (`purchase-received-edit.service.ts`).

   El guardrail pide después el agregado destino, que es nuevo para la transacción.
2. **P2: el db-spec puede pasar sin ejercitar nada.** Cualquier `HttpException` cuenta como
   «rechazo de dominio»: si una fixture queda mal y las dos operaciones fallan siempre con 400, el
   test sale verde.
3. **P2: pares del mapa sin test concurrente.**
   - Drywall: reporte, cierre, reversa y reapertura.
   - Coberturas: reversa de reporte, reapertura, cierre con despunte y borradores.
   - Corte, revertir partido, deshacer lote de restauración y mostrador.
   - Confirmación con bobinas nombradas: el par despacho × confirmación usa solo productos.
4. **P3: un UUID en mayúscula da 404 en `lockCoil`.** `lockCoilRows` devuelve el id en minúscula
   (como lo entrega Postgres) y la comparación falla. En el estado por transacción, además, puede
   provocar un `NOWAIT` espurio.
5. **P3: el log del filtro mezcla el `NOWAIT` con los deadlocks.** Los dos salen como «abortado
   por Postgres» con 40P01, así que no se pueden medir por separado.
6. **P3: rendimiento.** Hay más consultas por operación:
   - `lockCoil` calcula el agregado;
   - despacho y reversa duplican `resolveItemBusinessLineId`, `lockBalance` y
     `findLineReservation`;
   - los borradores llaman a `lockInOrder` por fila.

   Cinco transacciones con el timeout por defecto de Prisma (5 s) ahora hacen más trabajo: merma,
   anular merma, anular bobina y film (abrir y volver a sellar). Propuesta: medir.
7. **P3: falsos negativos del centinela.** No ve la tabla con esquema, la cláusula armada en otro
   fragmento, `$queryRawUnsafe` concatenado ni sentencias de más de 600 caracteres.
8. **P3: guard de la base de pruebas.** Confirmar que ningún otro guard exija `ayr_local_e2e`
   exacto.
9. **P3: validaciones que ahora fallan antes.**
   - Reportar en coberturas bloquea el saldo de todas las bobinas montadas. `lockBalance` rechaza
     un saldo de otra línea, cosa que montar ya impide.
   - La lectura de la reserva al revertir un reporte de coberturas subió.

## Lo que intentó romper y no pudo

- **El `WeakMap` por `tx`.** En Prisma 6.19, el cliente de una transacción interactiva es un único
  objeto y no anida. Ningún camino fuera de una transacción llega a `lockCoilRows` con
  `lockCoils`.
- **Saldos vacíos fantasma.** Todo `items` de `lockInOrder` es un ítem que se mueve o que ya tiene
  saldo.
- **`NotFound` de una bobina inexistente:** se conserva.
- **`localeCompare` frente a `compareLockKeys`:** dan el mismo orden sobre `TIPO:uuid`.
- **`ORDER BY "id" FOR UPDATE`:** bloquea en el orden del sort.
- **`NOWAIT` sobre filas propias.** Las bobinas creadas o actualizadas por la misma transacción ya
  son suyas, así que no da un falso 409.
- **Los caminos comunes no llegan al `NOWAIT`:** borradores, reportar y cerrar, montaje con
  reapertura, revertir partido, anulación con flejes y restauración por lote. En la segunda toma
  el conjunto ya estaba tomado.
- **`LockConflictFilter`:**
  - no se traga errores de dominio;
  - funciona como `APP_FILTER`;
  - no toca contextos que no sean HTTP (jobs, CLI);
  - los borradores dejan pasar el 409.
- **Regla dura 8 y `Decimal`:** sin escritores nuevos ni aritmética con `number`.

## Resolución (autor, 2026-10-04)

Se completa al cerrar la sesión, junto con la revisión de segundo modelo
(`docs/revision/cc18-segundo-modelo.md`).
