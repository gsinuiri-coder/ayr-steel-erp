# Ventana cc26 — Excel en las listas, menú por rol, Panel por rol e inspección de UX

## Resumen

- **PR #111**, rama `cc26-panel-excel-ux`, abierta desde `main` `b83772a0`.
- **Sin migración.** Toca la API y la web; el Panel solo lee. No se cambió ningún permiso.
- **Sesión desatendida** (D-442): rige D-411, el UAT del dueño va aprobado por defecto y la ventana
  pudo correr a cualquier hora del martes 6.
- **Hitos:** M1, M2, M3, M4, M5 y M-UX hechos; **M6 sacrificado** (D-450).
- **Estado final: desplegada en el reintento, sin vuelta atrás.** El primer intento (03:38–03:45 de Lima) se revirtió en el paso 3 por un corte pasajero de la conexión a Neon al arrancar. El reintento (04:32–04:46 de Lima) dejó la API `ayr-steel-erp-api-00091-k2m` (`git-sha=f86d74a6`) al 100 % y `main` = `8c2f0094`, con `smoke:prod` 8/8 en los dos dominios.

## Hitos

- **M1** (`55684fbb`): Excel de comprobantes (`GET /invoicing/documents/xlsx`) y de cotizaciones
  (`GET /sales/quotations/xlsx`).
  - Mismos roles y alcance que la lista; el mismo método de servicio (`findWindow`) para la lista
    y el Excel, así que las filas son exactamente las de recorrer todas las páginas, en el mismo
    orden (D-446).
  - Tope de 5000 filas: 400, nunca un archivo recortado. Fila final «Total (N …)» con `Decimal`.
  - Patrón común: `packages/shared/src/schemas/list-export.ts`, `apps/api/src/common/list-export.ts`,
    `list-xlsx.ts` y `apps/web/src/lib/list-export.ts#listXlsxHref`.
- **M2** (`6a2b091f`): Excel de pedidos, compras, clientes y cobranzas (D-451).
  - Compras: los importes solo al administrador (el supervisor recibe el archivo sin montos).
  - Cobranzas: «Excel por cliente» (solo administrador, como su GET) y «Excel de pendientes» (el
    de comprobantes con `pendingOnly`, también para el vendedor).
- **M3** (`3be7bccc`): `docs/manual/menu-por-rol.md` con la matriz rol × entrada × por qué, y
  `apps/web/src/lib/menu-por-rol.spec.ts`, que falla si la tabla y `NAV` se separan (D-439).
  Nueve incoherencias como propuestas (MR-1..MR-9), sin tocar permisos.
- **M4** (`d1909e3a`): Panel del administrador (`GET /reports/admin-dashboard`).
  - Ventas del mes sin IGV contra el mismo tramo del mes anterior (D-443), margen sin Servicios
    ni líneas sin producto (D-409, D-419), CxC total y vencido, inventario valorizado,
    producciones «Fuera de tolerancia», facturado por día (D-444), ventas por línea y antigüedad
    de CxC. Recharts 3 con el `chart` de shadcn.
  - Cada cifra es el campo de su reporte para el mismo rango y enlaza a ese reporte con ese rango.
- **M5** (`64d4990c`): Panel del supervisor de planta (`GET /reports/plant-dashboard`): cola de
  OPs, bobinas montadas, consumido hoy y en la semana (D-447, D-449) y bobinas con 10 % o menos de
  su peso (D-448).
- **M6 sacrificado** (D-450): las ventas del vendedor y su conversión no tienen reporte que
  reutilizar; la propuesta para decidir está en D-450.
- **M-UX** (`4d649ff3`): `docs/analisis/cc26-inspeccion-ux.md`. 111 pantallas, tres roles, 1366 y
  1920, axe y los seis flujos completos. 34 hallazgos: 3 P1, 19 P2 y 12 P3. Las 329 capturas y
  los scripts quedaron en `local-data/cc26-ux/` del checkout principal (fuera del repo).
- **Correcciones de las revisiones** (`0b6682e5`) y docs de revisión (`578d0c77`).

## Decisiones

En `docs/ARQUITECTURA.md` §0.2.

- **Del dueño:** D-438 (Excel), D-439 (menú), D-440 (Panel), D-441 (UX), D-442 (sesión
  desatendida) y **D-445** (nada pide confirmación; ver abajo).
- **Provisionales, pendientes del dueño:** D-443 (mismo tramo del mes anterior), D-444
  (facturado por día), D-446 (Excel: todas las filas, tope 5000), D-447 (semana lunes–hoy y
  consumo de merma), D-448 (umbral 10 %), D-449 (roles del Panel de planta), D-450 (M6
  sacrificado) y D-451 (Excel de M2: importes de compras solo al administrador).

## D-445: `.claude/settings.json` y el texto para AGENTS.md

- El dueño cambió `.claude/settings.json` en el checkout principal (la lista `ask` queda vacía;
  `deny` se conserva y se amplía). **Copiarlo al worktree para el PR lo bloqueó el clasificador
  del modo automático («Self-Modification»)**: no se reintentó por otra vía. **El dueño lo
  commiteó él mismo en la rama del PR (`30c7b755`): el archivo va en el PR #111.**
- **Texto propuesto para AGENTS.md** (lo commitea el dueño), para reemplazar el segundo párrafo
  de la regla 1 de §3 («D-411 (2026-10-05…»):

  > **D-445 (2026-10-06, vigente hasta que el dueño diga lo contrario) reemplaza a D-411: ninguna
  > acción pide confirmación.** Todo va directo a producción con el UAT del dueño aprobado por
  > defecto, salvo que el dueño pida demo de forma explícita. Merge y push a `main` (con
  > `AYR_OWNER_PUSH=1`), `pnpm deploy:api`, `pnpm smoke:prod`, la vuelta atrás con
  > `gcloud run services update-traffic` y los demás comandos que antes estaban en `ask` corren
  > sin OK por acción. Siguen prohibidos (`deny` de `.claude/settings.json`): `gh repo sync`,
  > `git push` con `--force`, `--delete`, `-f`, `-d`, `+main` o `:main`, borrar ramas de Neon,
  > `e2e:prod`, `prod-reset-go-live` y leer `.env*`. Siguen en pie las reglas duras que no son de
  > confirmación: sin SQL directo contra producción, una migración detiene la sesión y se
  > pregunta, credenciales nunca en argv, y si falla el deploy, el merge o el smoke, la vuelta
  > atrás es automática (API a la revisión anterior y revert del merge), otro smoke y el registro
  > escrito, sin arreglos en caliente.

## Revisiones

- **Autorrevisión** (`docs/revision/cc26-autorrevision.md`; subagente nuevo, lista de riesgos y no
  aprobación): 0 P0, 0 P1, 1 P2, 15 P3.
- **Segundo modelo** (Sonnet, contexto limpio; `docs/revision/cc26-segundo-modelo.md`): 0 P0,
  0 P1, 2 P2, 11 P3.
- **Resueltos (`0b6682e5`):**
  - P2 de las dos: el Excel con filtro derivado (pendientes, compras con saldo) podía salir
    recortado → 400 si el universo llega al corte.
  - P2 del segundo modelo: el presupuesto de consultas de los Paneles contaba llamadas a
    servicios → ahora `dashboards.db-spec.ts` lo mide en SQL contra una base real: cada Panel
    cuesta exactamente lo que sus lecturas y queda bajo un techo fijo (60 y 40).
  - P3: la dependencia `cn` que trajo el `chart` de shadcn (ahora usa `@/lib/utils`), el
    «+-0.0 %» y el refresco cada minuto del Panel de planta.
- **P3 que quedan** (detalle en los dos informes): el 400 del tope se ve como texto en el
  navegador (la descarga es un enlace); el total de comprobantes suma las notas de crédito en
  positivo, como la lista; el total de cotizaciones suma todos los estados filtrados; el orden
  por estado de pedidos no viaja al Excel (es de página); el enlace de «Fuera de tolerancia»
  abre una sola pestaña; detalles de accesibilidad de los gráficos.

## Tests y UAT

- **Unitarios:** API 2721 (2 omitidos) y web 18 archivos, en verde. `test:db`:
  `dashboards.db-spec.ts` 2/2.
- **lint, typecheck y Prettier:** limpios.
- **E2E nuevos:** `panel-cc26` (4) y `excel-listas-cc26` (2).
- **UAT propio** (`docs/uat/cc26.md`), con build de producción en `ayr_local_e2e_cc26`:
  - los E2E nuevos, 6/6, más el menú de D-326, orden de columnas y los reportes de cc24 y cc25;
  - recorrido con navegador por rol a 1366 y 1920 con datos sintéticos: las cifras del Panel
    cuadran (ventas 6 950, CxC 8 201, vencido 1 121) y los siete Excel bajan con sus totales;
  - el menú de cada rol coincide con el documento.
  - Las capturas, los Excel y el registro quedaron en `local-data/cc26/uat/`.
- **UAT del dueño:** aprobado por defecto (D-442).
- **CI del PR:** run 37433458004 sobre `f92684ab`, en verde (lint, unitarios, `test:db`, E2E completo en el runner, smoke de Neon `ci` y Sonar). El run anterior (`144cdc7d`) tuvo un rojo propio en `test:db`: el presupuesto del Panel de planta no contaba la segunda página de bobinas que dejan los otros `db-spec`; se corrigió en `f92684ab`.

## Resumen de D-232 (antes de la ventana)

- **Qué entra:** el Excel en seis listas, el Panel del administrador y el de planta, el documento
  del menú y el informe de UX. Hay cuatro rutas nuevas de solo lectura en la API, más las seis
  de Excel. Las listas existentes ahora pasan por `findWindow`, con el mismo filtro, orden y
  paginación de antes, y los unitarios lo prueban.
- **Qué no entra:** migraciones (0), cambios de permisos o de alcance por vendedor, y escrituras.
- **Riesgo principal:**
  - El refactor de las seis listas: comprobantes, cotizaciones, pedidos, compras, clientes y
    cobranzas.
  - El costo del Panel del administrador, que al abrirse corre ventas y margen dos veces, CxC,
    inventario y merma dos veces; se mide su tiempo en producción.
- **Convivencia:**
  - **API nueva + web vieja:** las rutas nuevas no se llaman y las listas responden igual.
  - **Web nueva + API vieja:** el Panel y los botones de Excel darían 404, así que la API va
    primero.
- **Vuelta atrás:** API a `ayr-steel-erp-api-00089-8mf` y revert del merge en `main`.

## Ventana

### Primer intento: revertido en el paso 3

Se intentó el martes 6 de octubre, entre las 03:38 y las 03:45 de Lima (08:38–08:45 UTC), con D-411 y D-442. **Falló
en el paso 3 (deploy de la API), y se aplicó la vuelta atrás sin arreglos en caliente.**

1. **Vuelta atrás anotada:** la API `ayr-steel-erp-api-00089-8mf` (`git-sha=39dfe852`) servía al
   100 % y `main` estaba en `b83772a0`.
2. **Migraciones:** 0 (no hay archivos en `apps/api/prisma/migrations` en el diff).
3. **Deploy de la API, fallido:**
   - Se corrió
     `pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app`
     desde el worktree limpio en `f92684ab` (el commit con la CI en verde), con `AYR_ENV_SETUP`
     apuntando al checkout principal.
   - La imagen se construyó, pero la revisión **`ayr-steel-erp-api-00090-s8l` no arrancó**: el
     contenedor salió con código 1 antes de escuchar en el 8080.
   - **Causa, según el log de la revisión:** `PrismaClientInitializationError` P1001, «Can't
     reach database server» (el _pooler_ de Neon de producción), en `PrismaService.onModuleInit`.
     El código de cc26 no llegó a correr: el fallo es la conexión a la base al arrancar.
4. **Merge:** no se hizo. `main` sigue en `b83772a0` y Vercel sigue sirviendo la web de cc25.
5. **Vuelta atrás:**
   - El tráfico nunca dejó `00089-8mf`: Cloud Run no manda tráfico a una revisión que no arranca.
   - El `gcloud run services update-traffic … --to-revisions ayr-steel-erp-api-00089-8mf=100`
     explícito respondió con el mismo error de la revisión fallida (el _template_ del servicio
     quedó en `00090-s8l`). No se reintentó.
   - Después de eso, `describe` sigue mostrando 100 % en `00089-8mf` y `RoutesReady=True`.
   - No hay merge que revertir.
6. **Smoke después de la vuelta atrás**, desde el checkout principal en `b83772a0` (mismo runtime
   que `39dfe852`): **verde en los dos dominios**, `ayr-steel-erp-web.vercel.app` y
   `v2.mareliac.pe`. Pasaron login, líneas, catálogo, inventario valorizado, bobinas, reporte
   mensual y emisión apagada. Producción, con la API de cc25, llega a la base.

**Estado que queda en Cloud Run (para la próxima ventana):**

- La revisión `00090-s8l` existe y está en falla, sin tráfico.
- La etiqueta `git-sha` del **servicio** quedó en `f92684ab`, aunque la revisión que sirve es
  `00089-8mf` (`39dfe852`). La etiqueta de la revisión que sirve es la correcta.
- El próximo deploy que arranque corrige las dos cosas.

**Para decidir antes de reintentar:**

- La API vieja llega a la base y la nueva no llegó al arrancar. Puede ser un corte transitorio de
  Neon (una instancia nueva que se conecta en frío) o una diferencia en la conexión que
  `deploy-api` arma desde `.env.setup`.
- La sesión no leyó `.env.setup` ni Secret Manager (prohibido), así que no puede distinguir entre
  las dos.
- Recomendación: que el dueño confirme que la cadena de `.env.setup` es la vigente de
  `production` y repita el deploy en otra ventana. El PR #111 queda listo, con la CI en verde.

Salidas: `local-data/cc26/` del checkout principal (deploy, intento de `update-traffic` y los dos
smokes).

### Reintento (martes 6, 04:32–04:46 de Lima): **desplegada, sin vuelta atrás**

Se hizo con D-411, D-442 y D-445, en el checkout principal y en la rama del PR, sin worktree.

1. **CI del PR en verde** (run 37440024851 sobre `f86d74a6`): lint, unitarios, `test:db`, E2E
   completo en el runner, smoke de Neon `ci` y Sonar.
   - Antes hubo un rojo: el `.claude/settings.json` que commiteó el dueño (`30c7b755`) no pasaba
     `format:check` porque le faltaba el salto de línea final.
   - `f86d74a6` le dio el formato de Prettier sin cambiar su contenido (el JSON es idéntico).
2. **Diagnóstico de secretos** (solo metadatos, sin leer valores; salida en
   `local-data/cc26/diagnostico-secretos.txt`):
   - `00089-8mf` y `00090-s8l` tienen las mismas 14 variables, los mismos literales y las mismas
     versiones de secretos: `DATABASE_URL:7`, `DIRECT_URL:6`, `JWT_SECRET:6`, y la 5 de
     `APIS_NET_PE_TOKEN` y de los `R2_*`.
   - Versiones vigentes: `DATABASE_URL` v7, creada el 26/09/2026 a las 09:52 de Lima (las v1–v5
     están deshabilitadas, la v6 es del 10/09); `DIRECT_URL` v6, del 10/09/2026 a las 15:19.
   - Ninguna versión es posterior a 00089. **Conclusión: el P1001 del primer intento fue un corte
     pasajero de la conexión a Neon al arrancar.**
3. **Vuelta atrás anotada:** API `ayr-steel-erp-api-00089-8mf` (`git-sha=39dfe852`) al 100 % y
   `main` en `b83772a0`. **Migraciones: 0.**
4. **API:** `pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app`
   desde el checkout limpio en `f86d74a6`.
   - Arrancó la revisión **`ayr-steel-erp-api-00091-k2m`**, con `git-sha=f86d74a6`.
   - El tráfico seguía fijado en `00089-8mf` por el `update-traffic` del primer intento: aunque
     respondió con error, había fijado la revisión.
   - Se pasó con `gcloud run services update-traffic … --to-latest`: `00091-k2m` quedó al 100 %.
   - `/health` dio `{"status":"ok","db":"ok"}` por `v2.mareliac.pe`.
5. **Merge del #111:** `main` = **`8c2f0094`**.
   - `git diff --quiet f86d74a6 origin/main -- apps packages …` dio exit 0: sin diff de runtime.
   - Vercel en `success` para `8c2f0094`.
6. **`smoke:prod`:** 8/8 en `ayr-steel-erp-web.vercel.app` y 8/8 en `v2.mareliac.pe`, desde el
   checkout en `f86d74a6`.
7. **Recorrido de solo lectura en producción** (admin de `.env.setup`: login, solo GET y logout;
   salida en `local-data/cc26/recorrido-prod.txt`):
   - **Panel del administrador** (0,9 s). Cada cifra es igual a la de su reporte para el mismo
     rango:
     - ventas del 1 al 6 de octubre: S/ 905,87 sin IGV; mismo tramo de septiembre: S/ 127 118,64;
     - margen S/ 181,62 (20,05 %);
     - CxC S/ 915 506,18, con S/ 716 260,12 vencido y 44 clientes; los tramos son idénticos;
     - inventario valorizado S/ 738 840,34;
     - 6 producciones «Fuera de tolerancia» en Coberturas Aluzinc y 0 en Drywall;
     - lo facturado por día es igual a ventas más excluidas más no rastreables.
   - **Panel de planta** (0,8 s): cola 0 (= `/production/roofing/queue`), 2 bobinas montadas,
     464 kg consumidos hoy y 77 191 kg en la semana (Coberturas Aluzinc), y 2 bobinas por
     terminarse.
   - **Los siete Excel** respondieron 200, como xlsx, en menos de 1,4 s: comprobantes (63),
     pendientes (63: hoy todos los comprobantes vivos tienen saldo, lo mismo que dice la lista),
     cotizaciones (147), pedidos (68), compras (24), clientes (91) y cobranzas por cliente (44).
8. **Vuelta atrás:** no hizo falta. Si el dueño la necesita, son las dos juntas:
   `cmd /c gcloud run services update-traffic ayr-steel-erp-api --region us-central1 --project ayr-steel-erp --to-revisions ayr-steel-erp-api-00089-8mf=100`,
   y un commit de revert del merge `8c2f0094` en `main`.

**Queda en Cloud Run:** la revisión fallida `00090-s8l`, sin tráfico. El tráfico sigue a la última
revisión (`latestRevision: true`) y la etiqueta `git-sha` del servicio es la correcta
(`f86d74a6`).

## Para el dueño

1. **Qué revisar en producción** (`https://v2.mareliac.pe`, como administrador):
   - El Panel: «El mes en cifras» y los tres gráficos; abrir cada cifra y comprobar que el reporte
     muestra lo mismo para el mismo rango.
   - «Descargar Excel» en comprobantes, cotizaciones, pedidos, compras y clientes, y los dos de
     cobranzas; con un filtro puesto, el archivo trae lo filtrado.
   - Con un usuario de planta: «Planta hoy». Con uno vendedor: sus Excel solo con lo suyo.
   - `docs/manual/menu-por-rol.md` y decidir las propuestas MR-1..MR-9 (MR-1, cobranzas del
     vendedor, es la más seria).
2. **Decisiones provisionales** por confirmar: D-443, D-444, D-446..D-451.
3. **Los cinco hallazgos de UX más importantes** (`docs/analisis/cc26-inspeccion-ux.md` §8):
   1. **UX26-01:** el mostrador muestra el precio sin IGV (S/ 50.00) donde el catálogo muestra
      S/ 59.00 con IGV para el mismo SKU: riesgo de cobrar 15 % menos en caja.
   2. **UX26-02:** el despacho nuevo y el diálogo de cobro tienen sus controles sin nombre
      accesible (axe crítico), incluido el «Monto» del cobro.
   3. **UX26-03:** «Ejecutar y cerrar» una OP la cierra, mueve kardex y termina la bobina sin
      confirmación.
   4. **UX26-05/09/10/11:** a 1366×768 el modal de montar bobinas corta «Montar», la rentabilidad
      del comprobante desborda y el menú no recuerda su colapso.
   5. **UX26-06/07/13:** cotizar y despachar dejan «Guardar» bajo el pliegue, y salir del
      formulario descarta todo sin aviso.
4. **Ramas remotas para borrar:** `cc26-panel-excel-ux` y `docs/cierre-cc26`. El agente no puede: `git push --delete` está prohibido.
5. **`.claude/settings.json`:** ya está en el PR #111 (`30c7b755`, commit del dueño). Falta el
   texto de D-445 para AGENTS.md (arriba), que commitea el dueño.

## Bloqueos

- Copiar `.claude/settings.json` al worktree: bloqueado por el clasificador («Self-Modification»);
  lo commiteó el dueño en el PR (`30c7b755`).
- Renumerar en bloque las decisiones provisionales con `sed`: bloqueado por el clasificador por
  continuar lo anterior. Se mantuvieron D-443/D-444 y la regla del dueño quedó en D-445.

## Neon

Esta sesión no creó ni borró ramas de Neon y no usó `neonctl`, `db:prod` ni `prod:*`.
