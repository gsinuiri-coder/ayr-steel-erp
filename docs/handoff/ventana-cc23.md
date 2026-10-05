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

## Ventana

Pendiente.
