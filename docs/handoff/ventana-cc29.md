# Ventana cc29 — Producción (prioridad 1)

## Resumen

- Dos cortes, sin migraciones, desplegados el martes 6 de octubre sin ventana (brief de cc29; el
  cliente no usa la app ese día).
- **Corte 1 (PR #118):** M1, drywall con la casilla de D-389. API `ayr-steel-erp-api-00095-q6m`
  (`git-sha=fc28720c`), `main` `8ce80ac8`, `smoke:prod` verde en los dos dominios.
- **Corte 2 (PR #119):** M2 reporte de producción y M3 sobrante de bobina terminada, completos.
  API `ayr-steel-erp-api-00096-zt9` (`git-sha=bb9cf2dc`), `main` `47f6e733`, `smoke:prod` 8/8 en
  los dos dominios.
- Decisiones: D-463..D-466 (del dueño), D-467..D-469 provisionales.

## Corte 1 — M1

- `ProductionService.report` (drywall) pasa `overrideBands` a `mountedKgForReport`: hasta el 1 %
  como siempre; pasado el 1 %, sin casilla, 400 con `TOLERANCE_OVERRIDE_REQUIRED` y las cifras (el
  mensaje sigue diciendo «consume otro fleje»); con la casilla entra, aviso fuerte pasado el 5 %, y
  lo que sale del kardex se topa en lo montado (la suma de los flejes de la orden).
- Motivos propios (`DRYWALL_TOLERANCE_OVERRIDE_REASONS`), acción de auditoría
  `production.drywall.report-tolerance-override` con los flejes del reparto, y la etiqueta «Fuera de
  tolerancia» en el detalle de la orden, la merma y el Panel (que ahora cuenta una vez un reporte de
  varios flejes, SM-1). El panel de `/planta` ofrece la casilla sin ir al API.
- Revisiones: autorrevisión 0 P0/0 P1, segundo modelo 0 P0/0 P1; P2 triviales corregidos.
- Tests: unitarios en verde; E2E locales 35 passed + el spec nuevo; CI verde (un rerun por
  `dashboards.db-spec`, que cuenta consultas con eventos asíncronos).

## Corte 2 — M2 y M3

- **M2, reporte de producción (D-464, D-468):** `ProductionSummaryService` arma el reporte con las
  salidas `PRODUCTION`/`SCRAP` vivas del rango (cuatro consultas, una sin movimientos); una fila por
  OP con el detalle por bobina, subtotal por pedido, corridas a stock al final; teórico por OP sin
  repartir; despunte de la OP y su reparto por bobina tal como lo registró el kardex; las salidas que
  no apuntan a un reporte, aparte (`unattributedKg`) para que el total cuadre con el kardex. Costos
  solo para el administrador; Excel de dos hojas con el tope de D-446. Menú «Reporte de producción»
  para administrador y planta; `docs/manual/menu-por-rol.md` y sus tests (33, 17 y 13 entradas).
- **M3, sobrante de bobina terminada (D-466, D-469):** reproducido primero (E2E
  `sobrante-bobina-cc29`: el sobrante declarado al terminarla se revertía al montarla). Arreglo:
  montar una terminada que reabierta queda en 0 pide el peso físico (`physicalKg`, una sola bobina,
  hasta su peso de alta, solo planta y administrador, solo si se fue por producción, merma o cierre);
  la diferencia entra como `CLOSE_ADJUSTMENT` de entrada con el costo de D-164 y `refId` = el consumo
  del montaje; la reapertura solo revierte ajustes con `refId` = la bobina; bajar la bobina sin usarla
  deshace el sobrante. Pares «montar con sobrante» y «bajar con sobrante» en `lock-order.db-spec`
  (20/20 sin conflicto contra despacho y anulación de compra). Aviso de cierre en coberturas: «Vuelve
  al almacén» y, pasado el 10 % de lo montado, «¿Sigue en el almacén para otra OP?».
- Revisiones: autorrevisión 0 P0, 2 P1; segundo modelo 0 P0, 1 P1. Corregidos los P1 (bobina vendida
  o partida; orden de bloqueos al bajar) y P2/P3 triviales. El resto, en PROGRESO.
- **Tests:** unitarios de API y web en verde; E2E locales con build de producción 30 passed y, tras
  las correcciones, 6 passed; `lock-order.db-spec` completo 22/22 local. La CI del PR #119 falló una
  vez en `lock-order.db-spec` (infraestructura del test: la fixture del agregado generaba espesores
  únicos de 0,05 mm y con los pares nuevos pasaba de 9,99 mm, el tope del SKU); con paso de 0,03 mm
  (más que la tolerancia de ±0,02) quedó verde (run 37542759411).
- **Ventana (18:13–18:25 de Lima):** vuelta atrás anotada `00095-q6m` / `8ce80ac8`; API
  `00096-zt9` con `git-sha=bb9cf2dc` al 100 % y `/health` ok; merge del #119: `main` = `47f6e733`,
  sin diff de runtime; Vercel en `success`; `smoke:prod` 8/8 en los dos dominios.
- Salidas: `local-data/cc29/` del checkout principal (deploys, smokes, logs de E2E y de CI).

## Decisiones

- D-463..D-466: decisiones del dueño al abrir cc29.
- D-467 (provisional): drywall no filtra el motivo por la dirección del exceso.
- D-468 (provisional): el reporte de producción se arma con el kardex del rango.
- D-469 (provisional): costo, `refId`, reversa, opciones de montar y aviso de cierre del sobrante.

## Para el dueño

1. **Revisar en producción** el guion de `docs/uat/cc29.md` (dos secciones, una por corte).
2. **Decisiones provisionales:** D-467 (drywall ofrece «Fleje más pesado»), D-468 (criterio del
   reporte de producción: kardex del rango, despunte en el rango de su fecha) y D-469 (costo del
   sobrante = el de D-164, no 0; `refId` al montaje; reversa al bajar; aviso solo en coberturas).
3. **Quedó fuera** (en PROGRESO con su id): A-2/SM-2 del corte 1 (la casilla no se compara con el
   exceso del momento, también en coberturas), A-3, A-5, A-6, SM-2 y SM-4 del corte 2, y los P3.
4. **Ramas:** `cc29-produccion` y `cc29-corte2` borradas con `gh api`; `docs/cierre-cc29` se borra al
   mergear este PR. Neon: no se creó ni se borró ninguna rama.
