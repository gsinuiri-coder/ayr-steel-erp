# Ventana cc23 — Reportes por línea de negocio con pestañas en la URL

## Resumen

La sesión fue **desatendida**, con OK previo del dueño y UAT por defecto (D-397). El trabajo está
en el **PR #105**, rama `cc23-reportes-lineas`, abierta desde `main` `81cd656`.

Ventas y margen e inventario valorizado tienen una pestaña por línea de negocio, con «Todas»
primera y por defecto. La pestaña va en la URL (`?linea=`). **Sin migración.** El cambio toca la
API y la web.

## Paso 0 (solo lectura)

**Inventario de reportes antes de cc23:**

| Pantalla                          | Endpoint                                                                    | Líneas                                                             | Filtros en la URL                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `/reportes/inventario-valorizado` | `GET /reports/inventory-valuation` (+ `/xlsx`)                              | Todas mezcladas, con «Totales por línea» al pie                    | Ninguno. Lo plegado se guarda en `useState`                                                                       |
| `/reportes/ventas-margen`         | `GET /reports/sales-margin?from&to` (+ `/xlsx`)                             | Todas mezcladas, con «Totales por línea» y el grupo «Sin línea»    | Ninguno. El rango vivía en `useState` y refrescar lo perdía (→ D-401)                                             |
| `/reportes/ventas-material`       | `GET /reports/sales-by-material?from&to&kind&thicknessMm&color` (+ `/xlsx`) | Solo Coberturas Aluzinc (D-354)                                    | `range`, `from`, `to`, `tipo`, `espesor`, `color` con `useUrlState` (D-289: `router.replace`, no apila historial) |
| `/reportes/bobinas`               | `GET /reports/coils?month[&businessLine]` (+ `/xlsx`, `/pdf`)               | Todas. La API ya acepta `businessLine`, pero la pantalla no lo usa | Ninguno. El mes vive en `useState`                                                                                |

Las cuatro rutas JSON de costeo son `@Roles(ADMINISTRADOR)` (D-244). Bobinas admite además
SUPERVISOR_PLANTA con enmascarado.

**Costo de venta:**

- **Fuente (D-242):** los movimientos de kardex `refType='SALE'` de los despachos del pedido,
  con signo. La reversa resta.
- **Línea del costo (D-247):** la del producto despachado, no la del movimiento. Por eso la
  bobina revendida cae en Reventa.
- **Lo que se declara y no se estima:**
  - `NO_COMPARABLE` (D-243): hay comprobantes fuera del rango sin despacho declarado. Se
    muestra sin costo y fuera de los totales.
  - `PARCIAL`: hay facturado sin despachar. El costo es un piso.
  - `NO_RASTREABLE` (D-285): se despachó sin salida de kardex. Queda fuera de los totales.
  - Margen % `null` cuando la venta no es positiva (D-244).
- **Códigos de línea en SQL crudo:** se traducen con `fromDbLineCode`. El texto de la base es el
  identificador de `@ayr/shared` (D-245/D-250).

**Contradicciones con el brief, resueltas por la lectura conservadora:**

- «Reventa incluye la bobina entera» en inventario → D-403.
- Lo «sin línea» no tiene pestaña → D-398.
- «Sin exportación» frente al Excel existente → D-399.
- Servicios en el margen de «Todas» → D-404.

## Hitos

- **M1** (`45f4a32`): `useLineTab` y `LineTabs`, más la matriz en `@ayr/shared`. 9 unitarios con
  historial simulado: refrescar, retroceder, URL inválida, línea sin reporte, y elegir la misma
  pestaña no apila historial.
- **M2** (`d544658`): ventas y margen por línea, con «Todas» y Servicios sin costo. 6 unitarios
  nuevos, que incluyen que las pestañas más «Sin línea» suman «Todas».
- **M3** (`5bd24a5`): inventario valorizado por línea: kilos en las líneas con bobinas y
  unidades en UPVC y Reventa. Se agregó `totals.coilQtyKg`. 4 unitarios nuevos sobre la suma y
  el filtro.
- **E2E y ajustes** (`4e355d8`): `reportes-por-linea-cc23.spec.ts` (3 casos) y arreglos de la
  autorrevisión (P3-3, P3-8, P3-9).
- **Sacrificados, en orden estricto:**
  - M4 (ventas por material por línea): su motor es propio de Coberturas Aluzinc (D-354) y
    extenderlo pide trabajo de API aparte.
  - M5 (bobinas): sin M4 no se hace, porque se sacrifica desde el final. Además la pantalla de
    bobinas hoy no tiene filtro de línea que mover. Con D-393 (sin «Todas»), su pestaña por
    defecto sería Drywall, lo que cambia lo que ve hoy el supervisor. `COIL_REPORT_LINES` queda
    lista para esa pieza.

## Decisiones

Todas en `docs/ARQUITECTURA.md` §0.2.

- **Del dueño:** D-390..D-397.
- **Provisionales, pendientes del dueño:**
  - D-398: «Sin línea» no tiene pestaña. Las pestañas más «Sin línea» suman «Todas».
  - D-399: el Excel existente se conserva, solo en «Todas». La ruta ignora la línea.
  - D-400: sin «Material de OPs» ni «Totales por línea» en la pestaña de una línea.
  - D-401: el rango de ventas y margen pasa a la URL.
  - D-402: el inventario por línea puede apartarse de «Todas» hasta 0,0001 por línea, por
    redondeo.
  - D-403: la bobina con saldo se muestra en la línea que la compró, no en Reventa.
  - D-404: en «Todas», la venta de Servicios sigue sumando al margen con costo 0.

## Revisiones

**Autorrevisión** (`docs/revision/cc23-autorrevision.md`; subagente nuevo, es una lista de
riesgos y no una aprobación): 0 P0 y 0 P1.

- **Corregidos:**
  - P3-3: el test ya no suma `partialOrderCount`.
  - P3-8: las pestañas usan `activationMode="manual"`.
  - P3-9: `colSpan` según las columnas.
- **Anotados:**
  - P2-1: en la pestaña Servicios, la venta de servicios de un pedido mixto no comparable o no
    rastreable cae en esas secciones, con texto de costo.
  - P3-4: un comprobante de la línea sin despacho propio de esa línea muestra costo 0.
  - P3-5: el redondeo de inventario (→ D-402).
  - P3-6: la tarjeta «Bobinas (kg)» también aparece en «Todas».
  - P3-7: «Sin línea» con margen 100 %, que es previo a cc23.
  - P3-10: una bobina con línea UPVC o Reventa quedaría oculta. No existe hoy; la regla vive en
    la aplicación.
  - P3-11: lo mismo que D-403.

**Segundo modelo** (Sonnet, contexto limpio; `docs/revision/cc23-segundo-modelo.md`): 0 P0 y 0
P1.

- P2-1 (sin línea) y P2-3 (bobina de Reventa) son las provisionales D-398 y D-403.
- P2-2 (spec sin commitear) quedó corregido en `4e355d8`.
- **P3 anotados:**
  - P3-1: igual que P3-4 de la autorrevisión.
  - P3-2: igual que P2-1 de la autorrevisión.
  - P3-3: la venta de «Todas» sale del subtotal del comprobante y la de las pestañas, de sus
    líneas. Coinciden porque el subtotal es `sumLineTotals`, según la autorrevisión. El E2E lo
    comprueba contra la base de la suite.
  - P3-4: `COIL_REPORT_LINES` y `COIL_BUSINESS_LINES` son dos fuentes para el mismo conjunto.

## Bloqueos y pendientes

- **Decisiones para el dueño:** D-398..D-404 provisionales; M4 y M5 sin hacer.
- **Neon:** esta sesión no creó ni borró ramas.

## Cómo verificar

- **Unitarios:**
  - API, desde `apps/api`: `npx jest src/reports`.
  - Web, desde `apps/web`: `npx vitest run src/lib/line-tabs.spec.ts`.
- **E2E:** `pnpm exec playwright test e2e/tests/reportes-por-linea-cc23.spec.ts`, con una base
  propia.
- **Pantalla:** `docs/uat/cc23.md`.

## Convivencia entre versiones

- **API nueva + web vieja:** la web vieja no manda `businessLine`, así que todo sigue igual. El
  campo extra `coilQtyKg` se ignora.
- **Web nueva + API vieja:** la API vieja ignora `businessLine`, porque Zod descarta las claves
  desconocidas. Cada pestaña mostraría «Todas» con otro rótulo. Por eso el orden es API primero y
  después merge.

## Ventana ejecutada (2026-10-05, 04:06–04:15 Lima) — **desplegada**

La ventana se hizo con el OK previo del dueño (D-397), sin paradas por acción. **Estado final:
desplegado y sin vuelta atrás.**

Antes de entrar se verificó, a las 04:06:

- PR #105 abierto;
- CI 37284015576 sobre `cbed5aa` en verde: lint, typecheck y unitarios, E2E completo en el
  Postgres del runner, smoke de Neon `ci`, y Sonar con su quality gate;
- autorrevisión y segundo modelo sin P0 ni P1;
- UAT local escrito.

1. **Vuelta atrás anotada:** API `ayr-steel-erp-api-00086-ds5` (`git-sha=8abc4dc`) al 100 %, y
   `main` en `81cd656`.
2. **Migraciones en el PR:** 0. No hacía falta respaldo de Neon, y no se creó ni se borró
   ninguna rama.
3. **API:** se desplegó `pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app`
   desde `../ayr-cc23`, limpio en `cbed5aa`.
   - Revisión **`ayr-steel-erp-api-00087-pcg`**, con `git-sha=cbed5aa`, al 100 %.
   - `/health` 200.
   - `smoke:prod` 8/8 con la web vieja.
4. **Merge del #105:** `main` = **`999fd01`**.
   - `git diff --quiet cbed5aa origin/main -- apps packages Dockerfile …` dio exit 0: sin diff
     de runtime.
   - Vercel en `success` para `999fd01`.
5. **Verificación final:**
   - `smoke:prod` 8/8 en `ayr-steel-erp-web.vercel.app` y 8/8 en `v2.mareliac.pe`;
   - `/health` 200 por `v2.mareliac.pe/api/health`;
   - los reportes **no** se revisaron dentro de producción: no se creó un usuario propio ni se
     usaron otras herramientas (D-397).
6. **Vuelta atrás:** no hizo falta. Si el dueño la necesita, son las dos juntas:
   `cmd /c gcloud run services update-traffic ayr-steel-erp-api --region us-central1 --project ayr-steel-erp --to-revisions ayr-steel-erp-api-00086-ds5=100`,
   y un commit de revert del merge `999fd01` en `main`.

Las salidas del deploy y de los tres smokes quedaron en `local-data/cc23/` del checkout
principal, que no está en git.

## Para el dueño al despertar: qué revisar en producción

Entrar como administrador en `https://v2.mareliac.pe`.

1. **Ventas y margen, mes en curso:** `https://v2.mareliac.pe/reportes/ventas-margen`.
   - En «Todas», anotar la **Venta sin IGV** y el **Costo de venta** de la franja. Tienen que ser
     los mismos de ayer: «Todas» no cambió.
   - Abrir cada pestaña y comparar su Venta y su Costo con la fila de su línea en «Totales por
     línea» de «Todas»:
     - `…/reportes/ventas-margen?linea=drywall`
     - `…?linea=metallic-roofing`
     - `…?linea=roofing`
     - `…?linea=services`
     - `…?linea=trading`
   - La suma de las ventas de las pestañas, más la fila «Sin línea» si la hay, tiene que dar la
     Venta de «Todas».
   - En Servicios tiene que decir «Sin costo registrado».
2. **Ventas y margen, un rango con historia:**
   `https://v2.mareliac.pe/reportes/ventas-margen?from=2026-09-01&to=2026-09-30` y sus pestañas
   (`&linea=…`). Es la misma comparación, con un mes cerrado.
3. **Inventario valorizado:** `https://v2.mareliac.pe/reportes/inventario-valorizado`.
   - Anotar el **Total** de «Todas».
   - Abrir `?linea=drywall`, `?linea=metallic-roofing`, `?linea=roofing` y `?linea=trading`. El
     Total de cada una tiene que coincidir con su fila de «Totales por línea», y la suma de las
     cuatro con el «Total general» (hasta 0,0001 por línea de redondeo, D-402).
   - En Drywall y Coberturas Aluzinc, la tarjeta **Bobinas (kg)** tiene que coincidir con la
     suma de «Saldo (kg)» de su tabla de bobinas.
4. **Comportamiento:**
   - refrescar en una pestaña la conserva;
   - retroceder vuelve a la pestaña anterior;
   - `…/reportes/ventas-margen?linea=acero` cae a «Todas» y limpia la URL;
   - el Excel solo aparece en «Todas».
5. **Decidir las provisionales D-398..D-404** y si se hace M4/M5 en otra pieza.
