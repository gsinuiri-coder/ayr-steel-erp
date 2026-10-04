# cc15b — autorrevisión

> **Autorrevisión (AGENTS.md §2.2.1): lista de riesgos, no aprobación.** La hizo un subagente que
> no escribió el cambio ni leyó el handoff de implementación. No vale como pase cruzado.

Alcance: `git diff 56e068e..HEAD` en la rama `cc15b/reemplazo-con-reserva` (commits `b7dcf66`,
`0131dd7`): regla dura 8 y su centinela, `InventoryService.replaceEntry`, «Editar compra» por
reemplazo (puntos 3, 4 y 5), `coilQtyOverrides`, tests contra la base y E2E.

Lo que se corrió en esta revisión (worktree `ayr-cc15`):

- `jest kardex-writers purchase-received-edit`: 3 suites, 72 tests, verdes.
- `jest src/inventory`: 7 suites, 52 tests, verdes.
- **No** se corrió `test:db` ni el E2E: resetean `ayr_local_e2e` y la memoria del proyecto pide
  una suite a la vez. `gh run list` devolvió 503; no se verificó la CI de la rama.

## Sin P0 ni P1

`record` y `reverse` no cambian de comportamiento con el refactor (comparación línea a línea contra
`git show 56e068e:apps/api/src/inventory/inventory.service.ts`):

- `record` IN: `entryCost` reproduce las validaciones y el texto de los errores tal cual.
  `stockAfterIn` + `avgOf` dan el mismo promedio que la fórmula anterior para todo saldo previo
  `>= 0`. Solo difieren con saldo previo **negativo** (antes `total/qty`, ahora
  `total/(saldo+qty)`), y ese estado no se alcanza: una salida rechaza `qty > saldo`, y la reversa
  de un ingreso rechaza `origQty > saldo`.
- `reverse` IN: `stockAfterReverseIn` lanza el mismo `BadRequest` (kilos insuficientes) y el mismo
  `Conflict` (valor negativo con kilos, con `stock.value` = el `currentValue` de antes). Cierra en
  cero sin kilos igual que antes. El bloque `if (newValue.isNegative())` posterior queda redundante
  para IN, pero no cambia nada.
- `createMovement` ahora envuelve también el `create` de `record` en el `try/catch` de P2002. El
  único índice único de `inventory_movements` es `reversal_of_id` (`schema.prisma`, `@@unique([reversalOfId])`),
  y `record` nunca lo llena, así que en la práctica no cambia nada.

## P2

**P2-1. Vista previa y guardado no coinciden: precio o cantidad más cambio de color o espesor en
una bobina que respalda material prometido.**
`apps/api/src/purchases/purchase-received-edit.ts:236`: `if (!reentry && item.specPromised !== null)`.
El bucle de especificación (`:584`) llama a `blockedBy(facts, item, 'KARDEX', reentry)`; con
`reentry = true` (la misma línea trae precio o cantidad), `specPromised` no se mira nunca.
Escenario: bobina de 1000 kg que respalda 40,4 kg de material prometido de un pedido. La edición
es `{ unitPrice: '5.5', finishId: <acabado de otro color> }`. La vista previa marca todo como
`REVERSE_REENTRY` / ejecutable (el precio no baja kilos, así que `backsPromised` es `null`, y el
punto 5 queda apagado por `reentry`). Al guardar, `replaceEntry` pasa, la bobina se actualiza y
`assertRawMaterialInvariant` con `alsoAffecting` (`purchase-received-edit.service.ts:935`) rechaza
con 400. Es atómico (la transacción se deshace), pero es justo el caso que el punto 5 tenía que
anticipar. El E2E (`editar-compra-recibida-d372.spec.ts`) solo prueba el cambio de color **solo**.
Arreglo probable: comprobar `specPromised` también con `reentry`, o pasarlo fuera de `blockedBy`
para las filas de especificación.

**P2-2. Un reemplazo deja **otra** compra sin poder anularse (efecto del punto 4).**
`purchases.service.ts:873-884` (`assertNothingMovedAfter`) mide «posterior» **solo por id**
(`id > lastOwnId`) y cuenta como bloqueante cualquier movimiento vivo ajeno, entradas incluidas.
Escenario: compra P1 de producto X (día 1, IN id 10), compra P2 de X (día 5, IN id 20). Se corrige
el precio de P1: `replaceEntry` crea la reversa (id 29, excluida por `reversalOfId`) y el ingreso
nuevo **id 30, fechado el día 1**. Ahora anular P2 falla con «X ya tiene movimientos
posteriores… Anúlalos primero», por el ingreso de P1 que en el kardex es _anterior_. Antes de
cc15b ese estado no existía, porque el punto 4 bloqueaba la edición de P1. No daña datos, pero P2
solo se puede anular si antes se anula P1. Conviene decidirlo: medir por `(operationDate, id)` o no
contar como bloqueantes los `IN` ajenos de compra.

## P3

**P3-1. Centinela: formas de escritura que no detecta.**
`kardex-writers.sentinel.spec.ts:22-37`:

- `TRUNCATE "inventory_movements"` o `TRUNCATE inventory_balances` **sin** la palabra `TABLE` (SQL
  válido) no coincide con ningún patrón (`/TRUNCATE\s+TABLE/i`).
- `DELETE FROM "public"."inventory_movements"` y `UPDATE public.inventory_balances` no coinciden:
  el patrón exige `\s+"?inventory_` justo después de la palabra clave, y el prefijo de esquema lo
  rompe. Lo mismo con `UPDATE ONLY`.
- Un alias (`const m = tx.inventoryMovement; m.create(...)`), el acceso por corchetes y el
  encadenamiento opcional (`inventoryMovement?.create`) pasan.
- Se salta `migrations/` (`SKIP_DIRS`), y una migración de datos es justamente un escritor posible
  del kardex. AGENTS.md (regla 8) dice que el centinela «barre `apps/api/prisma`», sin aclarar que
  deja fuera las migraciones (el trigger de D-286 cubre UPDATE/DELETE de movimientos, pero no
  INSERT ni `inventory_balances`).

**P3-2. Orden de locks dentro de `commit` (bobinas después de saldos).**
`purchase-received-edit.service.ts:111-122` bloquea la compra, sus bobinas y **los saldos**
(`lockBalances`), y recién después `replaceEntry` (`inventory.service.ts:~628`) llama a
`lockRawMaterialCoils`, que toma las **demás** bobinas del agregado. El comentario «bobinas antes
que saldos» de la primitiva no se cumple en su único llamador. Escenario: bobina editada A y otra
bobina B del mismo agregado con `id(B) < id(A)`. Un consumo de B por `record` OUT toma `{A, B}`
ordenadas: bloquea B y espera A. La edición tiene A y espera B: deadlock. Postgres aborta una con
40P01 (probablemente un 500 opaco, sin datos dañados). **No es nuevo**: con `reverse`,
`assertRawMaterialInvariant` ya bloqueaba bobinas después del saldo. Lo que cambia es el alcance:
ahora pasa también en un cambio **solo de precio** de bobina, porque `replaceEntry` toma
`lockRawMaterialCoils` siempre que el ítem es `COIL`. Con varias bobinas en una misma compra, cada
`replaceEntry` toma su agregado por separado, sin un orden global.

**P3-3. La vista previa bloquea más que la primitiva cuando ya hay sobrerreserva.**
`finalReservationShort` (`purchase-received-edit.ts:250-258`) bloquea si
`final < reservado`, aunque el cambio sea solo de precio (`final = saldo`). En cambio,
`assertReservationInvariant` (`reservation-guard.ts:153`) sale de inmediato si
`newQty >= previousQty`. Con un saldo ya por debajo de lo reservado (D-066 no debería permitirlo,
pero sería un dato heredado), la vista previa bloquea una corrección de precio que la primitiva sí
aceptaría. Es coherente hacia el lado seguro.

**P3-4. Bobina reservada entera para venta (D-116) y subida de kilos.**
Con `replace`, `ownReservation` ya no bloquea (`purchase-received-edit.ts:237`), y
`finalReservationShort` deja pasar una subida de kilos. La reserva de la bobina queda con los kilos
viejos y el saldo con los nuevos. No verifiqué cómo despacha la venta de bobina entera («saldo
vigente») en ese caso. Hay que confirmar que la reserva no queda descuadrada.

**P3-5. Mensaje equivocado con especificación y precio a la vez en una bobina con reserva propia.**
Las filas de especificación llaman a `blockedBy` **sin** `replace` (`purchase-received-edit.ts:584`).
Con `reentry = true`, el motivo que se muestra es «la reversa del ingreso dejaría sin cubrir»,
aunque el camino ahora es el reemplazo. Bloquear está bien (cambiar la especificación de una bobina
reservada no se permite); el texto confunde.

**P3-6. Advertencia ±0,0001 con cambio de producto.**
`mixedProduct` (`purchase-received-edit.service.ts:~1179`) filtra por `path === 'REVERSE_REENTRY'`,
y ese camino incluye el cambio de producto (que no usa `replaceEntry`). El aviso de «deshacer»
también sale ahí. Es menor.

**P3-7. El orden PEPS dentro del mismo día cambia tras un reemplazo.**
El ingreso nuevo hereda la fecha, pero recibe un id mayor que el de otra compra del **mismo día**.
`fifoLotConsumption` y el PEPS ordenan por (fecha, instante, id), así que el lote corregido pasa a
consumirse después. Es aceptable, pero no está documentado.

**P3-8. `replaceEntry` como primitiva genérica.**
No excluye `SPLIT_REF_TYPES` (sí es más estricta que `reverse`) y no sabe nada de los estados de
la bobina que no son de kardex (en corte, montada, con flejes asignados). Hoy esos estados los
bloquea `blockedBy` en el único llamador. Un llamador futuro que use la «puerta» de la regla 8 no
los tendría. Conviene que el JSDoc lo diga.

## Cobertura de tests frente a lo pedido

`replace-entry.db-spec.ts` (7 tests, solo `PRODUCT`):

- **Precondición**: solo cubre la rama **por id** (la salida y el ajuste son del mismo día). No hay
  un test de la rama **por fecha** (una salida con id menor y `operationDate` posterior), que es la
  mitad del `OR` de `inventory.service.ts`. Tampoco hay un test de una salida concurrente entre el
  `peek` y el lock, que es la razón de comprobarla «bajo el lock».
- **Dos reemplazos simultáneos**: `Promise.allSettled` no fuerza el solapamiento. Si corren en
  serie, el segundo también falla con «ya fue anulado» (por `reversibleMovement`), así que el test
  pasa con lock o sin él y no distingue los dos casos.
- **Reemplazo contra una reserva nueva**: **no está** en `test:db`. Solo existe como E2E por HTTP
  (`editar-compra-recibida-cc15b.spec.ts:120`). Ese E2E es no determinista: acepta cualquiera de los
  dos ganadores y no prueba que hubo carrera.
- **Bobina / D-134** (`COIL`, `lockRawMaterialCoils`, `assertRawMaterialInvariant` sobre el estado
  final): sin test contra la base. Solo se cubre por E2E (`d372.spec.ts`, la baja a 10 kg).
- `inventory.service.spec.ts` no tiene tests unitarios de `replaceEntry`.
- La configuración está bien: `jest.db.config.js` hereda `rootDir: '../..'`, y la regex
  `.*\.spec\.ts$` del jest normal **no** toma `*.db-spec.ts`. En CI, `test:db` hereda del job
  `ALLOW_DB_RESET=1` y la URL `localhost/ayr_ci_e2e`, que el guard acepta solo con
  `GITHUB_ACTIONS=true`.

## Documentación

`docs/ARQUITECTURA.md` §0.2: la fila D-372 todavía no describe cc15b (dice «la sesión 2 trae una
operación de reemplazo…»), y no hay un `D-nnn` para la reescritura de la regla dura 8. El handoff
y el guion UAT están sin commitear (`docs/handoff/ventana-cc15b.md`, `docs/uat/cc15b.md`). Hay que
completarlo en el cierre.
