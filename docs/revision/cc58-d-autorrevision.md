# cc58, corte D: autorrevisión

> **Esto es una AUTORREVISIÓN** (AGENTS.md §2, punto 2.1). La hizo un subagente nuevo que no leyó
> el handoff de implementación. Es una **lista de riesgos y no una aprobación**, y no vale como pase
> cruzado.

**Alcance.** `git diff cc58-c...cc58-d`: 5 commits y 26 archivos (51766d39, 5874123d, 033f7dae,
30b11a8e, 43b3c815). Las piezas son el retiro de la herramienta de D-285, la cubeta por IP del login
(D-688), la renovación segura con tope de 30 días (D-687), el recosteo único de D-374 (D-690) y la
foto del kardex en `record()` (D-691).

**Corrida.** Pasaron en verde 6 suites y 48 pruebas unitarias (`auth.service.spec`,
`throttler-login-ip.spec`, `kardex-snapshot.spec`, `purchase-received-date-fix.spec`,
`kardex-writers.sentinel.spec` y `transaction-options.sentinel.spec`). No se corrieron db-spec, por
instrucción del encargo.

---

## P0

Ninguno.

## P1

Ninguno.

## P2

### P2-1. La cubeta por IP del login es una sola para toda la empresa y un tercero la puede agotar

- `apps/api/src/common/throttler.guard.ts:43-52`, `apps/api/src/main.ts:16` (`trust proxy 1`) y
  `apps/web/src/app/api/[...path]/route.ts:30`.
- Detrás del proxy de Vercel, `req.ip` (con `trust proxy 1`) es la **IP de salida de la función de
  Vercel**, no la del usuario. Cloud Run agrega esa IP al final de `X-Forwarded-For`. Por eso todos
  los logins de la oficina caen en la misma cubeta `ip|<egress>`, y también los de **cualquier
  persona de internet** que pegue a `https://v2.mareliac.pe/api/auth/login`.
- Escenario: alguien manda 30 logins fallidos por minuto, con correos al azar, contra el dominio
  público. Mientras lo haga, **nadie de la empresa puede iniciar sesión** (429, «Demasiados intentos
  seguidos»). Antes de este corte, ese mismo atacante solo podía bloquear un correo concreto (10 por
  minuto en la cubeta del correo). Ahora puede bloquear a todos sin conocer ningún correo.
- Lo agrava el P2-2: el día del despliegue, todas las sesiones de más de 30 días piden contraseña a
  la vez.
- Al revés también falla: Vercel no garantiza una IP de salida fija. Si rota entre invocaciones, la
  cubeta del proxy se reparte y frena menos de lo que dice D-688. Solo frena de verdad a quien ataca
  la URL directa de Cloud Run.
- Recomendación, que decide el dueño:
  - **(a)** Limitar la cubeta por IP a lo que no llega por el proxy. Habría que distinguirlo, por
    ejemplo con una cabecera secreta que agregue el route handler.
  - **(b)** Que el proxy reenvíe la IP del cliente, que es la que Vercel pone en `x-forwarded-for`
    o en `x-vercel-forwarded-for`, en una cabecera firmada que la API crea solo con ese secreto.
  - **(c)** Aceptar el riesgo y anotarlo en D-688.
- Hoy no hay prueba que cubra el camino por el proxy.

### P2-2. Con el tope de 30 días, todos se desloguean juntos el día del despliegue

- `apps/api/src/auth/auth.service.ts:136-141`.
- El tope se cuenta desde `session.createdAt`. La renovación deslizante de 7 días mantiene viva la
  misma fila de sesión desde el login. Producción tiene usuarios reales desde el 2026-09-07 (42 días
  al 2026-10-19), así que toda sesión abierta antes del 2026-09-19 ya pasó el tope.
- Escenario: después del `deploy:api`, cada usuario que lleve la sesión abierta desde antes del 19/09
  recibe un 401 en su próxima renovación, es decir, en los 15 minutos siguientes, en plena jornada.
  - El controlador limpia las cookies (`auth.controller.ts`, `catch` de `refresh`).
  - `api()` no logra renovar y devuelve el 401.
  - `SessionProvider` lo manda a `/login?expired=1`.
- Si el usuario estaba a mitad de un formulario, lo pierde. El texto «La sesión llegó a su máximo de
  30 días» no se ve: el web solo mira el estado HTTP.
- Recomendación:
  - Avisar al dueño antes del despliegue, o desplegar fuera de horario aunque la ventana esté
    suspendida.
  - O contar el tope desde `max(createdAt, fecha del despliegue)` para las sesiones que ya existen.
  - Decidirlo y anotarlo en D-687.

### P2-3. La renovación sigue sin comparar antes de escribir, y ahora una carrera benigna se registra como «reuso»

- `apps/api/src/auth/auth.service.ts:112-160`.
- `findFirst` y después `update({ where: { id } })` corren sin condición sobre `refreshTokenHash`.
- Escenario 1, que ya existía: dos pestañas vuelven de una suspensión y renuevan a la vez con T0.
  `tryRefresh` comparte la petición en vuelo solo dentro de una pestaña. Las dos leen T0 como token
  vigente y las dos rotan. La base queda con el último que escribe (T2, y T0 como anterior). El
  navegador se queda con el `Set-Cookie` que procese último. Si es T1, ese token no figura en ninguna
  columna, y en la próxima renovación (unos 15 minutos después) el usuario sale. No es regresión del
  corte, pero el comentario de D-687 promete tolerar «dos pestañas a la vez» y eso solo vale para
  renovaciones **en serie** dentro de los 30 s de gracia.
- Escenario 2, que es nuevo:
  1. La pestaña A rota T0→T1.
  2. La pestaña B, dentro de la gracia, presenta T0. Pasa como token anterior y rota otra vez: la
     base queda con T2 vigente y T1 como anterior.
  3. Si el `Set-Cookie` de A llega después que el de B, la cookie queda en T1.
  4. Pasados 30 s, la siguiente renovación con T1 se toma como **reuso**: se revoca la sesión y se
     escribe `auth.refresh.reuse`.
- Para el usuario el resultado es el mismo que antes (antes daba 401 por no encontrar el token). Pero
  la auditoría registra un «robo de token» que no lo es. Si alguien vigila esa acción, verá falsos
  positivos.
- Recomendación: un `updateMany` con `where: { id, refreshTokenHash: session.refreshTokenHash }`. Si
  devuelve `count = 0`, otra renovación ganó: se vuelve a leer y se trata como presentación dentro de
  la gracia. Así ninguna rotación pisa otra.

## P3

### P3-1. `deferRecost` es una salida pública del recosteo sin centinela

- `apps/api/src/inventory/inventory.service.ts:181`, `:407`, `:884` y `:1024`.
- Cualquier llamador nuevo puede pasar `deferRecost: true` y dejar un movimiento atrasado sin
  recostear, sin que nada falle. Hoy solo lo usa `purchases/purchase-received-date-fix.ts` (líneas
  293, 304, 471 y 482), siempre seguido de `recostOnce`.
- Recomendación: sumar un centinela, como los de bloqueos o los de escritores del kardex, que liste
  los llamadores permitidos de `deferRecost`.

### P3-2. Si el recosteo pasa de 500 movimientos, `recostOnce` no lo avisa

- `apps/api/src/purchases/purchase-received-date-fix.ts:344-360`.
- Si el plan pasa `RECOST_MAX_ROWS`, `recostForward` deja `inventory.recost-pending` en la auditoría
  y devuelve `pending: true`. `recostOnce` lo ignora. Es el mismo comportamiento que tenía el recosteo
  interno de `record()`, así que no es regresión. Pero la herramienta de D-374 trabaja en lote y no
  le muestra al operador que quedó un recosteo pendiente para `pnpm recosteo:historico`.

### P3-3. La foto del kardex: no se ve que quede vieja

Lo que se comprobó:

- En `inventory.service.ts:268-273`, la foto se toma de forma perezosa **después** de `lockBalance`
  (línea 264) y de `laterMovementCount`. Entre la foto y `createMovement` no se escribe nada del
  ítem: `writeBalance` toca el saldo, no `inventory_movements`.
- Cada llamada a `record()` arma su propia foto, en un closure local. Dos `record()` del mismo ítem
  en la misma transacción (el reingreso de D-374 y otros) no comparten foto.
- `qtyRowsOfSnapshot` equivale a `qtyRowsOf`. `foldRecosts` descarta las filas con `recostOfId`,
  igual que el filtro `recostOfId: null`. El orden es el mismo y `cancelSameDayReversals` recibe la
  misma entrada, así que el caso de D-652 con una anulación del mismo día se mantiene.
- Las reservas (D-066) y la materia prima (D-134) no leen la foto: siguen leyendo la base después
  de `writeBalance`.

Riesgo residual: la foto guarda una promesa rechazada. Si `loadKardex` falla, la transacción ya
abortó, así que no tiene efecto. Si un cambio futuro escribe movimientos del ítem antes de usar la
foto, quedaría vieja sin que nada avise. Convendría un comentario o una aserción en `kardex()`.

### P3-4. Quedan referencias a la herramienta retirada

- `.claude/settings.json:105-106`: siguen en `allow` las entradas `Bash(node *scripts/opening-date.mjs*)`
  y `Bash(pnpm *inventory:opening-date*)`, de un script y un comando que ya no existen. Son inofensivas,
  pero conviene limpiarlas. Ese archivo es configuración del agente y lo cambia el dueño.
- `docs/analisis/cc30-matriz-bloqueos.md:137`: la fila F6 todavía describe `opening-date-move.service.ts`
  como un camino vivo.
- `apps/api/src/inventory/kardex-append-only.sentinel.spec.ts:9`: el comentario nombra
  `ayr.opening_date_move`. Es correcto como historia y no requiere cambio.
- Las migraciones `20260925010000_*` y `20260925120000_*` siguen nombrándola. Es lo esperado: son
  historia y no se tocan.
- No quedan llamadores de `addMissingMovementInTx`, `movedOpening` ni `OpeningDateMoveService` en
  `apps`, `packages`, `scripts` ni `e2e`.

### P3-5. D-687 a D-691 todavía no están en `docs/ARQUITECTURA.md` §0.2

El código cita D-687, D-688, D-689, D-690 y D-691, pero no hay ninguna fila con esos números en
§0.2. Va en el cierre (`ayr-cierre`).

### P3-6. El diff del encargo (dos puntos) mezcla cosas de `main`

`git diff cc58-c..cc58-d` muestra 34 archivos, entre ellos `credit-note-dialog.tsx`,
`ventas-margen-view.tsx`, la supuesta eliminación de `docs/revision/cc58-a-*` y `roofing-drafts.service.ts`.
No son de este corte: `cc58-c` tiene mergeado `origin/main` (7f9b2c23) y `cc58-d` sale de 830ac137,
que es anterior a ese merge.

El diff propio del corte es el de tres puntos: 26 archivos. Antes del PR hay que mergear
`origin/main` en `cc58-d` para no revertir lo de cc58-a y cc58-b. El hunk de `roofing-drafts.service.ts`
que se ve con dos puntos es solo formato de Prettier del lado de `main`.

### P3-7. El orden de los chequeos en `refresh` cambia el caso del usuario desactivado

- `apps/api/src/auth/auth.service.ts:136-145`.
- Un usuario desactivado cuya sesión ya pasó el tope recibe 401 en lugar de 403, y no se llama a
  `revokeAllSessions`. Las otras sesiones de ese usuario quedan abiertas hasta su propia renovación,
  donde sí se revocan.
- Es menor, pero RF-03 pide revocar al desactivar. La desactivación ya llama a `revokeAllSessions`
  desde el servicio de usuarios, así que queda en P3.

### P3-8. Contexto que ya existía, sobre los 429 de toda la empresa

- La cubeta `default` (120 por minuto) y la de `/auth/refresh` (30 por minuto, `auth.controller.ts`,
  `@Throttle` de `refresh`) también se cuentan por `req.ip`, que es la IP de Vercel. Es decir, son
  **compartidas por toda la oficina**.
- Un 429 en `/auth/refresh` hace que `tryRefresh()` devuelva `false`, y `api()` muestra el 401
  original. Si eso le pasa a `/auth/me`, el usuario sale a `/login?expired=1`.
- No es de este corte, pero entra en «deslogueos inesperados». Con el despliegue de D-687, que
  desloguea a todos juntos (P2-2), es más probable juntar ráfagas.

---

## Lo que se revisó y no dio hallazgo

- **Cómo renueva el web.** No hay renovación del lado del servidor: ningún `cookies()` ni
  `next/headers` lee las cookies de sesión en `apps/web/src`. El middleware solo mira si la cookie
  existe. La renovación vive solo en `apps/web/src/lib/api.ts:94-145`: un intento ante un 401,
  compartido dentro de la pestaña. El proxy reenvía cada `Set-Cookie` por separado.
- **Logins de `smoke:prod` y del E2E.** `scripts/smoke-prod.mjs:197` hace un solo login por
  corrida, así que no se acerca a los 30. El E2E y CI corren con `THROTTLE_DISABLED=true`
  (`playwright.config.ts:118` y `ci.yml`), y `loginIpThrottler(true)` también se salta. Las pruebas
  de `e2e/tests/auth.spec.ts` (logout y después refresh con 401) no dependen de la gracia ni del tope.
- **Conteo de la librería.** En `@nestjs/throttler` 6.5.0, la cubeta `loginIp` usa su propio
  `getTracker` y su propio `skipIf`. La cubeta `default` sigue con `getTracker` del guard (el correo
  en el login) y con el `skipIf` común. El `@Throttle({ default })` del login no toca `loginIp`.
- **D-690.** `planRecost` toma la semilla más temprana por ítem cuando recibe dos semillas del mismo
  ítem. El ítem ya está bloqueado por `lockInOrder`. Que la reversa con `deferRecost` siga aplicando
  D-652 es lo que dice el comentario.

## Respuesta del autor (cc58)

- **P2-1:** la cubeta por IP se posterga por decisión del dueño (ver la respuesta al segundo modelo).
- **P2-2 (deslogueo masivo): corregido.** Las sesiones abiertas antes del tope cuentan sus 30 días
  desde el 19/10.
- **P2-3 (rotación sin comparar): corregido**, con un reintento.
- **P3-1:** corregido con el centinela de `deferRecost`.
- **P3-2:** `recostOnce` deja «recosteo pendiente» en la auditoría, igual que todo recosteo en línea
  que pasa del tope (D-650). Se anota.
- **P3-4, P3-5, P3-6:** las referencias y D-687..D-691 van en el PR de docs; cc58-d integra `main`.
- **P3-7: corregido.** El usuario desactivado se mira antes que el tope.
- **P3-8:** la cubeta general y la de `/auth/refresh` también son compartidas detrás de Vercel. Ya
  pasaba antes y entra en la misma postergación.
