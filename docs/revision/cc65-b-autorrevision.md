# cc65, corte B — autorrevisión

> **Autorrevisión** (AGENTS.md §2, regla 2.1): la hizo un subagente nuevo que no leyó el handoff de
> implementación. Es una **lista de riesgos, no una aprobación**, y no vale como pase cruzado.

Alcance: `git diff origin/main...HEAD` de la rama `cc65b-higiene` (PR #248), 21 archivos. Se leyó
el código y se buscó quién lee lo que cambió; no se corrió ninguna prueba.

## Resumen

Sin P0 ni P1. Dos P2 de comportamiento (se pierde el código de IP en la rotación sin firma, y NC-03
con líneas de importe cero) y varios P3 (validación de fechas duplicada o incompleta, datos viejos
en claro, pruebas que faltan).

## Preguntas del encargo

- **¿Alguien lee `sessions.ip`?** No. En `apps/api/src` y `apps/web/src` nadie lee la columna: la
  referencia de auditoría de `sessions` (`apps/api/src/audit/audit-entity-refs.ts:217`) solo lee
  `id` y `user.name`; el límite por IP (`throttler.guard.ts:53`, `loginIpKeyOf`) cuenta por
  `audit_log` y por la cabecera firmada, no por `sessions.ip`. El código de `loginIpKey` mide 43
  caracteres (base64url de SHA-256) y cabe en `VarChar(64)` (`schema.prisma:508`). No se rompe
  ninguna pantalla.
- **¿El refresh rechaza algo nuevo?** No. `verifyClientIp` es pura y no lanza; `ipCodeOf` solo
  decide qué se guarda. El navegador refresca por `/api/auth/refresh`, que pasa por el proxy
  `apps/web/src/app/api/[...path]/route.ts:33`, y ese proxy firma la IP: en producción el refresh
  normal sí trae firma.
- **¿La normalización IPv6 cambia claves ya contadas?** Solo en formas raras. En una IPv6 normal el
  /64 sale igual que antes: `parseInt(g,16).toString(16)` equivale a quitar los ceros iniciales.
  La IPv4 en decimal (`::ffff:a.b.c.d`) también da lo mismo. Cambian la IPv4 mapeada en hexadecimal
  o sin comprimir (`::ffff:102:304`, `0:0:0:0:0:ffff:…`), que antes caía en `0:0:0:0::/64` y ahora
  es la IPv4. El proxy de Vercel casi nunca manda esas formas, y el conteo vive en una ventana: al
  desplegar, el peor caso es que un contador se reinicie una vez. Sin riesgo real.
- **¿NC-03 bloquea casos válidos?** Casi nunca; ver P2-2. Una NC 13 después de una NC 01 parcial
  sigue entrando, porque a la línea le queda importe. Después de una NC 07 de devolución total, o
  de una NC 04 por el total, se rechaza, que es lo que se busca. Una NC 03 o 13 anterior suma
  importe cero y no dispara el rechazo sola.
- **¿`isCalendarDate` rompe una fecha que antes entraba válida?** No. El regex ya exigía
  `YYYY-MM-DD` sin zona, y `toDateOnly` arma la misma fecha `T00:00:00.000Z` que antes usaba
  `Date.parse`. Ahora se rechazan las que el calendario no tiene (`02-31`, `02-29` de un año no
  bisiesto) y las que no tienen sentido (`13-01`). Ninguna de esas era válida.

## Hallazgos

### P2-1 — En la rotación, un refresh sin firma borra el código de IP guardado

`apps/api/src/auth/auth.service.ts:226` — antes decía `ip: meta.ip?.slice(0, 64) ?? session.ip` y
ahora dice `ip: this.ipCodeOf(meta.clientIp)`. Escenario: el refresh llega sin firma válida (la
cabecera llegó después de los 60 s de `CLIENT_IP_MAX_AGE_MS`, falta el secreto en la web durante
una rotación de `AYR_CLIENT_IP_SECRET`, o algún refresh no pasa por el proxy). Entonces
`sessions.ip` pasa de su código a `null` y se pierde el único dato de dónde se abrió la sesión. No
rompe nada, porque nadie lo lee, pero resta valor al dato.
**Recomendación:** `ip: this.ipCodeOf(meta.clientIp) ?? session.ip`, como antes, con una prueba.
Si lo que se busca es «la IP del último uso», dejarlo como está y escribirlo en el comentario.

### P2-2 — NC-03 rechaza la NC 03 o 13 cuando lo que queda son líneas de importe cero

`apps/api/src/invoicing/credit-note-lines.ts:333-337`. La condición es: «alguna línea tiene
crédito» **y** «ninguna línea tiene importe pendiente mayor que 0». Escenario: un comprobante con
la línea A acreditada por completo (NC 01 o 07) y la línea B de total 0 (una línea gratuita o
traída de un documento con importe cero). Ahí `nothingLeft` es verdadero y se rechaza una NC 03
que solo quiere corregir la descripción de B. Lo mismo pasa con un comprobante cuyas líneas son
todas de importe cero y ya tienen una NC 03 o 13 viva: `creditsByLine` las registra con importe 0,
así que `credited.has` da verdadero y la segunda NC 03 se rechaza, aunque el propio comentario dice
que un comprobante de importe cero no está «acreditado por completo». En los schemas de
comprobante manual el precio es positivo (`invoicing.ts:232`, `positive: true`), así que hoy parece
difícil de alcanzar. Queda como borde.
**Recomendación:** decidir el criterio por línea: una línea con `totalPen = 0` no cuenta como
«acreditada por completo». O medir por cantidad pendiente (`remaining.qty > 0`) además del
importe. Sumar la prueba del borde.

### P3-1 — Quedan fechas validadas con `Date.parse`

`packages/shared/src/schemas/sales.ts:327` todavía usa
`refine(!isNaN(Date.parse(...)), 'Fecha inválida')`, así que en ese `isoDateSchema` de ventas
(cotizaciones y pedidos) `2026-02-31` sigue entrando y rueda al 3 de marzo. El comentario de cc65
dice «en todos los campos de fecha de comprobantes». Si el alcance era solo comprobantes, está
bien, pero conviene decirlo para que nadie lo dé por cerrado en todo el sistema.
**Recomendación:** anotarlo como pendiente o aplicar `isCalendarDate` también ahí, en otra pieza.

### P3-2 — Refinamiento duplicado en el vencimiento

`packages/shared/src/schemas/invoicing.ts:1686` hace
`dueDate: isoDateSchema.refine(isCalendarDate, …)`, y ahora `isoDateSchema` ya trae ese
refinamiento. Zod 3 no corta en el primer `refine`, así que con `2026-02-31` salen dos issues con
el mismo mensaje y la web puede mostrarlo dos veces.
**Recomendación:** quitar el `.refine` de la línea 1686.

### P3-3 — Datos viejos en claro

Las filas de `sessions.ip` anteriores al despliegue y los `audit_log` de `auth.refresh.reuse` ya
escritos conservan `req.ip`. Según el propio comentario es la IP de salida de Vercel y no la del
cliente, así que el riesgo es bajo. `audit_log` es append-only y no se toca. Si el hallazgo pedía
que no quedara ninguna IP en claro, `sessions.ip` vieja se puede poner en `null` con una escritura
masiva (`--confirm-production`, con OK del dueño), o se deja dicho que no se limpia.

### P3-4 — Pruebas que faltan

- Ninguna prueba cubre que la rotación (`refresh` que sale bien) guarde el código con firma, ni
  qué pasa sin firma (P2-1).
- Ninguna prueba del controlador comprueba que `refresh` ahora llama a `verifyClientIp`; si se
  vuelve a pasar `req.ip`, nada falla.
- Falta el borde de la línea de importe cero en NC-03 (P2-2).
- Las pruebas que están son útiles: el tope de 30 días con un segundo de margen a cada lado, las
  cuatro escrituras de la IPv4 mapeada, `::1` separado de la IPv4 mapeada, NC-03 total contra
  parcial, fechas imposibles en emisión, cobro y despacho, y `newCustomers` agrupado por documento.

### P3-5 — Menores

- SEC-02: la sesión que pasa el tope sale con un 401 «Sesión expirada»; después el refresh
  responde con el mensaje de los 30 días y la web lleva al login. Las sesiones anteriores a
  `SESSION_CAP_FROM` vencen desde esa fecha más 30 días (`sessionCap`), así que el despliegue no
  cierra sesiones en masa. Sin acción.
- El centinela del kardex (`kardex-writers.sentinel.spec.ts:56`) solo cambió el texto `what`;
  `mustMatch` sigue en `replaceEntry`. Está bien, pero no comprueba que `recostEntries` exista.
- `carga:revisar`: si un cliente nuevo trae nombres distintos en filas distintas, se queda el de
  la primera. Es aceptable para una revisión.
- REG-02 (`purchases.service.ts:290`) es equivalente: `toDateOnly` es literalmente
  `new Date(\`${v}T00:00:00.000Z\`)`.

## Respuesta del autor

- **P2-1 (corregido):** la renovación sin firma válida conserva el código anterior si ya es un código de D-694 y borra
  una IP en claro heredada; con firma, guarda el código nuevo. Prueba de los tres casos en `auth-login-ip.spec.ts`.
- **P2-2 (corregido):** NC-03 solo mira las líneas con importe; una de total cero no cuenta, y un comprobante sin líneas
  con importe nunca está «acreditado por completo». Prueba del borde en `credit-note-lines.spec.ts`.
- **P3-1:** las fechas de cotizaciones y pedidos (`sales.ts`) siguen con `Date.parse`: fuera del alcance («campos de
  fecha de comprobantes»), anotado en el handoff.
- **P3-2 (corregido):** el vencimiento ya no repite el `refine`.
- **P3-3 a P3-5:** sin cambios; las filas viejas en claro se van borrando al renovar y vencen a los 30 días.
