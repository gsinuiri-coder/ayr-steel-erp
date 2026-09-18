# Handoff — ventana de producción RF-S3

## 1. Resumen

RF-S3 quedó publicada y verificada en producción el 2026-09-18. El runtime desplegado es
`d25f6b2b27d9330c53e006b44202a3a7f2b4b495`: API Cloud Run
`ayr-steel-erp-api-00038-ljx` y web Vercel alineadas en ese SHA. PR #3 fue integrado a `main`
con el OK explícito del dueño exigido por D-232. UAT 6/6 OK, `pnpm smoke:prod` verde,
verificación real de selectores/cards verde y CI de `main` completa en verde.

## 2. Hecho

- **PASO 0:** revisión activa previa, health y SHA web comprobados. La API anterior era
  `00037-njl`; el runtime web anterior era `ffe4cee`.
- **PASO 1:** demo levantada en API 3000/web 3001, con R2/PSE/jobs apagados. Casos 1–6 de
  `docs/uat/rf-s3.md`: todos OK. El Caso 1, con login fresco, dio 3/3 OK; la demora inicial no
  fue reproducible. Casos 2–6 validaron selector de producto, exclusión del cliente actual,
  cards del Panel y el flujo de cotización/pedido. Procesos y administradores efímeros retirados.
- **PASOS 2–3:** anulados por decisión del dueño: RF-S3 no agrega migraciones ni toca datos.
  El diff seguía coincidiendo exactamente con el drift conocido.
- **PASO 4:** API desplegada primero con `--env-vars-file`, label `git-sha=d25f6b2` y
  `WEB_ORIGIN` con `https://v2.mareliac.pe` y `https://ayr-steel-erp-web.vercel.app`. Revisión
  activa `00038-ljx`, 100 % de tráfico, health/DB OK y los 12 nombres esperados de
  variables/secretos verificados, sin imprimir valores.
- **PASO 5:** con OK explícito D-232, `rf-s3` avanzó `main` por fast-forward
  (`ffe4cee..d25f6b2`). PR #3 quedó MERGED y Vercel publicó `d25f6b2` correctamente.
- **PASO 6:** `pnpm smoke:prod` verde: health 200, login OK, 5 líneas de negocio, 174 productos,
  48 filas de inventario valorizado, 5 bobinas, 43 filas del reporte mensual y PSE apagado.
  En la app real, ambos selectores buscaron contra el servidor; Panel cargó 54 cotizaciones con
  faltantes y 0 SKUs bajo piso, sin errores. El administrador efímero fue retirado.
- **Rendimiento:** el dueño midió `/customers/search` en 517 ms, sin caché y con sesión real.
  Una muestra adicional con cinco términos dio 381, 401, 438, 375 y 470 ms; 48 clientes activos.

## 3. Decisiones tomadas

- **D-234:** los comandos Neon bloqueados por permisos de Windows dentro del sandbox requieren
  ejecución del dueño o autorización explícita por comando para el agente.
- **D-235:** D-229 se mantiene; producción cumple el objetivo de menos de 1 s, así que no se
  agrega índice ni migración preventiva.
- **D-232 aplicado:** el dueño autorizó explícitamente publicar; el agente usó
  `AYR_OWNER_PUSH=1` solo para el fast-forward aprobado a `main`.

## 4. Bloqueos / pendientes

- **Deuda `db-demo.mjs`:** promete sembrar el administrador con la contraseña de `.env.demo`,
  pero no define `SEED_ADMIN_FOR_TESTS=1`; sobre el clon de producción conserva el hash de
  producción. Resolver en una sesión de grind: corregir el script o corregir la promesa de la
  documentación. No se tocó en esta ventana.
- El dueño eliminará la rama remota `rf-s3`; el agente retira solo worktree y rama local.
- La rama Neon `ensayo-pitr-20260917` solo puede borrarse con OK explícito del dueño por nombre.
- No hay bloqueo funcional ni rollback pendiente. Si apareciera una regresión, la opción
  documentada es volver API a `00037-njl` y revertir el merge; no ejecutar sin OK del dueño.

## 5. Cómo verificar

```bash
pnpm smoke:prod
gh pr view 3 --json state,mergeCommit,mergedAt
gh run view 35352376572
```

Resultado de smoke esperado: todas las lecturas verdes y eliminación final del administrador
efímero. En `https://v2.mareliac.pe`, verificar que los selectores de cliente y producto
devuelven resultados desde sus endpoints y que las cards de faltantes y bajo piso cargan sin
error. CI de `main` [35352376572](https://github.com/gsinuiri-coder/ayr-steel-erp/actions/runs/35352376572)
corresponde al SHA `d25f6b2` y quedó verde: lint/typecheck/unit, análisis estático, E2E completa
371 passed/0 failed/3 skipped y smoke Neon 35 passed/0 failed/2 skipped. Los skips son los
esperados; no hubo rojos que clasificar.

## 6. Siguiente sesión

Sesión de grind ya indicada por el dueño: resolver la contradicción de `db-demo.mjs` y su
documentación, sin encadenar cambios funcionales de RF-S3.
