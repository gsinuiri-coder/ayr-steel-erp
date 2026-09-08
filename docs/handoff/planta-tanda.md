# Handoff — Sesión Planta: integridad de producción y reporte en tanda — 2026-09-08

## 1. Resumen

Sesión de planta, no una fase. Los cinco puntos del alcance (M0..M4) están cerrados: el plan
de corte pasó a ser un **tope duro**, el kg consumido se captura por reporte como dato, hay
una pantalla para transcribir la hoja del turno entera, un botón que genera todas las órdenes
de un pedido de una vez, y una hoja de planta en PDF. Cuatro decisiones nuevas: **D-146** a
**D-149**.

`pnpm turbo lint typecheck test` en verde (**306/306**) y `pnpm format:check` limpio sobre todo
lo de esta sesión. E2E local (Docker) en tandas: **149 casos** con 3 fallas que no son del
código —las tres de `fase7b` que emiten contra el PSE demo y chocan con su cupo—, más
**26/26** en la revalidación de coberturas tras aplicar los hallazgos de la revisión.

**Nada commiteado ni desplegado hasta tu visto bueno.** Producción no se tocó en ningún
momento, ni para leer.

---

## 2. Hecho

### M0 — el plan de corte es un tope duro (D-146)

El hueco: la única cota de un reporte de coberturas era el **material montado**. Una orden de
100 ML con un rollo entero encima podía reportar 300 ML, y esos metros de más nacían
reservados a nombre del pedido (D-088) o entraban al almacén como stock que nadie encargó.

`RoofingProductionService.reportInTx` compara ahora el acumulado de los reportes **vigentes**
contra `Σ cantidad × largo` del plan y rechaza el exceso **sin tolerancia**: el borde exacto
entra, el milímetro siguiente no. Producir más sigue siendo posible por donde corresponde —
ajustar el plan (`PUT /production/roofing/:id/plan`) y recién después reportar.

**Los datos históricos que ya se pasaron del plan no se tocan ni se bloquean para lectura.** La
regla mira hacia adelante: un acumulado excedido deja el restante en cero y rechaza el reporte
**siguiente**. Hay un caso de regresión que lo fija.

- `packages/shared/src/schemas/roofing.ts` — `roofingPlanProgress`, `roofingPlanOverrun`,
  `remainingPlanPieces`.
- `apps/api/src/production/roofing-production.service.ts` — el tope, dentro de `reportInTx`.
- `apps/api/src/production/roofing-math.spec.ts` — 13 casos nuevos.

### M1 — kg consumido por reporte (D-146, segunda mitad)

`consumedKg` opcional en `POST /production/roofing/:id/report`. Se guarda en
`production_reports.consumed_kg` y **no toca el kardex**: la salida de la bobina sigue siendo
el kilo teórico de los largos (D-047). Elegiste esa semántica frente a la alternativa de que
reemplazara al teórico.

El tope es el kilo teórico del **plan completo** con la geometría del rollo montado —también
elección tuya frente a la más estricta—, así deja margen para el despunte real de cada
reporte. Y desde la revisión, **el cierre lo usa**: si planta declaró kilos reporte a reporte,
`close` los toma como valor por defecto en vez de asumir merma cero.

La tarjeta "Reportar largos rolados" de `/planta` muestra ahora **ML del plan, ML reportado,
ML restante y kg teórico del plan** en una fila compacta de cuatro cifras, y el layout se
rehízo: los campos estaban sueltos y desalineados.

- `apps/api/prisma/migrations/20260908180000_d146_kg_declarado_por_reporte/` — aditiva y nullable.
- `apps/web/src/app/(app)/planta/roofing-terminal.tsx`.

### M2 — "Reportar producción en tanda" (D-147)

`/planta/tanda`. Una fila por orden abierta (filtro de texto y `?pedido=<id>` para llegar
acotado). Por fila: orden, ítem, ML plan, ML reportado, ML restante, **ML nuevo** y **kg
consumido** opcional.

**Los largos no se tipean**: los deriva `piecesFromPlanMeters` del plan de la propia orden,
con una búsqueda **exacta** —no glotona— cuyo desglose se muestra bajo el input mientras se
escribe. Que sea exacta no es refinamiento: con un plan de `2 × 4.20 m` más `1 × 6.00 m`, el
reparto glotón no encuentra los 6.00 m aunque la respuesta exista. Cuando los metros no salen
de un número entero de planchas, la fila **falla en vez de redondear**.

`POST /production/roofing/batch` escribe las N filas en **una** transacción reusando
`reportInTx`, con un `SAVEPOINT` por fila, y devuelve el error de **cada** fila.

- `apps/web/src/app/(app)/planta/tanda/tanda-view.tsx`, `page.tsx`.
- `apps/api/src/production/roofing-production.service.ts` — `batchOrders`, `reportBatch`,
  `splitBatchRow`.

### M3 — "Generar todas las órdenes" desde el pedido (D-148)

`POST /production/roofing/from-sales-order/:id`: una OP por línea pendiente, en una
transacción. No cambia el modelo (**1 ítem = 1 OP** naciendo de su reserva, `CHECK` de D-145
intacto); lo que agrega es que un pedido de ocho líneas no pueda quedar con cinco en cola y
tres olvidadas. Las líneas de catálogo se saltan en silencio: su camino es la corrida a stock
(D-140). Sin reversa propia — anular una orden por separado ya existe (RF-33).

`planMeters` entra al DTO de la orden y al listado, así que la tarjeta de `/planta` muestra los
**ML a producir** sin abrir el detalle.

### M4 — hoja de planta en PDF (D-149)

`GET /sales/orders/:id/pdf-planta`, con `pdfkit` y el patrón del PDF de cotización (D-068):
número de pedido, cliente, fecha prometida y, por ítem, producto, cuánto producir, los largos
(`10 × 4.20 m`) y las medidas que deciden qué bobina se monta, más un pie para firmar. **Sin
ningún importe.** Se arma al vuelo y **no** se guarda en R2. Se descarga desde el pedido y, en
el teléfono, se comparte con la Web Share API.

- `apps/api/src/sales/plant-order-pdf.ts`, `apps/web/src/components/sales/plant-sheet-buttons.tsx`.

### Revisión de cierre

Dos pasadas de `revisor` (API+`shared` y `web`) y una de `qa`. Sin bloqueantes; los dos altos
del API y el alto del web se corrigieron en el mismo commit, junto con seis medios y ocho
bajos. El detalle completo está en `docs/PROGRESO.md`; los tres que más importan:

1. **La tanda escribía a medias antes de fallar** y las filas siguientes se validaban contra
   esa suciedad: una tanda retrofechada sin confirmar devolvía N errores fabricados. Corregido
   con un `SAVEPOINT` por fila.
2. **Las filas se bloqueaban en el orden del cliente** → deadlock entre dos tandas con las
   mismas órdenes. Ahora se ordenan por id.
3. **La tanda del web armaba el envío con las filas visibles**: escribir tres filas y después
   filtrar para buscar la cuarta dejaba las tres fuera, y el éxito borraba esos borradores.

`qa` agregó `e2e/tests/planta-tanda-ui.spec.ts`, el recorrido de la pantalla de punta a punta,
y no encontró ningún defecto de la app.

---

## 3. Decisiones tomadas

| ID        | Una línea                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D-146** | El plan de corte de una OP de coberturas es un **tope duro** (sin tolerancia), y el kg que planta declara por reporte es **dato observado**, no consumo: el kardex no lo toca. |
| **D-147** | Reportar producción **en tanda**: una fila por orden, un número de metros por fila, largos derivados del plan con búsqueda exacta, guardado todo o nada con error por fila.    |
| **D-148** | "Generar todas las órdenes" del pedido: una OP por línea pendiente **en una transacción**. No agrega capacidad, agrega atomicidad.                                             |
| **D-149** | Hoja de planta del pedido: PDF **sin importes**, armado al vuelo y **nunca guardado** — al revés que el PDF de la cotización, y por quién es el lector en cada caso.           |

Detalle largo en `docs/ARQUITECTURA.md` §0.2. RF afectados actualizados: RF-30, RF-31, RF-39
(reportar largos rolados y la tanda) y RF-63 (la hoja de planta).

---

## 4. Bloqueos y pendientes

### Lo que necesita acción tuya

- **Dar el OK para commitear y desplegar.** Nada está commiteado. El checklist está abajo.
- **Detuve tu dev server del API (`:3000`)** para poder regenerar el cliente de Prisma: tenía
  tomado `query_engine-windows.dll.node` y `prisma generate` fallaba con `EPERM`. Lo relevantás
  con `pnpm dev:local`.
- **`vercel login`** sigue pendiente para dejar `pnpm deploy:web` operativo fuera de un push.

### Anotado, no tocado

- `subset.json`, `e2e-report.json` y `docs/analisis/` siguen sueltos en el árbol, sin trackear
  y **sin cubrir por `.gitignore`**; los dos primeros rompen `pnpm format:check`. Vienen de la
  sesión anterior, que ya te los dejó anotados. **No hay que hacer `git add -A`** mientras
  estén ahí. Decidí no tocarlos porque son tuyos.
- `GET /production/roofing/batch` corta en 500 órdenes abiertas sin avisar que truncó. Con el
  volumen real está lejísimos y el filtro por pedido es la salida; si algún día importa, va
  como paginación con `hasMore`.
- **Sin cobertura**: el `<select>` de bobina de la tanda (exige dos rollos montados en la misma
  orden, que el guardrail de D-134 vuelve un escenario aparte), los errores por fila que vienen
  del servidor por UI (el cliente corre las mismas funciones, así que hace falta una carrera
  para provocarlos; están cubiertos por API) y el aviso de `MAX_BATCH_ROWS`.
- `e2e/tests/fase7e-ajustes-d121.spec.ts` usa el mismo `loginAsAdmin` que se puso intermitente
  en la corrida de `qa`, sin la holgura que ese archivo terminó necesitando: es candidato a la
  misma intermitencia en CI.

---

## 5. Cómo verificar

```bash
pnpm turbo lint typecheck test        # verde (306/306 unitarios)
pnpm exec eslint e2e                  # verde
pnpm exec prettier --check packages apps e2e docs   # verde salvo docs/analisis/, que no es de esta sesión

# E2E local (Docker). Correr en TANDAS CHICAS: el token de acceso dura 15 minutos y una
# corrida completa se cae con 401 a mitad de camino.
pnpm e2e planta-tanda planta-tanda-ui               # 7/7 — D-146..D-149
pnpm e2e fase6 fase6-bordes fase7final-m1 fase7final-op-a-stock   # 19/19 — sin regresiones
pnpm e2e fase4 fase4-bordes fase7d fase7e fase7e-ajustes-d121 fase7final-m0 fase7finalb-pedido-importado
```

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126): producción tiene datos reales.

### Checklist de deploy — listo, sin correr, esperando tu OK

```bash
# 1. Todo verde y commiteado; CI verde en GitHub Actions (D-123)
pnpm turbo lint typecheck test build && pnpm format:check && pnpm exec eslint e2e

# 2. Migración
pnpm db:prod            # aplica 20260908150000_d145_... y 20260908180000_d146_...

# 3. API
pnpm deploy:api

# 4. Web: por push a main (integración Vercel-GitHub); el CLI sigue con el token vencido

# 5. Verificación post-deploy, SOLO LECTURA (D-126)
pnpm smoke:prod
```

**El orden es seguro.** Las dos migraciones pendientes son **aditivas**: D-145 afloja un
`CHECK` y D-146 agrega una columna nullable. El API viejo corriendo contra la base ya migrada
funciona exactamente igual, así que no hay ventana de incompatibilidad entre el paso 2 y el 3 y
no hace falta que nadie deje de operar.

---

## 6. Siguiente sesión

1. **Fase 8 — auditoría, reportes y UAT**, que es la siguiente según `docs/ARQUITECTURA.md`
   §3.7 y la única fila que queda pendiente en el estado general.
2. **7f sigue sin alcance escrito** (renombres, pulido de cotización, página del importador):
   es lo mismo que quedó anotado en el handoff anterior y sigue necesitando que lo nombres vos.
3. Si retomás la carga de agosto: rehacer `demo` desde `production`, rehacer el JSON de
   decisiones, y recién ahí el dry-run.
