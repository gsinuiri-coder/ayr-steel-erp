# Ventana cc25 — Reportes de cuentas por cobrar y de merma

## Resumen

- **PR #109**, rama `cc25-cxc-merma`, abierta desde `main` `6d25cfea`.
- **Sin migración.** Toca la API y la web. Los reportes solo leen.
- **Los cuatro hitos están hechos (M0 a M3).** No se sacrificó ninguno.
- **Estado final: desplegado, sin vuelta atrás.** Ventana del 2026-10-06, 00:46–00:55 de Lima,
  con D-411 y D-437.
  - API `ayr-steel-erp-api-00089-8mf`, con `git-sha=39dfe852`, al 100 %.
  - `main` = `168b1438`, el merge del PR #109.
- **Fuera de alcance (D-420):** el reporte de producción, hasta que el dueño resuelva su duda
  sobre la OP con varias líneas y bobinas.

## Hitos

- **M0** (`f8c75e47`): retira `reconciliation.roofingSalesPen` de ventas por material. cc24 no
  dejó P2 abiertos.
- **M1** (`cd274c57`): cuentas por cobrar (`GET /reports/receivables-aging`,
  `/reportes/cuentas-por-cobrar`).
  - Por cliente y sin pestañas (D-421).
  - Cinco tramos por vencimiento (D-422). El contado vence el día de su emisión (D-428).
  - Detalle por comprobante, con enlace al comprobante y al pedido, y filtro por vendedor en
    `?vendedor=` (D-423, D-432).
  - Todo en soles: la tabla no tiene moneda (D-427).
  - **El saldo se lee con la misma función que cobranzas** (`loadCollectibleDocuments` en
    `apps/api/src/invoicing/collectible-documents.ts`), que `ReceivablesService` ahora también
    usa. Dos consultas fijas.
- **M2** (`d48a1695`, `1c7cf7f1`): merma por bobina (`GET /reports/coil-waste`,
  `/reportes/merma`).
  - Pestañas Coberturas Aluzinc (la de por defecto) y Drywall, con el rango en la URL.
  - Cifras del kardex del rango (D-429): consumido (salidas `PRODUCTION`), teórico de los
    reportes, diferencia, despunte («Merma de proceso» en Drywall), ajuste de cierre, merma y %
    sobre el estándar (D-430, D-434).
  - La merma manual va en una columna informativa (D-431).
  - El teórico se atribuye sin repartir, o se declara (D-433).
  - «Fuera de tolerancia» y su motivo, leídos de la auditoría de D-388.
  - La bobina entra por producción, despunte o ajuste de cierre (D-425, D-435), aunque después
    se haya revendido (D-436).
  - Cuatro consultas fijas como máximo.
- **M3** (`a5633cb5`): Excel de cuentas por cobrar (`/reports/receivables-aging/xlsx`), con dos
  hojas y el mismo vendedor. Merma no tiene Excel (D-426).
- **Otros commits:**
  - `79f32e55`: decisiones D-420..D-431;
  - `a3bb5fee`: E2E del menú (D-326) con las dos entradas nuevas;
  - `39dfe852`: UAT.

## Decisiones

Todas están en `docs/ARQUITECTURA.md` §0.2.

- **Del brief:** D-420..D-426.
- **Del dueño en la sesión:**
  - D-428: el contado vence al emitir.
  - D-429: las cifras de merma son las del rango.
  - D-430: el % de merma es merma ÷ teórico.
  - D-431: la merma manual va como columna informativa.
  - **D-434:** el teórico ya incluye el 1 % normal (D-165). El % se rotula «sobre el estándar»
    y el rojo aparece solo pasado el 1 % (la tolerancia de D-388/D-389). Un valor negativo se
    muestra tal cual.
  - **D-435:** la bobina entra también por despunte de OP o por ajuste de cierre.
  - **D-436:** «vendida entera» es la bobina que nunca se produjo. La reventa no saca a la
    bobina; se retiró `soldWhole`.
  - **D-437:** el martes 6 la ventana pudo correr a cualquier hora.
- **De aplicación:**
  - D-427: CxC todo en soles.
  - D-432: el vendedor del comprobante es el de cobranzas (`documentOwnerId`).
  - D-433: el teórico de un reporte de varias bobinas no se reparte.

## Revisiones

**Autorrevisión** (`docs/revision/cc25-autorrevision.md`; subagente nuevo, es una lista de
riesgos y no una aprobación): 0 P0, 1 P1, 3 P2, 9 P3.

**Segundo modelo** (Sonnet, contexto limpio; `docs/revision/cc25-segundo-modelo.md`): 0 P0, 1 P1,
3 P2, 6 P3.

- **Resueltos:**
  - Los dos P1, por decisión del dueño:
    - P1 de la autorrevisión: el despunte y el cierre quedaban fuera de todo rango → D-435.
    - P1 del segundo modelo: el teórico ya lleva el 1 % → D-434.
  - P2 de la reventa → D-436.
  - P2 del pie de la tabla de merma.
  - E2E de merma reforzado: ahora compara el consumo de toda la línea con el kardex.
  - Comentario de cobranzas («un número fijo de consultas»).
  - P3: `keepPreviousData`, el vendedor sin saldo vuelve a «todos», el mismo nombre de vendedor
    en el filtro y en el detalle, la aclaración del contado frente a Cobranzas, `overStandard`
    en la web y el rótulo «Merma de proceso» de Drywall.
- **P2 que quedan:**
  - **Consecuencia aceptada de D-429, escrita en D-435:** cuando en un mismo rango corto se
    juntan el despunte de una OP cuyos reportes cayeron en un rango anterior y producción
    nueva, el despunte se divide entre el teórico del rango y el % puede salir alto o bajo.
  - **E2E de merma:** sin producción en la base de la suite, no tiene cifras que comparar. El
    cuadre con datos reales se hizo en producción (abajo).
  - **Cobranzas carga ahora pedido y despacho** de cada comprobante con saldo: son relaciones
    fijas, no una consulta por fila. Conviene mirar su tiempo en producción.
- **P3 que quedan:**
  - el Excel escribe días negativos donde la pantalla dice «Por vencer»;
  - la API de merma no limita el largo del rango;
  - `loadCollectibleDocuments` sigue leyendo también los comprobantes ya pagados (como antes);
  - no hay un spec propio de `addPaymentInTx` después del refactor;
  - el cuadre E2E de CxC hace dos requests seguidos;
  - no hay un E2E del 403 para quien no es administrador (lo cubre el unitario de roles);
  - la clave por índice de las producciones sin reporte;
  - el Excel convierte los importes a número (el patrón de todos los Excel).

## Tests y UAT

- **Unitarios:** API 2615 y web 15 archivos.
  - Incluyen los dos cuadres pedidos: el total de CxC = el de cobranzas para los mismos
    comprobantes, y el consumo de merma = las salidas de producción del kardex.
  - Incluyen también el presupuesto de consultas.
- **lint, typecheck y Prettier:** limpios.
- **E2E nuevo `reportes-cxc-merma-cc25.spec.ts` (4 casos).**
- **UAT propio** (`docs/uat/cc25.md`): build de producción, base `ayr_local_e2e_cc25`.
  - 40 passed y, después de D-434..D-436, 32 passed, sin rojos.
  - El spec del menú, 8/8 junto con cc25.
- **UAT del dueño en demo: aprobado.**
  - Demo corrió con el código de `1c7cf7f1`, desde el worktree y con el `.env.demo` que copió el
    dueño.
  - No se reinició la rama `demo` y no se crearon ramas.
- **CI del PR, run 37417560178 sobre `39dfe852`:** en verde (lint, unitarios, E2E completo en el
  runner, smoke de Neon `ci` y Sonar).
  - El run anterior (`1c7cf7f1`) tuvo un rojo propio: el spec del menú de D-326 no conocía las
    dos entradas nuevas. Se corrigió en `a3bb5fee`.

## Ventana ejecutada (2026-10-06, 00:46–00:55 Lima) — **desplegada**

Se hizo con D-411 y D-437, sin OK por acción.

1. **Vuelta atrás anotada:** API `ayr-steel-erp-api-00088-kn4` (`git-sha=72ab61a2`) al 100 %, y
   `main` en `6d25cfea`.
2. **Migraciones:** 0 (sin archivos en `prisma/migrations` en el diff).
3. **API:** se desplegó
   `pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app`
   desde el worktree, limpio en `39dfe852`, con `AYR_ENV_SETUP` apuntando al checkout principal.
   - Revisión **`ayr-steel-erp-api-00089-8mf`**, con `git-sha=39dfe852`, al 100 %.
   - `/health` 200, directo y por `v2.mareliac.pe`.
4. **Merge del #109:** `main` = **`168b1438`**.
   - `git diff --quiet 39dfe852 origin/main -- apps packages …` dio exit 0: sin diff de runtime.
   - Vercel en `success` para `168b1438`.
5. **Verificación:**
   - `smoke:prod` 8/8 en `ayr-steel-erp-web.vercel.app` y 8/8 en `v2.mareliac.pe`.
   - Recorrido de solo lectura con el admin de `.env.setup` (login, GET y logout):
     - **CxC:** total S/ 914 365,2510, igual que las tarjetas de cobranzas, con 43 clientes y
       61 comprobantes. Por tramo: por vencer S/ 198 105,13; 1–30 S/ 647 309,60; 31–60
       S/ 68 950,52; 61–90 y más de 90 en 0. Los tramos y los dos vendedores suman el total. El
       Excel da 200.
     - **Merma de septiembre, Coberturas Aluzinc:** 42 bobinas. El consumo de 148 823,544 kg es
       igual al kardex de producción del rango. Teórico 149 795,412 kg, despunte 1 113,384 kg,
       merma sobre el estándar 141,516 kg (0,09 %). 7 bobinas pasan el 1 % y ninguna queda sin
       teórico.
     - **Merma de octubre (1 al 6), Coberturas Aluzinc:** 37 bobinas. El consumo de
       91 333,150 kg es igual al kardex. Merma −555,281 kg (−0,60 %), 6 producciones «Fuera de
       tolerancia» y 1 bobina pasa el 1 %.
     - **Drywall:** sin producción en los dos meses.
     - Una línea inválida da 400.
6. **Vuelta atrás:** no hizo falta. Si el dueño la necesita, son las dos juntas:
   `cmd /c gcloud run services update-traffic ayr-steel-erp-api --region us-central1 --project ayr-steel-erp --to-revisions ayr-steel-erp-api-00088-kn4=100`,
   y un commit de revert del merge `168b1438` en `main`.

Las salidas del deploy, de los dos smokes y del recorrido quedaron en `local-data/cc25/` del
checkout principal, que no está en git.

## Convivencia entre versiones

- **API nueva + web vieja** (entre el deploy y el merge):
  - la web vieja no conoce las rutas nuevas;
  - ventas por material ya no manda `roofingSalesPen`, y la web desplegada en cc24 lee
    `lineSalesPen`.
- **Web nueva + API vieja:** las dos pantallas nuevas darían 404. Por eso el orden fue API
  primero y después merge.

## Para el dueño: qué revisar en producción

Entrar como administrador en `https://v2.mareliac.pe`.

1. **Cuentas por cobrar:** `https://v2.mareliac.pe/reportes/cuentas-por-cobrar`.
   - El saldo total tiene que ser el de `/cobranzas`.
   - Abrir dos o tres clientes y seguir los enlaces al comprobante y al pedido.
   - Filtrar por vendedor y bajar el Excel.
2. **Merma de septiembre:**
   `https://v2.mareliac.pe/reportes/merma?from=2026-09-01&to=2026-09-30`.
   - Revisar las 7 bobinas en rojo (más del 1 % sobre el estándar).
3. **Merma de octubre:**
   `https://v2.mareliac.pe/reportes/merma?from=2026-10-01&to=2026-10-06`.
   - Abrir las bobinas con «Fuera de tolerancia»: son 6 producciones, con su motivo.
   - El −0,60 % del mes viene de esas producciones, que la bobina rindió por encima del teórico.
4. **Pendiente del repo:** borrar las ramas remotas `cc25-cxc-merma` y `docs/cierre-cc25`. El
   agente no puede: `git push --delete` está prohibido.
5. **Para decidir más adelante:** el reporte de producción (D-420), y el P2 de los rangos cortos
   de merma (D-435).

## Neon

Esta sesión no creó ni borró ramas, y no reinició `demo`. No listé las ramas: `neonctl` pide
confirmación y la sesión no lo necesitó. Siguen las 9 de cc24.
