# cc24 — Revisión de segundo modelo (Sonnet, contexto limpio)

Esta es la revisión de **segundo modelo** (Sonnet, contexto limpio) de la entrega cc24. **No
reemplaza la revisión del dueño** (AGENTS.md §2, regla 2): es una lista de riesgos, no una
aprobación. Solo lectura; no se tocó código.

## Diff revisado

`git diff cf9cc32..HEAD` en el worktree `ayr-steel-erp-cc24` (rama `cc24-reportes-linea`): 31
archivos, +1960 / −181. API (`sales-by-material.service.ts`, `sales-by-material.ts`,
`sales-by-product.ts`, `sales-margin.service.ts`, controlador, xlsx, PDF), `packages/shared`
(`report.ts`, `report-lines.ts`, `sales-by-material.ts`), web (ventas por material, ventas y
margen, bobinas, inventario valorizado), E2E `reportes-por-linea-cc24.spec.ts`,
`docs/ARQUITECTURA.md` (D-406..D-418), `AGENTS.md` y `.claude/settings.json`. Sin migraciones:
confirmado (no hay cambios en `apps/api/prisma`).

## Corridas

| Corrida                                 | Resultado                                 |
| --------------------------------------- | ----------------------------------------- |
| `pnpm exec jest src/reports` (apps/api) | 16 suites, 162 tests, todo verde          |
| `pnpm exec vitest run` (apps/web)       | 15 archivos, 96 tests, todo verde         |
| E2E                                     | No corrido (fuera de alcance del encargo) |

Limitación: los unitarios de `SalesByMaterialService` simulan `$queryRaw`; el SQL nuevo
(`productLines`, `declaredDispatches`, `inEngine`, `noLineSales`) solo lo ejercita el E2E, que no
se corrió aquí.

## Resumen por severidad

| Severidad | Cantidad |
| --------- | -------- |
| P0        | 0        |
| P1        | 0        |
| P2        | 3        |
| P3        | 5        |

No se encontraron errores de cálculo, de signo ni doble conteo en lo revisado. Verificado a mano:
signo de notas de crédito en las tres rutas (venta, `noLineSales`, productos); el cuadre de
productos (filas + no trazable + bobinas de otra pestaña = venta de la línea, incluido el parcial,
donde `sales·f + sales·(1−f) = sales`); que la venta de la línea en `productLines` usa el mismo
universo que `salesMargin` (vivos, sin archivados, sin guías, `issue_date` en rango); que la CTE
`cost` une `dispatch_items` por `COALESCE(reversal_of_id, id)` igual que `costsByOrder` y
`coilUsage` (un `OUT` y su reversa caen en el mismo ítem y se netean); que `addNoCostSales` solo
muta `lineTotals` en la rama que hace `continue` (no se cuenta dos veces); que el costo de venta no
cambia en «Ventas y margen»; que todo es `Decimal`/string; y que el endpoint sigue con
`@Roles(ADMINISTRADOR)`. Sin secretos ni datos reales en el diff (RUC, URLs, tokens: ninguno; las
rutas de `.env.setup` en `settings.json` son solo la ruta, no el contenido).

## Hallazgos

| #   | Sev. | Dónde                                 | Hallazgo                                                             |
| --- | ---- | ------------------------------------- | -------------------------------------------------------------------- |
| 1   | P2   | `.claude/settings.json` (líneas 8-60) | El cambio quita guardas que D-411 no nombra                          |
| 2   | P2   | `AGENTS.md:226`, `:346`, `:414`       | Texto contradictorio tras D-411                                      |
| 3   | P2   | `.claude/settings.json:23-25`         | La denegación de force-push se puede esquivar                        |
| 4   | P3   | `sales-margin.service.ts:533`         | `PARCIAL` se cuenta en la pestaña Servicios                          |
| 5   | P3   | `reports-xlsx.ts:239`                 | «Total del rango» no rotula que el margen es sin Servicios           |
| 6   | P3   | `sales-by-material.ts:359`            | Teórico de perfil asume unidad NIU                                   |
| 7   | P3   | `ventas-material-view.tsx:127`        | Filtros viejos en URL generan dos consultas en pestañas por producto |
| 8   | P3   | `reporte-bobinas-view.tsx:39-58`      | JSDoc huérfano y texto «Total general» ahora filtrado                |

### 1. P2 — `settings.json` baja guardas fuera de D-411

D-411 y AGENTS.md §3 regla 1 enumeran cinco acciones que dejan de pedir OK: merge a `main`, push a
`main`, `pnpm deploy:api`, `pnpm smoke:prod` y `update-traffic`. El diff además elimina de `ask`:
`Bash(rm -rf *)`, `Bash(git branch -D *)`, `pnpm deploy:web*` / `pnpm * deploy:web*`,
`Bash(git push *)` (genérico) y `Bash(git merge *)`, y las variantes con prefijo
`pnpm * deploy:api*` / `pnpm * smoke:prod*`. `rm -rf` y `git branch -D` no tienen relación con las
cinco acciones y la regla dura 3 / §3.3 trata los borrados como acción sensible. `deploy:web`
tampoco está en la lista de D-411. Escenario: un `rm -rf` o `git branch -D` se ejecuta sin
pregunta, contra la regla de que los borrados piden OK. **Arreglo:** restaurar en `ask`
`rm -rf *`, `git branch -D *` y `deploy:web`; o, si es intencional, nombrarlo en D-411 y en
AGENTS.md.

### 2. P2 — AGENTS.md se contradice con D-411

La regla 1 (párrafo nuevo) dice que merge/push a `main` ya no piden OK, pero `AGENTS.md:226`
(«solo se usa después del OK explícito del dueño exigido por D-232»), `:346` («Un merge o push a
`main` sigue el punto de control de D-232») y `:414` («No empujar ni mergear a `main` sin el
resumen y OK explícito de D-232») siguen diciendo lo contrario. Un agente futuro recibe dos
instrucciones opuestas; el propio archivo dice que manda AGENTS.md. **Arreglo:** reescribir esos
tres puntos para remitir a D-411 (con la ventana horaria) o anotar «salvo D-411».

### 3. P2 — Las denegaciones de force-push son parciales

`deny` tiene `git push *--force*`, `*--delete*` y `*-f *`. No cubre `-f` al final del comando
(`git push origin rama -f`: el patrón exige un espacio posterior), `git push origin +main`
(force por refspec), `git push origin :main` (borrado por refspec) ni `git push -d`. Con el `ask`
genérico de push retirado (hallazgo 1), esos casos pasan sin pregunta. El hook `pre-push` bloquea
destino `main` sin `AYR_OWNER_PUSH=1`, pero `AYR_OWNER_PUSH=1 git push origin main` ahora está
permitido de forma automática, de modo que la ruta menos protegida es la de los refspec.
**Arreglo:** añadir a `deny` `Bash(git push *-f)`, `Bash(git push * +*)`, `Bash(git push * :*)` y
`Bash(git push *-d*)`, o mantener `ask` para `git push *` salvo el patrón exacto permitido.

### 4. P3 — `partialOrderCount` en la pestaña Servicios

`sales-margin.service.ts:533`: con `inTotals` verdadero por `noCostView`, un pedido `PARCIAL`
(pendiente de despacho por otra línea) incrementa `partialOrderCount` en la pestaña Servicios,
donde el costo no se muestra; el contador de «costo parcial» no significa nada ahí. Arreglo:
`if (costStatus === 'PARCIAL' && !noCostView)`. D-412 solo habla de no comparable y no rastreable,
así que es un caso límite, no una violación.

### 5. P3 — Excel de «Ventas y margen»: la fila total no dice «sin Servicios»

`reports-xlsx.ts:239`: «Total del rango» muestra venta con Servicios y margen/% calculados sin
Servicios; la fila de Servicios va debajo con otra etiqueta. Quien lea solo esa fila ve
`margen ≠ venta − costo`. La pantalla sí rotula «Margen (sin Servicios)». Arreglo: rotular la fila
(«Total del rango (margen sin Servicios)»).

### 6. P3 — Teórico de perfil supone piezas

`sales-by-material.ts:359`: `perfilTheoreticalKg = qty × fracción × piece_weight_kg` es correcto si
la unidad de venta es NIU (la de Drywall hoy; ver `catalog.service.drywall.spec.ts`). Si un perfil
se vendiera en MTR, `qty` serían metros y el teórico saldría inflado. No hay guarda ni test de ese
caso. Arreglo: exigir `unit === 'NIU'` para calcular el teórico (si no, no trazable), o un test
que fije la restricción.

### 7. P3 — Filtros residuales en pestañas por producto

`ventas-material-view.tsx:127-130`: si la URL trae `espesor`/`color` (enlace antiguo) en
Coberturas (UPVC) o Reventa, `qs ≠ base` y se hacen dos consultas equivalentes (la API ignora esos
filtros), sin chips visibles para limpiarlos. Cambiar de pestaña los descarta (`keep`). Arreglo:
no agregar `thicknessMm`/`color` a `filters` cuando `byProduct`.

### 8. P3 — Comentarios de bobinas

`reporte-bobinas-view.tsx:39-58`: el JSDoc del reporte quedó huérfano (seguido de otro JSDoc, el de
`LINE_TABS`), y su texto «el total general sigue siendo el de todas» ya no vale con el filtro por
línea que ahora siempre se envía (la franja «Total general» es la de la pestaña). Arreglo: unir y
actualizar los comentarios; opcionalmente rotular la franja con la línea.

## Verificado sin hallazgo

- «Todas», Aluzinc y Excel: la ruta xlsx descarta `businessLine` y llama al mismo reporte de
  Aluzinc que antes; `IN_ENGINE` de C06 sigue siendo Aluzinc.
- D-409: `marginBase = totalSales − noCostSales`; sin Servicios el margen es el de antes;
  `totalSales` = Σ de «Totales por línea» también con pedidos excluidos (D-412).
- D-413: la bobina entera queda en la pestaña de su bobina; en Reventa solo en el cuadre.
- Permisos: `sales-by-material` y su xlsx con `@Roles(Role.ADMINISTRADOR)`; el esquema Zod
  rechaza líneas fuera de la matriz.
- URL/historial web: pestaña y mes en la URL, `keep` conserva rango/mes, URL inválida cae al
  defecto; cubierto por el E2E nuevo (no corrido aquí).
- Presupuesto de consultas: cinco en material, tres en producto (dos sin líneas), probado con
  mocks.
