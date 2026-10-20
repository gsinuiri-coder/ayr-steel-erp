# cc60 — revisión de segundo modelo (Sonnet, contexto limpio)

Alcance: `git diff origin/main...HEAD`. Veredicto: **sin P0 ni P1**; se puede desplegar. Los dos specs nuevos pasan (11 pruebas, `throttler-client-ip.spec.ts` y `hygiene-cc57.spec.ts`). Sigue siendo un modelo, no una persona.

## Lo comprobado (sin hallazgo)

- **DI de `ENV`**: `ConfigModule` es `@Global()` y exporta `ENV` (`apps/api/src/config/config.module.ts:5-11`). `AppThrottlerGuard` se instancia como `APP_GUARD` dentro de `AppModule`, que ya usa `ENV` en `ThrottlerModule.forRootAsync` (`app.module.ts:41-47`), así que resuelve. `@InjectThrottlerOptions/@InjectThrottlerStorage` son los tokens que exporta el módulo del throttler (global); el spec los resuelve con el módulo real. Riesgo de fallo de arranque en producción: bajo. `AYR_CLIENT_IP_SECRET` es opcional (`env.ts:37`), así que su ausencia no tumba el arranque: queda `req.ip` como antes.
- **Suplantación por repetición**: la firma cubre `<ip>.<ts>` y dura ±60 s (`client-ip.ts:40-50`). Un atacante solo puede enviar por la web, que borra los tres encabezados entrantes (`client-ip-signature.ts:38`) y firma el `x-real-ip` que pone Vercel; no obtiene la firma de otra IP (viaja por TLS). Directo a Cloud Run no puede firmar y cae a `req.ip`. Elegir un cubo ajeno no es posible; lo peor es consumir su propio cupo.
- **Login**: la clave `email|<correo>` va primero (`throttler.guard.ts:47-49`), antes de verificar la IP, y no cambia. El límite por IP de D-693 vive en `AuthService` y usa el mismo `loginIpKey`; no choca con este guard. Un login sin correo string ahora cae a la cubeta por IP verificada (antes la compartida de Vercel): mejora.
- **Efecto neto**: antes todos los usuarios de la web compartían un cubo de 120/min y 30/min de refresh (un usuario o atacante frenaba a todos); ahora es por IP. Los umbrales no cambian.
- **IPv6**: `ipBucket` agrupa por /64; el spec lo cubre.
- `deploy-web.mjs`: solo suma una ruta de candidato al token; no imprime nada. Sin hallazgo.

## Hallazgos

### P2 — Ruido de log por alternancia de estado

`apps/api/src/common/throttler.guard.ts:74-82` (`noteState`). El estado se guarda por instancia y se registra en cada cambio. Si la instancia recibe a la vez peticiones firmadas (proxy `/api/*` de la web) y sin firma (llamadas del servidor de Next fuera del proxy, sondas de salud, scripts), `lastState` alterna `verificada` / `absent` en cada cambio de tipo de petición y escribe una línea cada vez. «Una vez por cambio de estado» no equivale a «una vez»: en una instancia con tráfico mezclado puede ser una línea por petición. Sugerencia: registrar solo transiciones de «sin secreto» o `bad-signature`/`expired`/`malformed` (las que indican mala configuración o ataque), y no `absent`; o limitar con un mínimo de intervalo (p. ej. una línea por estado cada 10 min).

### P2 — `verifyClientIp` se calcula dos veces por petición

`throttler.guard.ts:41` y `:68`. `throttleTracker` verifica la firma y luego `getTracker` la vuelve a verificar solo para el log. Cada petición paga 2 HMAC de verificación más 1 HMAC de `loginIpKey` (microsegundos; no preocupa por rendimiento), pero es duplicación evitable y añade acoplamiento. Sugerencia: que `throttleTracker` devuelva `{ tracker, check }`, o que el log se arme con el mismo resultado.

### P3 — Falta una prueba de arranque real

`throttler-client-ip.spec.ts:62-70` arma el guard con `Test.createTestingModule` y un `ENV` falso; no prueba que `APP_GUARD` resuelva `ENV` dentro de `AppModule`. Mi análisis dice que sí, pero una regresión (p. ej. sacar `@Global()`) solo se vería al arrancar. Sugerencia: un test mínimo que importe `ConfigModule` + `ThrottlerModule.forRootAsync` y registre `{ provide: APP_GUARD, useClass: AppThrottlerGuard }`, y compile.

### P3 — Pruebas que no cubren el log ni la ventana de tiempo

El spec no prueba `noteState` (ni su alternancia, ver P2) ni el borde de ±60 s a través del guard (eso lo cubre `client-ip.spec.ts`). Tampoco hay prueba de que el login con firma válida y sin correo caiga en `ip|`. Menor.

### P3 — Datos en memoria por IP

`throttler.guard.ts:51`. Con claves por IP, el almacén en memoria crece con el número de IP distintas por minuto (se limpia por TTL de 60 s). Sin riesgo real a esta escala; solo advertirlo si el almacén vuelve a ser compartido (D-696).

### P3 — Tráfico sin firma comparte cubo

Lo que llega sin firma (SSR de Next hacia el API, si existe) sigue contando por la IP de salida de Vercel y comparte cupo entre todos, como antes. No es regresión; conviene verificar en el UAT que esas llamadas no agoten el cubo de la IP de Vercel junto con el tráfico no firmado de otros orígenes.

## Respuesta del autor (cc60)

- **P2 (log que alterna): corregido.** Cada estado se avisa una vez por instancia (un `Set`, no el
  último estado), así que el tráfico firmado y sin firmar mezclado no escribe una línea por petición.
- **P2 (HMAC doble): corregido.** `getTracker` verifica una vez y pasa el resultado a `trackerFor`.
- **P3 (arranque real con `APP_GUARD`):** lo cubren los E2E de la CI, que levantan la app entera. El
  borde de ±60 s está probado en `client-ip.spec.ts`.
- **P3 (tráfico sin firma comparte el cubo de Vercel):** queda igual que hoy, por diseño.
