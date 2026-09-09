# Handoff — Sesión Cierre de bobina — 2026-09-09

## 1. Resumen

Dos decisiones (**D-164, D-165**) que son una sola idea partida en dos: **separar la merma
normal de la anormal**. D-165 mete el 1 % que toda corrida pierde adentro de la densidad
estándar, así que deja de ser una sorpresa; D-164 hace que lo que quede por encima de eso salga
del inventario **al cerrar la bobina**, en vez de quedarse para siempre en el valorizado. Suma
`pnpm check:price-floor` (solo lectura) para decidir el aviso de mínimo en el POS, y la regla
dura 16 de `CLAUDE.md`.

`pnpm turbo lint typecheck test` en verde (**352/352** unitarios), `prettier --check` y
`eslint e2e` limpios. E2E local sobre base recién creada: **208 pasados, 14 fallos, 2
saltados**, y los 14 son las dos clases conocidas y ajenas a esta sesión.

**Nada desplegado y sin push**; producción no se tocó ni para leer.

---

## 2. Hecho

### M0 — El cierre de una bobina liquida su remanente (D-164)

**El defecto.** `CoilOperationsService.setStatus` (RF-19) cambiaba el estado a `CLOSED` y **no
movía un gramo de kardex**. El saldo teórico se quedaba en `inventory_balances` indefinidamente:
la bobina cerrada desaparecía de producción y del partido, pero **seguía sumando kilos y valor
al inventario valorizado** de material que ya no existe, y nada avisaba. La única herramienta
era la merma de RF-17, un acto aparte, en un botón vecino y sin relación con el cierre.

**La forma.** Cerrar pide ahora **cuántos kilos quedan de verdad** (`physicalKg`) y liquida la
diferencia en la misma transacción, por el único camino que el kardex admite
(`InventoryService.record`, regla dura 2) y nunca editando el saldo.

- `apps/api/src/coils/coil-close-math.ts` (+ spec de 7 casos) — la aritmética pura, aparte del
  servicio como `coil-split-math.ts`.
- `refType` propio **`CLOSE_ADJUSTMENT`**, migración `20260909230000_...`, aditiva.
- `CoilDto.avgCostPen` — el promedio vigente, para mostrar el remanente **valorizado** con el
  mismo número con el que el kardex lo va a sacar.
- `apps/web/.../coil-close-dialog.tsx` — muestra kg y soles antes de confirmar.
- Reabrir revierte el ajuste con un movimiento inverso. `cancelScrap` (RF-18) lo rechaza a
  propósito: es el mismo corte que D-057 ya había tenido que hacer.

**Tres decisiones que no eran obvias.**

1. **Se tipea cuánto queda, no cuánto se da de baja.** Es lo que planta ve mirando el rollo, y
   con un solo campo quedan cubiertos los dos sentidos: sobra saldo teórico → `OUT` (merma
   anormal), el conteo da de más → `IN` (sobrante).
2. **El kardex se mueve ANTES de marcar `CLOSED`.** `assertRawMaterialInvariant` lee el agregado
   desde la base: con la bobina ya cerrada, la salida se comprobaría contra un agregado que
   **acaba de perder ese rollo entero**. Es el mismo orden que ya respetaba el partido.
3. **`registerScrap` (RF-17) se queda.** Se evaluó retirarlo para no dejar dos caminos y **no
   conviene**: responden preguntas distintas y se deshacen distinto. RF-17 es la pérdida puntual
   durante la vida del rollo (borde oxidado, empalme fallado) y se anula por RF-18; el ajuste del
   cierre es el corte de cuentas y se deshace reabriendo.

### M1 — La merma normal del 1 % entra en la densidad estándar (D-165)

**Lo primero que se verificó:** el factor **no estaba en ninguna parte** — `grep` de `1.01` sobre
el repo entero, cero resultados. M1 no era verificar, era implementar.

Se aplica en **un solo lugar**, `standardDensityFactor` en `@ayr/shared`, dentro de las dos
únicas funciones que traducen geometría a kilos (`theoreticalKgPerPiece` y `kgPerMeter`), y
**nunca** editando `finishes.density_factor`: la densidad del acero es un dato físico y la merma
es una política de la empresa; multiplicarlos en el maestro deja un número que **nadie puede
volver a separar**, y cada acabado nuevo nacería sin el factor.

Entrando por un punto se mueven juntos los cuatro números que dependen de él: el kilo teórico del
reporte, el metro equivalente de una bobina, los kilos que reserva una cobertura a medida y el
costo por metro del piso de D-163. Centinela en `normal-scrap-factor.spec.ts`, que vigila **que
las dos cuentas apliquen el mismo factor** —lo que importa— y no la multiplicación.

### M2 — Query de solo lectura: SKU bajo el mínimo de D-163

`pnpm check:price-floor [--branch production|demo|dev|local|local-e2e]` →
`apps/api/prisma/price-floor-report.ts`. Es el número que falta para decidir si el mostrador
lleva aviso de mínimo: D-163 lo dejó **exento a propósito** y ponerle el piso sin medir antes
rompe ventas que hoy funcionan. Compara **valor contra valor** como `assertPriceFloor`; imprime
los precios con IGV, que es como el dueño los lee. **No toca el POS.**

### M3 — Regla dura 16 en `CLAUDE.md`

«Ningún texto largo pasa por la shell», con el incidente de la sesión anterior escrito. Es una
regla de **forma y no de criterio**: el daño no lo hace el comando que uno quiso correr, sino
otro que la shell arma sola con pedazos del texto. Se numeró 16 y no se insertó en el medio a
propósito: hay referencias vivas a «regla dura 15».

---

## 3. Decisiones tomadas

| ID        | Una línea                                                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-164** | Cerrar una bobina liquida su remanente como movimiento `CLOSE_ADJUSTMENT` en la misma transacción (`OUT` si sobra saldo teórico, `IN` si el conteo da de más); reabrir lo revierte, RF-18 no. |
| **D-165** | La merma normal del 1 % se absorbe en la densidad estándar, **en código y en un solo lugar** (`standardDensityFactor`), nunca tipeada en `finishes.density_factor`.                           |

RF actualizados: **RF-19** (el cierre liquida y exige declarar), **RF-17** (sigue siendo un acto
propio y distinto) y **RF-25** (el factor que se tipea es el físico).

---

## 4. Bloqueos y pendientes

### Lo que necesita acción tuya

- **Dar el OK para desplegar.** Está en local y **sin push**. La migración de D-164 va **antes**
  que el API nuevo (es aditiva, así que el API viejo contra la base migrada funciona igual).
- **Correr `pnpm check:price-floor --branch production`** y decidir el aviso de mínimo en el
  mostrador. Es solo lectura, pero contra la base real: no se corrió sin tu OK.
- **Revisar el 1 % con datos reales.** Lo fijaste como regla del cliente, sin datos detrás. Ahora
  que D-164 hace visible la merma **anormal**, con 2 o 3 cierres reales se puede comparar lo
  liquidado contra lo que el estándar ya absorbe. Queda abierto si conviene **por acabado**.
- **Avisar a planta antes del deploy:** cerrar una bobina ahora **pregunta cuántos kilos quedan**
  y da de baja la diferencia. Es el cambio más visible del día.
- **`docs/analisis/` sigue sin commitear**: es tuyo, viene de tres sesiones atrás y no se tocó.

### Anotado, no hecho

- **El diálogo de cierre no tiene E2E de UI.** Los nueve casos de D-164 son por API; ningún spec
  aprieta el botón «Cerrar» de `/bobinas/:id`, que es el único punto de la interfaz que emite una
  baja de inventario nueva.
- **Los pedidos ya confirmados reservaron kilos con la densidad vieja** y producción ahora
  consume ~1 % más. No revienta nada (`consumeReservationQty` recorta con `Decimal.min`), pero
  ese 1 % sale de stock libre y puede disparar el aviso de faltante de D-154 sobre pedidos que
  nadie tocó. Vale mirarlo el día del deploy.
- **Los fixtures de coberturas escriben ~70 kilos como literal.** Antes de tocar el 1 %, conviene
  convertirlos a `KG_PER_METER` (`e2e/helpers/roofing.ts`), o la próxima revisión del porcentaje
  vuelve a costar lo mismo. El detalle está en `docs/PROGRESO.md`, «El precio de D-165».
- **`theoreticalKgPerUnit` del catálogo** se muestra en el formulario de venta como «≈ N kg» y,
  con el 1 % adentro, el rótulo quedó ambiguo: es el material que consume, no lo que la plancha
  pesa. No corrompe nada; el texto merece una pasada.
- **El reporte de precios cuenta las coberturas a medida como «sin costo en el kardex»**, y el API
  sí les calcula piso por el agregado. Para la pregunta del POS no cambia la decisión —el
  mostrador no vende a medida— pero el total queda subestimado.
- **Las series manuales y `7f`** siguen igual que en los handoffs anteriores; no se tocaron.

---

## 5. Cómo verificar

```bash
pnpm turbo lint typecheck test build     # verde (352/352 unitarios)
pnpm exec eslint e2e
pnpm exec prettier --check apps packages docs CLAUDE.md scripts e2e

# **Antes de una tanda larga de E2E**, recrear la base de pruebas: los 409 de códigos al azar
# crecen con cada corrida y terminan tapando la señal (ver Notas operativas en PROGRESO.md).
docker exec ayr-local-db psql -U ayr -d postgres -c "DROP DATABASE ayr_local_e2e;"
docker exec ayr-local-db psql -U ayr -d postgres -c "CREATE DATABASE ayr_local_e2e OWNER ayr;"

# Y matar cualquier servidor viejo en :3000/:3001 — `reuseExistingServer` reusa el que
# encuentre, y con el API viejo los cambios no se ven. NO tocar :4000/:4001 (regla dura 15).
netstat -ano | grep LISTENING | grep ":300"

pnpm e2e cierre-bobina-d164        # los 9 casos nuevos de D-164
pnpm e2e planta-espacio            # 8/8, los que más movió D-165
pnpm e2e                           # completa: 208 pasados, 14 fallos conocidos

pnpm check:price-floor --branch local-e2e   # el reporte de M2 contra datos de prueba
```

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126).

### Checklist de deploy — sin correr, esperando tu OK

```bash
pnpm turbo lint typecheck test build && pnpm format:check && pnpm exec eslint e2e
pnpm db:prod     # incluye 20260909230000_d164_liquidacion_de_remanente_al_cierre
pnpm deploy:api
# Web: por push a main (integración Vercel-GitHub)
pnpm smoke:prod  # solo lectura (D-126)
```

**La migración va primero**, y el **API antes que el web**: `CoilDto.avgCostPen` es un campo
nuevo que la pantalla de la bobina usa para valorizar el saldo. Siguen pendientes además las
migraciones de las sesiones anteriores (D-145, D-146, las dos de D-153, la de D-154, la de D-157
y la de D-161).

**Lo que cambia para la gente el día del deploy:**

1. **Cerrar una bobina pregunta cuántos kilos quedan** y da de baja la diferencia como merma, con
   motivo obligatorio. Es lo más visible.
2. **Reabrir una bobina que liquidó devuelve esos kilos** y también pide motivo.
3. **Los kilos teóricos suben ~1 %** y el metro equivalente de un rollo baja otro tanto. Un
   pedido reserva un poco más de material que antes, a propósito.

---

## 6. Siguiente sesión

1. **Usar lo que se construyó**, que sigue siendo el pendiente de siete sesiones: cargar agosto
   con el importador, registrar sus comprobantes en modo manual (D-153) y producir esos pedidos
   desde `/planta` — ahora con los precios puestos (D-161..D-163) y la merma separada
   (D-164/D-165).
2. **Fase 8 — auditoría, reportes y UAT**, la siguiente según `docs/ARQUITECTURA.md` §3.7.
3. **Revisar el 1 %** con los primeros cierres reales, que es el pendiente explícito de D-165.
4. **7f sigue sin alcance escrito**, arrastrado desde hace siete handoffs.
