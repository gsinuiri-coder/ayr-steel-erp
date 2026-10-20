# Ventana cc59 · límite de intentos fallidos de login por IP

19/10/2026, de 18:30 a 20:15 en Lima. Decisiones nuevas: D-692, D-693 y D-694, todas provisionales.

No hubo migración, ni `--execute`, ni SQL contra producción. Lo único que se creó en producción fue un secreto nuevo, con
el OK del dueño por nombre.

## En producción

| Qué   | Valor                                                           |
| ----- | --------------------------------------------------------------- |
| PR    | #236                                                            |
| API   | `00146-8ch` (`git-sha=f960984f`)                                |
| Merge | `28061ead`                                                      |
| Web   | `28061ead` en `v2.mareliac.pe` y `ayr-steel-erp-web.vercel.app` |
| Smoke | verde, con `--expect-sha 28061ead --expect-api-sha f960984f`    |

- **Secreto.** `AYR_CLIENT_IP_SECRET` está en Secret Manager (versión 2, montada por `deploy-api`) y en Vercel
  (production y preview, «sensitive»).
  - La versión 1 quedó huérfana: la escribió el primer intento, que falló en Vercel con un 403 porque el token del CLI
    estaba vencido. El dueño volvió a iniciar sesión y se rotó.
  - El valor no pasó por argv. No quedó en logs, en `local-data` ni en el historial: se revisó buscando cadenas de 43
    caracteres y solo aparecen nombres de migraciones y el secreto de la base local de pruebas.
- **Verificación en producción.** El login del smoke entró por la web y el log de la API registró «IP del cliente
  verificada» (01:10 UTC). En la última hora no hubo ningún aviso de firma rechazada. No se forzó ningún bloqueo contra
  usuarios reales.
- **Vuelta atrás.** `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=ayr-steel-erp-api-00145-6qp=100`
  y revert del merge. Sin la firma, el API vuelve a usar solo el límite por correo.

## Qué entró

- **API**
  - `apps/api/src/auth/client-ip.ts` tiene `verifyClientIp`, `signClientIp`, `loginIpKey` e `ipBucket`.
  - `auth.controller.ts` verifica las cabeceras y `auth.service.ts` cuenta los fallidos en `audit_log`; `audit-tx-invariant`
    pasa a 6.
  - `config/env.ts` agrega `AYR_CLIENT_IP_SECRET`, opcional.
- **Web**
  - `apps/web/src/lib/client-ip-signature.ts` y el proxy `app/api/[...path]/route.ts`.
- **Scripts**
  - `scripts/client-ip-secret.mjs` (`pnpm secrets:client-ip`) crea o rota el secreto. Lee el login del CLI 64 de Vercel en
    `%APPDATA%/com.vercel.cli/Data/auth.json`.
  - `deploy-api.mjs` monta el secreto. También se arregló su regex de versiones (`/^[1-9]\d*$/`), que no aceptaba la
    versión 10 o mayores.
- **Pruebas**
  - `client-ip.spec.ts` cubre firma válida, inválida, vencida, ausente, mal formada y sin secreto, además del vector común
    con la web y el bloque /64 de IPv6.
  - `auth-login-ip.spec.ts` cubre el intento 21, la ventana, que un login correcto no reinicia la cuenta y que no se mira
    la IP sin firma.
  - `login-ip.db-spec.ts`, contra la base, prueba el 429 en el intento 21, la reapertura de la ventana, que dos IP no se
    mezclan y que la IP no queda en claro.
  - `client-ip-signature.spec.ts` (web).

## Rotar el secreto

1. Correr `pnpm secrets:client-ip`. Necesita el login del CLI de Vercel; si falta, `npx vercel@latest login`.
2. Correr `pnpm deploy:api --web-origin "https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app"`.
3. Desplegar la web, con un PR o con el «Redeploy» de Vercel.

Mientras los dos lados no tienen el mismo valor, el API ignora la IP declarada y sigue con el límite por correo: el login
no se corta.

## Revisiones

`docs/revision/cc59-segundo-modelo.md`, con la respuesta del autor. No hubo P0. Los P1 se corrigieron:

- la ruta exacta se podía esquivar con mayúsculas o barra final;
- la regex de versiones de `deploy-api` estaba rota.

## Pendiente

- **Dueño:** ratificar D-692..D-694 (sobre todo la política de D-693 con IP compartida) y hacer el UAT en
  `docs/uat/cc59.md`.
- **Prueba intermitente, solo anotada.** El par de cc57 «anular una NC con devolución × anular su pedido» de
  `lock-order.db-spec.ts` falló una vez en la suite completa local (234/235). Corrida sola, pasó 2 de 2. No se tocó.
- **Secret Manager.** La versión 1 de `AYR_CLIENT_IP_SECRET` sigue habilitada sin uso. Se puede deshabilitar.
- **Fuera de alcance.** La cubeta general y la de `/auth/refresh` siguen contando por la IP de Vercel. El visor de
  auditoría muestra el hash de `login_ip` como código.
