# Revisión de segundo modelo — cc65 corte B (PR #248, rama `cc65b-higiene`)

Revisor: segundo modelo (Sonnet), contexto limpio. Alcance: `git diff origin/main...HEAD` completo (21 archivos). No leí handoffs. Revisión de lectura; no ejecuté las suites.

Resultado: **sin P0 ni P1.** Dos P2/P3 de cobertura y de comportamiento menor, y observaciones. Puede ir a deploy.

## Hallazgos

### R-01 — P2 — Ninguna prueba aserta lo que se escribe en `sessions.ip` (login y rotación del refresh)

- `apps/api/src/auth/auth.service.ts:143` (login) y `:226` (rotación); pruebas en `auth-login-ip.spec.ts:134+` y `auth.service.spec.ts:~310`.
- Las pruebas nuevas cubren solo el `after` de `auth.refresh.reuse`. El cambio de seguridad principal (SEC-05/A2-07: nunca la IP en claro en `sessions.ip`) no tiene aserción sobre `prisma.session.create` ni sobre el `updateMany` de la rotación. Una regresión que vuelva a escribir `req.ip` o la IP en claro pasaría la suite.
- Recomendación: dos casos: login con `clientIp` verificada → `session.create` recibe `data.ip === loginIpKey(SECRET, ip)` y `JSON.stringify(calls)` no contiene la IP; refresh exitoso → `data.ip` es el código (con firma) o `null` (sin firma). Hoy el sentinel de `ClientMeta` ya no tiene `ip`, lo que protege por tipos, pero no por valor.

### R-02 — P3 — La rotación del refresh pone `ip = null` si la petición no trae firma válida

- `auth.service.ts:226`. Antes: `meta.ip ?? session.ip` (conservaba el valor previo). Ahora `ipCodeOf(...)` devuelve `null` y borra el código del login. No rompe sesiones ni refresh (la columna es nullable). Efecto: pérdida de rastro forense cuando un refresh llega sin firma o con firma vencida (>60 s de desfase de reloj).
- A favor: scrubea de paso las IP en claro heredadas de sesiones anteriores en cuanto rotan. Si se prefiere conservar, `?? session.ip` reintroduciría el claro heredado; decisión del dueño. Si se deja así, documentarlo.
- Observación relacionada (sin acción en este PR): las filas existentes de `sessions.ip` con IP en claro de antes del cambio siguen ahí hasta que rote cada sesión (máx. 30 días por el tope) o se purgue; el histórico de `audit_log` es append-only y no se toca.

### R-03 — P3 — `zeroCreditLines` rechaza un 03/13 sobre un comprobante de importe cero que ya tenga cualquier NC

- `credit-note-lines.ts:~333`. La guarda es `algún crédito previo en alguna línea && todas las líneas con total restante <= 0`. En un comprobante cuyas líneas valen 0 (bonificación) y que ya tuvo una NC 03/13 (que crea entrada en `credited` con importes 0), un segundo 03/13 se rechazaría con «No queda nada por acreditar». Caso muy improbable (comprobantes de importe cero) y el comentario ya reconoce la salvedad del primero. Sin cambio requerido; si importa, excluir de `credited.has` las NC de importe cero.
- Verificado sin defecto: NC 03/13 sobre un comprobante con parte pendiente (parcial por cantidad o por importe) sigue entrando; el `credited` del servicio excluye borradores (`status !== DRAFT`), así que un borrador no bloquea; la prueba cubre total acreditado, 03 y 13, y el caso parcial.

### R-04 — P3 — `isoDateSchema` de `sales.ts` (y `compra-detalle-view.tsx:98`) conserva la validación laxa

- `packages/shared/src/schemas/sales.ts:324-327`: `Date.parse(...)` sigue rodando `2026-02-31`. Aplica a `issueDate` de cotizaciones y `promisedDeliveryDate`. Fuera del alcance declarado («fechas de comprobantes»), pero es el mismo defecto que cierra este PR. Recomendación: anotarlo como pendiente (o reutilizar `isCalendarDate`).
- Sin defecto en lo cambiado: `isCalendarDate` exige formato y ida-y-vuelta, así que `2024-02-29` pasa y `2026-02-29`, `2026-13-01`, `2026-04-31` se rechazan. El mensaje de error cambió de «Fecha inválida» a «Esa fecha no existe en el calendario»; no encontré pruebas ni e2e que aserten el texto viejo para esos campos. El `.refine(isCalendarDate…)` de `dueDate` (`invoicing.ts:1686`) quedó redundante, inocuo.

### R-05 — P3 — `expandIpv6` con identificador de zona

- `client-ip.ts:92`. `isIP('fe80::1%eth0')` es 6 en Node y `verifyClientIp` acepta lo que `isIP` acepte; con zona, el último grupo `1%eth0` se parsea con `parseInt` (queda 1) y una IPv4 final con zona no coincide con el regex de IPv4 al final. Solo afecta la agrupación de rate limit de una IP firmada por la web (que usa `x-real-ip` de Vercel, sin zona). Sin impacto práctico; un `ip.split('%')[0]` lo cierra.
- Verificado: `::ffff:102:304`, `::FFFF:1.2.3.4`, forma sin comprimir y con ceros dan `1.2.3.4`; `::1` conserva su cubeta `0:0:0:0::/64` (misma clave que antes, no hay cambio de claves para el resto de IPv6: `toString(16)` equivale al recorte de ceros previo); `::` y `1::` expanden bien; `2800:200::1.2.3.4` va por su /64. Las claves de la cubeta viven en memoria y en `audit_log` como hash: el cambio solo altera la clave de IPv4 mapeadas en hexadecimal (antes caían al /64 de ceros).

## Verificado sin hallazgos

- **Tope de sesión en el access token** (`auth.service.ts:311`): usa el mismo `sessionCap(createdAt)` que el refresh, así que no hay desfase entre ambos; `include: { user: true }` ya trae `createdAt`. Un 401 «Sesión expirada» lleva al cliente web a intentar `/api/auth/refresh`, que a su vez responde 401 por tope y manda al login: sin bucle. Las sesiones anteriores al 19/10 cuentan desde `SESSION_CAP_FROM`; no se cierran en bloque. La prueba cubre el borde (`-1 s` sirve, `+1 s` expira) con reloj falso que no interfiere con los timers.
- **Fuga de IP en claro:** `ClientMeta.ip` desapareció; el controlador ya no pasa `req.ip` en login ni refresh; el refresh ahora sí verifica la firma (la web firma todas las peticiones del proxy `api/[...path]`). `loginIpKey` mide 43 caracteres y cabe en `VarChar(64)`. Sin secreto configurado no se guarda nada.
- **Clientes nuevos en `carga:revisar`:** una sola entrada por RUC/DNI con todas sus filas, nombre vacío tratado; el bloque va antes de «Orden de carga». Solo cuenta la primera línea de cada comprobante (`!sales.has(doc)`), que es correcto. El nombre del export entra sin escapar en Markdown (informe local, sin riesgo).
- **Comentarios/docs:** el voseo cambiado a tuteo alcanza un mensaje de error visible (`inventory.service.ts:530, 738`); ninguna prueba busca el texto viejo en el repo (grep de `reintentá|registrá` limpio en `apps`/`packages`, salvo lo ya tuteado). `AGENTS.md` regla 8 nombra `recostEntries()`, que existe (`inventory.service.ts:831`); el texto del centinela se alinea con eso. `purchases.service.ts` usa `toDateOnly` (equivalente exacto al `new Date(...T00:00:00.000Z)` anterior).

## Respuesta del autor

- **R-01 (corregido):** pruebas de lo que se escribe en `sessions.ip` al entrar (`session.create`) y al renovar (con
  firma, sin firma con código anterior, sin firma con IP en claro heredada).
- **R-02:** la renovación sin firma ya no deja `null` sobre un código válido: lo conserva; solo borra la IP en claro.
- **R-03 (corregido):** las líneas de importe cero no cuentan para NC-03.
- **R-04:** fechas de cotizaciones y pedidos, fuera del alcance; anotado en el handoff.
- **R-05:** sin cambios (la IP llega de `x-real-ip`, sin zona).
