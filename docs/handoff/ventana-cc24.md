# Ventana cc24 — Reportes por línea que cc23 dejó fuera

## Resumen

- **PR #107**, rama `cc24-reportes-linea`, abierta desde `main` `cf9cc32`.
- **Sin migración.** Toca la API y la web.
- **Los cinco hitos están hechos:** M0 a M4. No se sacrificó ninguno.
- **Estado final: desplegado, sin vuelta atrás** (ventana del 2026-10-05, 20:01–20:11 Lima).
  - API `ayr-steel-erp-api-00088-kn4`, con `git-sha=72ab61a2`, al 100 %.
  - `main` = `dbd3421b`, el merge del PR #107.
  - Detalle en «Ventana ejecutada», al final.
- **Después del primer cierre** (ver «Pendiente antes de la ventana», ya cumplido):
  - D-419: el margen de «Todas» también sin «Sin línea»;
  - D-416, confirmada;
  - permisos 4a y 4b;
  - AGENTS.md §3.2, §5 y §10 alineados con D-411;
  - demo refrescada y UAT del dueño aprobado.

## Hitos (M0 a M4)

- **M0** (`fbc7ebf3`): los P2 y los P3 triviales de cc23 (D-410).
  - P2-1 de la autorrevisión de cc23, con D-412: la venta de Servicios no depende del estado de
    costo del pedido.
  - P3-4: el comprobante de una línea que no despachó muestra «—», no costo 0.
  - P3-10: una bobina de otra línea en inventario muestra su tabla.
  - Los otros P2 de cc23 eran D-398 y D-403, ya ratificadas, o ya estaban corregidos.
- **M1** (`d590450a`), D-409: el margen de «Todas» se calcula sin Servicios.
  - `totals.noCostSalesPen` da la venta de Servicios, que se muestra aparte y sigue sumando a la
    venta.
  - La franja y el Excel de «Todas» siguen la regla.
  - El costo no cambia: Servicios no tiene kardex.
- **M2** (`d44536d9`): ventas por material para Coberturas Aluzinc y Drywall, con `?linea=` y
  sin «Todas» (D-406, D-407, D-413..D-416).
  - Drywall muestra Perfiles × espesor del fleje, con el color «Galvanizado». El teórico es piezas
    × kg por pieza; lo hecho a stock y lo comprado se declaran aparte.
  - La bobina entera se queda en la línea de su bobina.
  - Hay un aviso de venta sin línea.
  - El Excel solo aparece en Aluzinc.
- **M3** (`96e04b1b`): Coberturas (UPVC) y Reventa, por producto (D-417).
  - El costo es el de kardex de los despachos que declaran el comprobante.
  - Lo no atribuible va a «No trazable» con su motivo.
- **M4** (`33769e96`): bobinas con `LineTabs`, sin «Todas» y con Aluzinc por defecto (D-408,
  D-418).
  - El mes va en la URL.
  - El PDF y el Excel siguen la pestaña y nombran la línea.
- **Revisiones** (`86ea3d98`, `4b83a35c`): las correcciones de abajo, los informes y el UAT.
- **Antes de los hitos:**
  - `9dcc3a65` prohíbe `git push` con `--force`, `--delete` y `-f`;
  - `a562bce5` registra D-398..D-405 como ratificadas, D-406..D-411 y la regla D-411 en
    AGENTS.md (el commit lo hizo el agente con la instrucción explícita del dueño, después de que
    el clasificador lo frenara);
  - `e2b94c05` aplica el formato de Prettier.

## Decisiones

Todas están en `docs/ARQUITECTURA.md` §0.2.

- **Ratificadas por el dueño:** D-398..D-405. D-404 queda cerrada por D-409.
- **Del brief:** D-406..D-410.
- **D-411:** cambio de regla. Merge, push a main, `deploy:api`, `smoke:prod` y la vuelta atrás
  por `update-traffic` corren sin OK por acción, solo entre las 20:00 y las 07:00 de Lima.
  Está en AGENTS.md §3 regla 1 y en `.claude/settings.json`.
- **Del dueño en la sesión:**
  - D-412: Servicios no depende del costo.
  - D-413: la bobina entera se queda en su línea; enmienda D-406.
  - D-414: Drywall usa el motor de D-354 y declara lo que no traza.
  - D-415: fila de Drywall por espesor, con «Galvanizado».
  - D-417: UPVC y Reventa por producto, con costo de kardex.
  - D-418: bobinas abre en Aluzinc y el Excel sigue la pestaña.
- **D-416, confirmada por el dueño:** el Excel de ventas por material solo en Aluzinc, por el
  criterio de D-399.
- **D-419, del dueño:** el margen de «Todas» también excluye «Sin línea» (líneas sin producto).
  - En demo, recién copiada de producción, no hay líneas vivas sin producto (0 de 74), así que no
    había nada con costo que mostrar.

## Revisiones

**Autorrevisión** (`docs/revision/cc24-autorrevision.md`; subagente nuevo, es una lista de
riesgos y no una aprobación): 0 P0, 0 P1, 3 P2, 4 P3.

- **Corregidos en `86ea3d98`:**
  - P2-1: en UPVC y Reventa, el subtítulo y el aviso de costeo hablaban de kilos de bobina.
  - P2-2: un pedido de solo Servicios facturado en dos meses contaba como «fuera de los
    totales».
  - P3: la fila «Total del rango» del Excel ahora dice «(margen sin Servicios)».
  - P3: con despacho parcial, trazado + no trazable suman exacto.
  - P3: el reporte de bobinas rotula «Total de <línea>».
- **Anotados:**
  - **P2-3, resuelto con D-419** (`ffa69983`): «Margen (sin Servicios)» seguía incluyendo, con
    costo 0, los servicios escritos a mano que caen en «Sin línea».
  - P3: el aviso «sin línea» de ventas por material cuenta toda la venta sin producto del rango;
    la fila «Sin línea» de ventas y margen excluye los pedidos fuera de los totales.

**Segundo modelo** (Sonnet, contexto limpio; `docs/revision/cc24-segundo-modelo.md`): 0 P0, 0 P1,
3 P2, 5 P3.

- **P2-1..P2-3, todos de permisos, resueltos por decisión del dueño:**
  - P2-1 y P2-3: `51508525`;
  - P2-2: `72ab61a2`, con el texto que el agente propuso, aplicado y commiteado con la
    autorización explícita del dueño.
  - P2-1: la versión permisiva de `.claude/settings.json` quita del `ask` `rm -rf *`,
    `git branch -D *`, `deploy:web` y el `git push *` genérico, que D-411 no nombra.
  - P2-2: AGENTS.md (§3.2, §5 y §10) sigue pidiendo OK para merge y push a main (D-232),
    contra el párrafo de D-411.
  - P2-3: la prohibición de push forzado no cubre `-f` al final, `+main`, `:main` ni `-d`.
- **Corregidos en `86ea3d98`:**
  - P3: `PARCIAL` ya no se cuenta en la pestaña Servicios;
  - P3: el rótulo del Excel.
- **P3 anotados:**
  - el teórico de perfil supone NIU, que es la unidad de Drywall (D-055);
  - filtros viejos en la URL piden dos consultas en las pestañas por producto;
  - JSDoc desactualizado en bobinas.

## Tests y UAT

- **Unitarios:**
  - API `src/reports`: 164;
  - API `src/reports` + `src/coils`: 330 al cerrar M4;
  - web: 96.
- **lint y typecheck:** limpios.
- **E2E nuevo `reportes-por-linea-cc24.spec.ts` (4 casos):**
  - pestañas, historial, refrescar y URL inválida en ventas por material y bobinas;
  - la venta por material de cada línea = la venta de esa línea en ventas y margen;
  - el margen de «Todas» sin Servicios.
- **UAT propio** (`docs/uat/cc24.md`): build de producción, base `ayr_local_e2e_cc24`.
  - E2E: 25 passed, 1 failed. El rojo es `rf-s4a` M2, por infraestructura: PSE apagado en local.
  - Recorrido de cada pestaña de cada reporte: refrescar, retroceder y URL inválida, en verde.
  - Las ventas del recorrido manual quedan en 0 porque los specs purgan las suyas. Los números
    con ventas reales van en el UAT del dueño en demo.

## Antes de la ventana (cumplido)

1. **CI verde** del PR #107 sobre `72ab61a2`, run 37346239914: lint, unitarios, E2E completo en el
   runner, smoke de Neon `ci` y Sonar.
2. **Demo refrescada desde producción** (D-227), con el OK del dueño. Quedaron limpios los datos
   de prueba de cc20 y cc21.
   - El primer `db:reset-dev --branch demo` falló en `neonctl branches reset`. La rama no tenía
     hijas ni estaba protegida.
   - Un reintento único, con un diagnóstico que tapa credenciales, funcionó.
   - De inmediato se corrió `--rotate-only`: la contraseña quedó rotada y verificada.
   - Después, `env:demo` y `db:demo`. No se crearon ramas Neon.
3. **UAT del dueño en demo: aprobado.**
   - Demo se levantó desde el checkout principal puesto en el commit de cc24, para usar su
     `.env.demo` sin copiarlo.
   - Al terminar se apagó y el checkout volvió a `main`.
4. **Resumen de D-232 presentado al dueño.**

## Ventana (D-411: entre las 20:00 y las 07:00 de Lima)

1. Vuelta atrás: API `ayr-steel-erp-api-00087-pcg` y `main` `cf9cc32`.
2. Confirmar 0 migraciones pendientes.
3. Deploy de la API desde el commit del PR, con `git-sha`. Health.
4. Merge del PR. Esperar a que Vercel sirva el commit.
5. `smoke:prod` y cada reporte con cada pestaña en producción.
6. Si falla 3, 4 o 5: vuelta atrás automática (API a `00087-pcg` + revert del merge) y smoke
   otra vez.

## Convivencia entre versiones

- **API nueva + web vieja:**
  - la web vieja no manda `businessLine` a ventas por material y recibe Coberturas Aluzinc, igual
    que antes;
  - los campos nuevos (`noCostSalesPen`, `products`, `noLineSalesPen`, `businessLine`) se ignoran;
  - **el margen de «Todas» de la web vieja ya viene sin Servicios (D-409),** con el rótulo viejo
    «Margen». Es la ventana corta entre el deploy y el merge.
  - `reconciliation.roofingSalesPen` pasó a llamarse `lineSalesPen`. **La API sigue mandando
    `roofingSalesPen` como alias** con el mismo valor, para que la web vieja no se rompa entre el
    deploy y el merge. Se retira en la pieza siguiente.
- **Web nueva + API vieja:**
  - la API vieja ignora `businessLine` en ventas por material: cada pestaña mostraría Aluzinc;
  - faltaría `noCostSalesPen`.
  - Por eso el orden es API primero y después merge, como siempre.

## Ventana ejecutada (2026-10-05, 20:01–20:11 Lima) — **desplegada**

Se hizo con D-411: sin OK por acción, dentro del horario.

1. **Vuelta atrás anotada:** API `ayr-steel-erp-api-00087-pcg` (`git-sha=cbed5aa`) al 100 %, y
   `main` en `cf9cc32`.
2. **Migraciones:** 0 en el PR (sin archivos nuevos en `prisma/migrations`).
3. **API:** se desplegó `pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app`
   desde el worktree, limpio en `72ab61a2`.
   - Revisión **`ayr-steel-erp-api-00088-kn4`**, con `git-sha=72ab61a2`, al 100 %.
   - `/health` 200, directo y por `v2.mareliac.pe`.
4. **Merge del #107:** `main` = **`dbd3421b`**.
   - `git diff --quiet 72ab61a2 origin/main -- apps packages …` dio exit 0: sin diff de runtime.
   - Vercel en `success` para `dbd3421b`.
5. **Verificación:**
   - `smoke:prod` 8/8 en `ayr-steel-erp-web.vercel.app` y 8/8 en `v2.mareliac.pe`;
   - recorrido de solo lectura de cada reporte con cada pestaña contra la API de producción
     (solo GET, más el login del admin de `.env.setup` y su logout), todo en verde.
   - **Septiembre:**
     - «Todas» tiene venta S/ 275 058,68, costo S/ 221 733,44 y margen S/ 53 325,24
       (19,39 %);
     - todo es Coberturas Aluzinc y no hay venta sin costo registrado, así que el margen de
       «Todas» no cambia respecto de antes;
     - las pestañas suman «Todas» en venta, costo y margen;
     - ventas por material coincide con ventas y margen en las cuatro líneas (Aluzinc, 6 filas
       y 0 no trazables).
   - **Octubre (1 al 5):** sin comprobantes.
   - **Bobinas de octubre:** Aluzinc + Drywall = las dos líneas.
6. **Vuelta atrás:** no hizo falta. Si el dueño la necesita, son las dos juntas:
   `cmd /c gcloud run services update-traffic ayr-steel-erp-api --region us-central1 --project ayr-steel-erp --to-revisions ayr-steel-erp-api-00087-pcg=100`,
   y un commit de revert del merge `dbd3421b` en `main`.

Las salidas del deploy, de los dos smokes y del recorrido quedaron en `local-data/cc24/` del
checkout principal, que no está en git.

## Para el dueño: qué revisar en producción

Entrar como administrador en `https://v2.mareliac.pe`.

1. **Ventas y margen, septiembre:** `https://v2.mareliac.pe/reportes/ventas-margen?from=2026-09-01&to=2026-09-30`.
   - En «Todas», la franja tiene que mostrar «Sin costo registrado (Servicios y líneas sin
     producto)» en S/ 0,00 y el margen igual al de ayer.
   - Recorrer las pestañas.
2. **Ventas por material:** `https://v2.mareliac.pe/reportes/ventas-material?from=2026-09-01&to=2026-09-30`.
   - Aluzinc tiene que verse como antes, con el Excel.
   - Drywall, Coberturas (UPVC) y Reventa, con su cuadre. En septiembre están en cero.
3. **Bobinas:** `https://v2.mareliac.pe/reportes/bobinas`.
   - Aluzinc es la de por defecto, y Drywall en su pestaña.
   - Descargar el PDF y el Excel de cada pestaña: tienen que nombrar la línea.
4. **Pendiente del repo:** borrar la rama remota `cc24-reportes-linea`. El agente no puede: la
   prohibición de `git push --delete` de `.claude/settings.json` (pedido del dueño) se lo impide.

## Neon

Esta sesión no creó ni borró ramas. Siguen 9 ramas. La rama `demo` se reseteó desde
`production`, con su contraseña rotada.
