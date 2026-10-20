# Ventana cc60 · límites por IP verificada y restos de cc59

19/10/2026, de 20:30 a 22:20 en Lima.

- **Decisiones nuevas:** D-695 (provisional) y D-696 (del dueño).
- **Lo que no hubo:** migración, `--execute` y SQL contra producción.
- **Registro:** el dueño ratificó D-692..D-694 y aprobó el UAT de cc59.

## En producción

| Qué   | Valor                                                        |
| ----- | ------------------------------------------------------------ |
| PR    | #238                                                         |
| API   | `00147-5bk` (`git-sha=66a4b797`), `AYR_CLIENT_IP_SECRET:2`   |
| Merge | `c9280065`                                                   |
| Web   | `c9280065` en las dos URLs                                   |
| Smoke | verde, con `--expect-sha c9280065 --expect-api-sha 66a4b797` |

- **Log de producción** (revisión `00147-5bk`):
  - «Límites por IP verificada del cliente» a las 03:18:26 UTC, que es el tráfico que entra por la web;
  - «IP del cliente: absent» a las 03:18:56, que son llamadas directas a la URL de la API (el health del smoke), que
    cuentan como antes.
  - No se forzó ningún bloqueo.
- **Secreto:** antes de tocar nada se confirmó que la API monta `AYR_CLIENT_IP_SECRET:2`. La versión 1 quedó
  **deshabilitada**, no destruida. `deploy-api` ya resuelve la 2 como la última habilitada.
- **Vuelta atrás:** `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=ayr-steel-erp-api-00146-8ch=100`
  y revert del merge.

## Qué entró

- **`apps/api/src/common/throttler.guard.ts`:**
  - `AppThrottlerGuard` recibe `ENV`;
  - `throttleTracker` y `trackerFor` arman la clave: correo en el login; `ip|<código>` con firma válida; `req.ip` sin
    firma;
  - verifica una vez por petición y avisa cada estado una vez por instancia.
- **`scripts/deploy-web.mjs`:** lee el login del CLI 64 de Vercel y deja la ruta vieja de respaldo.
- **Pruebas en `throttler-client-ip.spec.ts`:**
  - dos IP verificadas no comparten cupo, y el mismo /64 sí;
  - sin firma, con firma mala o sin secreto vuelve a `req.ip`;
  - el login sigue por correo;
  - con el guard real, 31 renovaciones desde una IP se frenan y otra IP sigue entrando.
- **`hygiene-cc57.spec.ts`:** pasa a usar `throttleTracker`.

## Revisiones

`docs/revision/cc60-segundo-modelo.md`, con la respuesta del autor. No hubo P0 ni P1. Los dos P2 se corrigieron: el log
que alternaba y la doble verificación del HMAC.

## No se hace

- **Tabla compartida de conteos** (decisión del dueño, D-696): escribiría en la base en cada petición, y con 2 instancias
  el doble de cupo es aceptable para un límite contra abuso.

## Pendiente

- **Dueño:** ratificar D-695 y hacer el UAT en `docs/uat/cc60.md`.
- **Sigue igual:** el tráfico que no pasa por la web (sondas, la URL directa de Cloud Run) comparte la cubeta de la IP
  de la conexión.
- **La falla intermitente de `lock-order` (cc57):** sigue solo anotada (handoff de cc59).
