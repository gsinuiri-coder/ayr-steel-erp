# cc58 corte D: revisión del segundo modelo

Alcance: `git diff cc58-c..cc58-d` (5 commits). Verificado: `tsc --noEmit` de `apps/api` limpio; jest de auth, throttler, kardex-snapshot, purchase-received-date-fix y kardex-writers.sentinel, 97 pruebas verdes. No se corrieron db-specs.

**Nota de método (importante para el merge).** `cc58-c` ya integró `main` y `cc58-d` nace de `830ac137`. El diff literal `cc58-c..cc58-d` muestra como "revertidos" cambios que no son del corte (roles de NC en `invoicing.service.ts`, `credit-note-dialog.tsx`, `ventas-margen-view.tsx`, formato de `roofing-drafts.service.ts`, revisiones de cc58-a). Contra la base real (`830ac137..cc58-d`) no aparecen. Antes de abrir el PR, `cc58-d` debe integrar `cc58-c`/`main`; no aplicar el diff literal.

Resultado: sin P0 ni P1. Tres P2 (uno de diseño, dos de concurrencia), el resto P3.

## 1. D-689 (retiro de la herramienta de fecha D-285)

Correcto. El trigger ya es estricto: `20260925120000_kardex_append_only_estricto` restaura `inventory_movements_immutable` sin la variable `ayr.opening_date_move`, y ninguna migración posterior lo redefine. Un grep de `OpeningDateMove|addMissingMovement|movedOpening|opening-date` no deja usos vivos en `apps`, `scripts`, `e2e` ni `packages`. El `openingDate` que sigue en `invoice-dispatch-plan.ts` y `dispatch-at-issue-date-cli.ts` es otro concepto (primera entrada IMPORT del ítem). Sentinelas y AGENTS.md regla 8 coherentes.

- **P3-1** `.claude/settings.json:105-106` conserva `Bash(node *scripts/opening-date.mjs*)` y `Bash(pnpm *inventory:opening-date*)`: permisos de un script que ya no existe. Quitarlos (configuración, no la toca el revisor).
- **P3-2** `docs/ARQUITECTURA.md` y `docs/PROGRESO.md` siguen citando el comando `inventory:opening-date`; confirmar que D-689 lo marca retirado. Los handoffs y revisiones históricas no se tocan.

## 2. D-688 (segunda cubeta `loginIp`)

Verificado en `@nestjs/throttler@6.5.0` (`dist/throttler.guard.js` líneas 72 y 85): `namedThrottler.skipIf || commonOptions.skipIf` y `route getTracker || namedThrottler.getTracker || common.getTracker`. Por tanto el `skipIf` y el `getTracker` de `loginIp` sustituyen al global y al del guard, mientras `default` conserva los suyos y el `THROTTLE_DISABLED` global. Los `@Throttle({ default })` de los controladores no afectan a `loginIp`. Fuera de `/auth/login` el `skipIf` devuelve true: las demás rutas no cambian. Con `THROTTLE_DISABLED` ambas cubetas se saltan (E2E).

- **P2-1** `apps/api/src/common/throttler.guard.ts` (`loginIpThrottler`). Con `trust proxy = 1` (`main.ts:16`) y el login pasando por el proxy del web, `req.ip` es la IP de salida compartida de Vercel: la cubeta de 30/min es **global para todos los usuarios del web**. Escenario: alguien golpea el login del web con correos aleatorios (30 por minuto, trivial) y deja a todos sin poder entrar con 429; antes solo podía bloquear una cuenta (10/min por correo). El comentario lo llama "holgado", pero es un riesgo de denegación, no una defensa contra ese atacante. Opciones: (a) aceptarlo y escribirlo en D-688; (b) que el proxy reenvíe la IP del cliente con un secreto compartido y la API la use solo si viene con él; (c) contar solo intentos fallidos. Es decisión del dueño (regla 16).
- **P3-3** La cubeta cuenta también los logins exitosos. Irrelevante con 30/min; a tener en cuenta si se baja el límite.
- **P3-4** `throttler-login-ip.spec.ts` prueba la función, no que el guard la aplique. Un test con módulo Nest + supertest contra `/auth/login` blindaría la precedencia ante una actualización de `@nestjs/throttler`.

## 3. D-687 (reuso de refresh y tope de 30 días)

La lógica es correcta: `reused` solo si el hash coincide con el anterior y `rotatedAt` es nulo o vencido; el token actual nunca es reuso; sesión ya revocada o expirada da 401 sin auditar; el tope recorta `expiresAt` y la cookie (`setAuthCookies` usa `refreshExpiresAt`), así que cookie y base coinciden. El web solo refresca desde el cliente (`tryRefresh` y `plant-sheet-buttons`), no en servidor, y el `catch` del controlador limpia cookies ante cualquier 401, también el de reuso; el cliente trata el 401 del refresh como sesión terminada.

- **P2-2** `apps/api/src/auth/auth.service.ts:147-160` (`refresh`). La rotación no es atómica: `findFirst` y luego `update` sin condición sobre `refreshTokenHash`. Escenario: dos pestañas (cada una tiene su propio `refreshInFlight`) refrescan a la vez con A. Ambas leen A; la primera deja actual=B1, anterior=A; la segunda sobreescribe actual=B2, anterior=A. Si el navegador se queda con la cookie B1, la siguiente renovación no coincide con nada y devuelve 401: el usuario sale. Ya ocurría antes, pero ahora se confunde con un reuso real. Arreglo: `updateMany({ where: { id, refreshTokenHash: session.refreshTokenHash } })`; si `count === 0`, releer y tratar como dentro de gracia.
- **P2-3** Falso positivo de reuso. Si la respuesta del refresh se pierde (corte de red, pestaña cerrada tras rotar), el navegador conserva A; pasados 30 s la siguiente renovación cuenta como reuso y **revoca la sesión entera**, con un `auth.refresh.reuse` que parece robo. Es el costo inherente a la detección. Dejarlo escrito en D-687 y que el texto de la auditoría diga "posible reuso".
- **P3-5** Al desplegar, toda sesión con `createdAt` de más de 30 días (usuarios activos con renovación deslizante de 7 días) recibe 401 en su próxima renovación, todos a la vez. Aceptable; avisar o desplegar en horario de poco uso.
- **P3-6** `auth.service.ts` rama `reused`: si `audit.log` fallara después del `updateMany`, el cliente recibe 500 en vez de 401 (la sesión sí queda revocada). Menor.

## 4. D-690 (`deferRecost` en la corrección de fechas D-374)

Semántica de semillas correcta: en `planRecost`, `enqueue` conserva el punto de inicio más temprano por ítem, así que las semillas `[después del reingreso, después de la reversa]` arrancan desde la fila siguiente al reingreso; el reingreso (FIXED) no cambia y la reversa (REVERSAL) toma el costo ya corregido de su fuente. Un solo plan reemplaza dos recosteos cuyos ajustes se anulaban. D-652 sigue aplicando: `record()` evalúa el chequeo antes de escribir y `reverse()` conserva sus comprobaciones; el flag solo omite la llamada final a `recostForward` (`inventory.service.ts` líneas ~407 y ~1024). Sin filas posteriores, `recostOnce` hace un replay sin ajustes ni escrituras.

- **P3-7** `RecordMovementInput.deferRecost` y `reverse(..., { deferRecost })` son opciones públicas que omiten el recosteo y nada obliga al llamador a recostear después. Hoy solo las usa `purchase-received-date-fix.ts` (4 usos, todos seguidos de `recostOnce`). Propuesta: un centinela que falle si `deferRecost: true` aparece en un archivo sin `recostForward`, y una línea en la regla 8 de AGENTS.md junto a `replaceEntry`.
- **P3-8** `undoPurchaseReceivedDates` ahora lanza "La línea no genera kardex" si `record` devuelve `null` (línea NOOP); antes seguía hacia la reversa. Coherente con `execute`; el lote original ya habría rechazado esas líneas.

## 5. D-691 (foto del kardex en `record()`)

La foto es perezosa y **todas** sus lecturas (`kardex()`) ocurren después de `lockBalance` (D-474) y antes de cualquier escritura de la operación (inserción del movimiento y `writeBalance` van después); no se reutiliza tras escribir: `recostForward` vuelve a leer con `planRecost`. `qtyRowsOfSnapshot` equivale a `qtyRowsOf`: `foldRecosts` descarta las filas con `recostOfId` (igual que el `recostOfId: null` de la consulta), el orden de `loadItem` es el mismo `(operationDate, at, id)`, y ambas pasan por `qtyRowsFromMovements` (cancelación de reversas del mismo día) con la misma fecha `toISOString().slice(0, 10)` y cantidad `Decimal`. `kardex-snapshot.spec.ts` lo prueba con un recosteo en medio.

- **P3-9** `loadItem` además consulta `salesReturnItem` cuando hay devoluciones, cosa que `qtyRowsOf` no hacía: una consulta más solo en ítems con devoluciones y salida retrofechada. No cambia resultados; si hay un presupuesto de consultas para `record` con `laterCount > 0`, medirlo.

## Resumen

| Prioridad | Hallazgo                                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 y P1   | ninguno                                                                                                                                                                                   |
| P2        | P2-1 cubeta por IP compartida de Vercel permite bloquear el login de todos; P2-2 rotación de refresh no atómica con dos pestañas; P2-3 falso positivo de reuso si se pierde la respuesta  |
| P3        | permisos huérfanos en `.claude/settings.json`, docs que citan `inventory:opening-date`, test de integración del guard, aviso de re-login por el tope, centinela de `deferRecost`, menores |

## Respuesta del autor (cc58)

- **Diff mezclado con `main`:** cc58-d integra `main` antes del PR. El corte real es `cc58-c...cc58-d`.
- **P2-1 (la cubeta por IP es una sola detrás de Vercel): decisión del dueño, se posterga.** Se
  revierte la cubeta por IP (D-688 queda pendiente). Hacerla bien exige que la web reenvíe la IP del
  cliente firmada con un secreto compartido, que es una variable nueva en Vercel y en Cloud Run. Queda
  el límite por correo.
- **P2-2 (rotación sin condición): corregido.** `updateMany` exige el token vigente leído. Si otra
  pestaña rotó en el medio, reintenta una vez desde el vigente, dentro de la gracia. Prueba en
  `auth.service.spec.ts`.
- **P2-3 (respuesta perdida → reuso):** aceptado. Es el costo de detectar el reuso y queda escrito en
  D-687.
- **P3 (deslogueo masivo al desplegar): corregido.** Las sesiones abiertas antes del 19/10 cuentan sus
  30 días desde esa fecha (`sessionCap`).
- **P3 (`deferRecost` público): corregido.** El centinela `defer-recost.sentinel.spec.ts` lo permite
  solo en la corrección de fechas de D-374.
- **P3 (restos de la herramienta D-285):** `.claude/settings.json` lo cambia el dueño. Las citas en
  ARQUITECTURA y PROGRESO son historia y se anota que se retiró.
