# Ventana cc47 — Correcciones 07: estándar de tablas, reportes, Cobranzas, menú y Panel

2026-10-11, noche de Lima, sesión en modo continuo. Ventana suspendida (D-533). Solo web: sin API, sin
migraciones, sin SQL contra producción. D-612 a D-622 nuevas, provisionales hasta que el dueño las
ratifique (D-612 a D-618 las decidió el dueño el 11/10 y se registran tal cual).

## En producción

| Corte       | Qué                                     | Resultado                                               |
| ----------- | --------------------------------------- | ------------------------------------------------------- |
| A (muestra) | merge de PR #182 (`3d9fde52`), solo web | Vercel en verde; `smoke:prod` verde en los dos dominios |
| B (resto)   | merge de PR #183 (`ed70858a`), solo web | Vercel en verde; `smoke:prod` verde en los dos dominios |

- La API no cambió (sigue `00117-7pm`, `git-sha=6cb372ce`).
- Vuelta atrás: revertir el merge del corte que haga falta (Vercel publica la web de `main`).

## Qué entró

| Pieza                                                                         | Decisión     | Dónde                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Menú sin «Órdenes de producción» ni «Colores» (siguen en la ruta y en «Ir a») | D-612, D-619 | `lib/nav.ts` (`OFF_MENU_SCREENS`), `breadcrumb.ts`, `go-to.ts`, `docs/manual/menu-por-rol.md`                                                                                        |
| Sin el pie gris de las listas                                                 | D-613        | 7 listas; `components/list-footer.tsx` borrado                                                                                                                                       |
| «Bobinas» solo en las líneas con bobinas                                      | D-614        | `inventario/inventario-view.tsx`                                                                                                                                                     |
| Línea estándar y modal de filtros                                             | D-615, D-620 | `components/table-toolbar.tsx`, `reports/report-period.tsx` (`PeriodFields`, `MonthFields`; se borraron `PeriodPicker` y `MonthPicker`), `status-filter.tsx` (`StatusFiltersButton`) |
| Estructura única de reportes                                                  | D-616        | los 7 reportes                                                                                                                                                                       |
| Una tabla por página, en pestañas con la URL                                  | D-617        | `lib/use-url-tab.ts`; Cobranzas, Inventario, Inventario valorizado, Reporte mensual de bobinas                                                                                       |
| Cobranzas «Por cliente» sin buscar; solo administrador                        | D-621        | `cobranzas/cobranzas-view.tsx`                                                                                                                                                       |
| Panel sin «Cotizaciones sin stock disponible»                                 | D-618        | `page.tsx`, `panel-today.tsx`; `stock-shortages-card.tsx` borrado                                                                                                                    |
| Lo que queda fuera de la línea                                                | D-622        | Caja, historial de Planta, listas sin nada que filtrar; pestañas de vista de Bobinas; ítem y método del Kardex                                                                       |

## Paso 0 (solo lectura)

El inventario completo está en `local-data/cc47/INVENTARIO.md` (en el checkout principal).

- El pie gris estaba en 7 listas.
- Páginas con más de una tabla principal: Cobranzas, Inventario, Inventario valorizado, Reporte mensual
  de bobinas y Caja.
- «Bobinas» en UPVC y Reventa salía vacía por construcción: ninguna bobina puede nacer en esas líneas
  (D-116 y D-119). No hubo parada.
- Nadie quedaba sin camino a las órdenes ni a los colores.

## Pruebas

- **Corte A:**
  - Lint, typecheck y 317 unitarios de la web, más `use-url-tab.spec.ts`, que Sonar pidió por la
    cobertura de código nuevo.
  - E2E locales en modo dev (base `ayr_local_e2e_cc47`): 38 de 41; repetidos, 20 de 21.
  - CI en verde: E2E en 2 shards, smoke de Neon `ci`, drift y Sonar.
- **Corte B:**
  - Lint, typecheck y 323 unitarios (incluye el de `useUrlTab` en el navegador, que pidió Sonar).
  - E2E locales en modo dev (base `ayr_local_e2e_cc47b`): 51 de 54; repetición aislada, 27 de 27.
  - CI en verde.
- **Rojos locales:** todos de modo dev. Son compilación en frío y la carrera ya conocida entre la URL
  inválida y la fecha completada, en `reportes-por-linea-cc23` y `-cc24`, que pasan en la CI y al
  repetirlos solos.
- **Spec nuevo:** `e2e/tests/estandar-tablas-cc47.spec.ts`. Cubre Cobranzas (pestañas, buscar y modal
  en la URL, Excel, refrescar, retroceder, foco y Esc), Ventas y margen, inventario sin bobinas, la
  ausencia del pie gris, la línea estándar en las 18 pantallas y las pestañas del corte B.
- **Capturas** antes, después y lado a lado, a 1366 y 1920, en `local-data/cc47/capturas/`. Las cifras
  de arriba son iguales antes y después.

## Revisión

Autorrevisión (subagente sin el handoff) y segundo modelo Sonnet por corte
(`docs/revision/cc47-a-segundo-modelo.md` y `cc47-b-…`), sin P0.

- **A:**
  - P1: dos E2E que iban a quedar en rojo (el Panel ya no pide `stock-shortages`; «Historial de
    órdenes» solo está en la lista de Planta). Corregidos.
  - P2: aserciones ambiguas o con fecha fija. Corregidos.
  - P3 tomados: el vendedor ya no ve la pestaña «Por cliente», que le daba 403.
- **B:**
  - P2: el atajo del periodo no se recordaba en Ventas por material, y había E2E que pasaban siempre.
    Corregidos.
  - P3 tomados: «Aplicar» sin cambios no vuelve a la página 1; la pestaña parte de la URL del momento
    del clic; un espesor inválido no cuenta como filtro.

## Fuera de alcance / para la próxima sesión

- D-612 a D-622 pendientes de ratificación.
- **Pieza de API:**
  - Buscar en Cobranzas «Por cliente».
  - Que el PDF del Reporte mensual de bobinas reciba el buscar.
  - Retirar `GET /sales/quotations/stock-shortages` y la invalidación `quotation-stock-shortages` de la
    web.
- **Para que el dueño decida:**
  - Si las listas sin nada que filtrar llevan algo encima de la tabla.
  - Si Caja pasa a pestañas.
  - La altura de la tabla en los reportes con «Totales por línea» a 1366×768: queda en 240 px, el
    mínimo del scroll único de D-547.
- **Sacrificable no hecho:** la tabla del Reporte mensual de bobinas más ancha que la pantalla. Pide
  cambiar columnas.
- **Entorno:** `dev:preview` del dueño en 4000/4001 sin tocar; `ayr_local` solo leída por las capturas.
  Neon sin ramas nuevas.
