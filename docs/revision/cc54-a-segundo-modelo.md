# cc54 corte A (deuda de cc53) — revisión de segundo modelo

Revisor: segundo modelo (Sonnet, contexto limpio). Solo lectura sobre `git diff origin/main...HEAD`
(un commit, 7988e008, rama `cc54-a-deuda-cc53`, 17 archivos). No se corrió ninguna suite ni se tocó ninguna
base ni puerto; todo es lectura de código. **No vale como aprobación**: la revisión la cierra el dueño
(AGENTS.md §2 regla 2.3).

Alcance: `recost-engine.ts` (`firstNegativeDate`, `firstValidDate`, `cancelSameDayReversals`,
`qtyRowsFromMovements`, `negativeSpans`), `inventory-recost.ts` (`qtyRowsOf`), `inventory.service.ts`
(`record`/`reverse`/`assertNoNegativeAtDate`), `invoice-dispatch-plan.ts`, `opening-date-move.service.ts`,
`packages/shared/.../operation.ts`, `apps/web/src/lib/api.ts`, `inspect-cc53-cli.ts`,
`recost-historic-cli.ts`, `recost-historic.ts`, el centinela de topes y los specs.

Veredicto: **sin P0 y sin P1.** Dos P2 y cuatro P3. Los cierres de P2-1..P2-6 y P3-2..P3-4 de
`cc53-b-segundo-modelo.md` están, en lo esencial, bien hechos; lo que queda es residual.

## Hallazgos

### P2-1 — el plan ya no coincide con el kardex cuando el saldo final es negativo y no hay filas posteriores

`recost-engine.ts` (`firstNegativeDate`, condición `running.gte(0) && running.minus(taken).lt(0)`), usado por
`invoice-dispatch-plan.ts` (~L118). Escenario: un ítem con historia vieja que lo dejó con saldo corrido
negativo al final (justo lo que `inspect:cc53` lista) y un comprobante cuya fecha de despacho es posterior a
todo movimiento. El plan lo acepta como `DISPATCH` (el punto ya era negativo sin la salida, queda exento).
Pero en `InventoryService.record` ese caso tiene `laterCount = 0`, no pasa por D-652 y cae en el chequeo
ordinario de saldo, que rechaza la salida. El plan promete algo que el kardex no cumple, y el rechazo llega a
mitad de la ejecución, no en el plan. Antes de cc54 el plan marcaba `REVIEW` por cualquier negativo (más
estricto). La exención «no retroactivo» tiene sentido para filas con fecha anterior a otras; para el último
punto del kardex debe regir el saldo. Corrección: no eximir el último punto (o pasar al motor un indicador
«sin filas posteriores», igual que `laterCount`), con un test que fije plan = kardex en ese borde.
Confianza media: depende de que el chequeo ordinario rechace con `balance.qty < qty` (lo hace).

### P2-2 — el candado de `recosteo:historico --execute` no tiene ninguna prueba de la parte que escribe

`recost-historic-cli.ts` (`gitSha`, `Mismatch`, comparación dentro de la transacción, `RECHAZADA-*`). Los
specs cubren `previewRejection` y `comparePreviews` (puras), pero nada prueba que (a) una diferencia revierte
de verdad la transacción y no deja ajustes, (b) `--execute` sin vista previa no abre la transacción, ni (c)
`gitSha` marca `+cambios`. Es la única barrera antes de una escritura masiva sobre datos reales y el rollback
se apoya en lanzar una excepción dentro de `$transaction`: correcto por lectura, sin evidencia. Sugerencia:
un db-spec chico (rama local) con vista previa alterada que verifique 0 ajustes tras el rechazo, y extraer
`gitSha` a una función con la ejecución de `git` inyectable.

### P3-1 — `gitSha()` usa `git rev-parse HEAD` sin `cwd` y `git status` con `cwd` de la raíz

`recost-historic-cli.ts` (~L103-110). Si el proceso arranca fuera del repo, las dos llamadas pueden mirar
repos distintos (hoy el wrapper lo lanza dentro, así que funciona). Poner el mismo `cwd` en ambas. Además
`status --porcelain -- apps packages` cuenta archivos sin seguimiento: un archivo suelto en `apps/` bloquea
el `--execute` (falla segura; conviene decirlo en el mensaje).

### P3-2 — `local-data/cc53` cae fuera del repo

`outDir = resolve(__dirname, '../../../../local-data/cc53')` sube cuatro niveles desde `apps/api/prisma`, es
decir, a la carpeta padre del repo, compartida entre worktrees. No lo introduce este diff, pero el candado
nuevo lee la vista previa de esa carpeta: dos worktrees contra la misma rama se pisan (el sha las distingue,
la antigüedad de 2 h no).

### P3-3 — el plan cancela ahora todo par del mismo día, también al calcular `openingDate`

`invoice-dispatch.service.ts` (~L751) y `opening-date-move.service.ts` (~L310): `dropSameDayReversals` corre
antes de detectar la primera entrada `IMPORT`. Si la carga inicial se anuló y se recargó el mismo día, la
anulada ya no aparece (antes solo se quitaban los pares del re-fechado). Es lo coherente con el kardex, pero
cambia qué fecha toma `openingDate` en ese borde y no hay test que lo fije.

### P3-4 — el texto lleva el `reason` libre del usuario

`inventory.service.ts` (`reverse`): la acción incluye el motivo entre comillas angulares y la web lo pinta
tal cual (texto plano, sin riesgo de inyección en React). Con un motivo largo el mensaje se vuelve ilegible;
acotar a unos 60 caracteres.

## Verificado sin hallazgo

- Orden D-652 antes del acuse: `record` y `reverse` calculan `laterMovementCount` y rechazan antes de
  `assertChronological`; el db-spec nuevo fija ambos caminos (rechazo duro vs. diálogo de acuse). Ninguno
  escribe antes de rechazar. `reentry: true` sigue saltando el chequeo.
- `firstNegativeDate`: acumula salidas en su orden, cada una tras las filas de su día; con una sola salida es
  equivalente al `fitsWithoutNegative` anterior (test de equivalencia); `firstValidDate` suma las
  `priorOuts` ya aceptadas por el plan.
- Plan vs kardex con varias salidas: la acumulación `taken` equivale a registrarlas una a una (una salida que
  profundizaría un punto ya negativo por la anterior habría sido rechazada antes).
- `cancelSameDayReversals`: ids `bigint`/`string` por igual, conserva el orden; la anulación de otro día se
  queda. `qtyRowsOf` en una sola consulta (test con conteo de `SELECT`), filtra `recostOfId: null`.
- Mensaje: `backdateNegativeStockMessage` (regex de ceros con `0.000`, `10.500`, `100.000`, `1000.000`
  correcta), mismo texto en API y web; sin `negativeStock` la web cae al `message` anterior.
- `comparePreviews` compara deltas (después menos antes), no valores finales: una venta entre dry-run y
  ejecución no da falsos rojos; `months` ya era un delta. Compara ajustes y residuo. El rechazo por
  antigüedad (2 h), rama, sha y árbol sucio ocurre antes de abrir Nest.
- Centinela de topes: el recorrido sin `this.` y por auxiliares sueltos (cierre transitivo) y su test de
  humo con `undoCoilRestoreBatch`/`executePurchaseReceivedDates` son coherentes.
- Credenciales: ningún argumento ni log nuevo imprime cadenas; `execFileSync` sin shell; no se leyó `.env*`.
- Datos reales: la búsqueda de las cifras del caso de cc52 (74.5763, 79125, 70.7924, 68.9409, 1384.91,
  462.87, 922.04) no encuentra nada fuera de `docs/revision/`; los specs usan muestras y la aritmética de la
  muestra cuadra (36×10+644=1004; 1004/106=9.4717).
- `inspect:cc53` usa el mismo conteo que D-652 (`negativeSpans` sobre `qtyRowsFromMovements`).

## Resumen

| #    | Severidad | Dónde                                         | Resumen                                                                                                     |
| ---- | --------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P2-1 | P2        | `recost-engine.ts` `firstNegativeDate` / plan | el plan acepta una salida que el kardex rechaza si el saldo final ya es negativo y no hay filas posteriores |
| P2-2 | P2        | `recost-historic-cli.ts`                      | el rollback del candado (`Mismatch`) y `gitSha` sin prueba                                                  |
| P3-1 | P3        | `recost-historic-cli.ts`                      | `git` sin `cwd` homogéneo; archivos sin seguimiento bloquean                                                |
| P3-2 | P3        | `recost-historic-cli.ts`                      | `local-data` fuera del repo, compartida entre worktrees                                                     |
| P3-3 | P3        | plan / `openingDate`                          | borde de carga inicial anulada y recargada el mismo día, sin test                                           |
| P3-4 | P3        | `inventory.service.ts` `reverse`              | `reason` libre en el mensaje, sin tope                                                                      |

---

## Qué se hizo con cada hallazgo (sesión cc54, commit siguiente a 7988e008)

- **P2-1, corregido.** `firstNegativeDate` ya no exime el saldo final: si el kardex termina en negativo, una salida no cabe (es el «Stock insuficiente» de `InventoryService.record`). Pruebas nuevas en `recost-engine.spec.ts` («el saldo final nunca queda eximido»).
- **P2-2, corregido.** La decisión del candado sale a funciones puras con pruebas: `executeDifferences` (sin vista previa no se escribe; cualquier diferencia revierte) y `shaWithChanges` (marca los cambios sin commitear). El rollback por `Mismatch` sigue siendo el `throw` dentro del callback de `$transaction`.
- **P3 `gitSha` sin `cwd`, corregido.** Los dos `git` corren en la raíz del repo, cuatro niveles arriba del compilado (`apps/api/dist-cli/prisma/`). La carpeta `local-data/cc53` usa la misma cuenta desde el compilado y cae en la raíz del repo, no en la carpeta padre.
- **P3 motivo sin tope, corregido.** El motivo se corta a 80 caracteres en el mensaje.
- **P3 carga inicial anulada y recargada el mismo día:** se anota, sin cambio. El reingreso del mismo día queda como primera `IMPORT` viva.
