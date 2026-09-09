# Handoff — Sesión Precios — 2026-09-09

## 1. Resumen

Tres decisiones (**D-161..D-163**) sobre cómo se pone un precio: la plancha de catálogo se
cotiza **por metro lineal**, «valor» y «precio» dejan de ser sinónimos (sin IGV y con IGV) y el
margen mínimo pasa de ser un número decorativo a un **piso duro** que ninguna cotización ni
pedido nuevo puede cruzar. Se verificó además el cierre de bobina con ajuste de remanente
(M2): **el flujo no existe** y se dejó la propuesta escrita sin implementar, como pedía el
alcance.

`pnpm turbo lint typecheck test` en verde (**341/341** unitarios), `prettier --check` y
`eslint e2e` limpios. E2E local: **69/69** de los specs afectados, con diez casos nuevos.

**Nada desplegado y sin push**; producción no se tocó ni para leer.

---

## 2. Hecho

### M0 — La plancha de catálogo se cotiza por metro lineal (D-161)

El defecto: se cobraba `cantidad × valor unitario` con un valor que el vendedor pensaba **por
metro**. Diez planchas de 3.60 m a S/ 7.00 el metro salían **S/ 70.00** en vez de S/ 252.00 —
3.6 veces menos, que es exactamente el largo del SKU.

Lo que se descartó importa tanto como lo que se hizo. La forma «natural» era pasar la línea a
metros, como una cobertura a medida. **No se hizo**: el kardex, la reserva, la producción y el
despacho de una plancha están en **planchas** (`roofing-production.service.ts` reporta
`piecesCount(pieces)` a stock para todo lo que no es a medida), y meterla en metros obligaba a
que un SKU en `NIU` llevara subítems de largo — justo lo que prohíbe la regla dura 14.

- `packages/shared/src/schemas/roofing.ts` — `sellsByFixedLength`, `fixedLengthUnitValue`,
  `fixedLengthValuePerMeter`, `fixedLengthMeters`.
- `apps/api/src/sales/sales-lines.ts` — la línea sigue en `NIU`, viaja `valuePerMeterPen` y el
  API calcula `unitPricePen = largo del SKU × valor por metro`. Mandar los dos es un 400.
- `apps/web/src/components/sales/sales-document-form.tsx` — bloque espejo del plan de corte de
  D-159: **largo bloqueado con el del SKU, solo la cantidad editable, sin filas que agregar**.
- Migración `20260909210000_d161_plancha_por_metro_lineal`, aditiva y nullable.

La familia de predicados de D-131 pasa a **tres**, y las tres devuelven `boolean`:

| Pregunta                                              | Función              | La decide                                       |
| ----------------------------------------------------- | -------------------- | ----------------------------------------------- |
| ¿La línea necesita el detalle de largos?              | `sellsByLength`      | la **unidad** (`MTR`)                           |
| ¿Se fabrica contra pedido desde bobina?               | `isMadeToMeasure`    | el **subtipo** (`A_MEDIDA`)                     |
| ¿El precio se negocia por metro contra un largo fijo? | `sellsByFixedLength` | **subtipo + unidad + largo** (`PLANCHA`, `NIU`) |

El centinela `apps/api/src/sales/sales-lines.spec.ts` cubre la tabla de las tres y los tres
pares cruzados. El más peligroso es `sellsByFixedLength` contra `isMadeToMeasure`: miran el
**mismo** campo y dan lo contrario.

### M1 — Valor contra precio, y el piso que la página de márgenes prometía (D-162, D-163)

**Lo primero que se verificó, antes de tocar nada:** la fórmula viva era **markup**
(`costo × (1 + margen)`) y **`minAllowedPrice` no tenía un solo llamador fuera de su propio
test**. D-032 escribía la regla —«un VENDEDOR no puede bajar del margen mínimo»— y no la
aplicaba en ninguna parte; `/configuracion/margenes` guardaba dos números que nadie leía.

**D-162** (`packages/shared/src/tax.ts`, módulo hoja nuevo): «valor de venta» es SIN IGV,
«precio de venta» es CON IGV. La fuente de verdad interna no se movió y no se migró un dato; lo
que cambia es que en la cotización se **tipea el precio con IGV** y el valor se deriva y se
muestra debajo. Barrido de rótulos en cotización, pedido, comprobantes, mostrador, el
importador y el PDF.

**D-163** (`apps/api/src/sales/price-floor.ts`): `mínimo = costo promedio ÷ (1 − margen
mínimo) × 1.18`, bloqueo duro **para todos los roles**. Tres cosas que decidieron la forma:

1. **Se compara valor contra valor, no precio contra precio.**
2. **Sin costo no hay piso** — un SKU que nunca entró al kardex se puede cotizar.
3. **El mismo código calcula el piso que se muestra y el que rechaza** (`computePriceFloors`
   alimenta el panel de stock; `assertPriceFloor` tira el 400).

El costo de una cobertura **a medida** sale de la bobina: `kg por metro × costo por kg
ponderado por kilos del agregado`. El promedio simple habría corrido el piso hacia el rollo más
chico.

### M2 — Cierre de bobina con ajuste de remanente: **el flujo no existe** (sin implementar)

Verificado y reportado sin tocar nada:

- `CoilOperationsService.setStatus` (RF-19) cambia el estado a `CLOSED` y **no mueve kardex**.
  El saldo remanente queda en `inventory_balances` indefinidamente.
- La herramienta existe pero es un acto **aparte**: `registerScrap` (RF-17) escribe un `OUT`
  valorizado al costo promedio. En la UI son dos botones vecinos y sin relación.
- Nada avisa del remanente al cerrar, y una bobina cerrada con saldo sigue sumando kilos y
  valor al inventario valorizado.

**Propuesta, esperando OK:** que «Cerrar» pregunte por el remanente cuando el saldo sea
distinto de cero y lo liquide **en la misma transacción**, vía `InventoryService.record` —`OUT`
si sobra material teórico, `IN` si el conteo real da de más—, con motivo obligatorio y
`operationDate` (D-124). Nunca una edición del saldo (regla dura 2). Queda por decidir el
`refType` (un `CLOSE_ADJUSTMENT` propio, distinguible del `SCRAP` de RF-17 para que su
anulación no se confunda — el mismo cuidado que ya obligó a separar la merma de proceso del
cierre de OP en `cancelScrap`) y si el ajuste positivo necesita ADMINISTRADOR.

### M3 — Pulido de formularios

- El botón ancho de «Agregar otro largo» pasa a un **`+` al costado de la última fila**
  (`components/production/length-editor.tsx` y el editor de la cotización). Medía lo mismo que
  los dos campos juntos y se leía como un campo más de la fila siguiente.
- El campo de largo del espacio de producción deja de ser `flex-1` y pasa a `w-32`.

### Lo que la revisión y los E2E encontraron

Dos bloqueantes, cuatro altos y una docena de menores. El detalle completo está en
`docs/PROGRESO.md`; los que más importan:

- **El precio mínimo que se mostraba no era tipeable.** Se muestra con dos decimales y el piso
  vive con cuatro: tipear el número de la pantalla caía por debajo y el sistema respondía «sube
  el precio» sobre el precio que él mismo pedía, en **cerca de la mitad** de las combinaciones.
  Lo resuelve `minTypeablePrice`, que **prueba el candidato contra la cadena de vuelta** en vez
  de redondear y confiar.
- **El cartel de rechazo de una plancha mostraba el mínimo por plancha rotulado «por metro»**:
  el mismo factor ×largo que D-161 vino a corregir, de vuelta en el mensaje de error.
- **`sellsByFixedLength` ignoraba la unidad.** Una `PLANCHA` en `KGM` es legal (hay SKU
  legados) y habría facturado el importe multiplicado por el largo.
- **Una cotización importada nacía exenta del piso pero no se podía volver a guardar.**
- **`PUT /sales/quotations/:id` borraba la marca de procedencia** junto con las observaciones,
  así que el **segundo** guardado de una importada rebotaba contra el piso. Lo conserva ahora
  `keepImportMarker`.

---

## 3. Decisiones tomadas

| ID        | Una línea                                                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-161** | La plancha de catálogo se cotiza **por metro lineal** y se cuenta en planchas: el API calcula el unitario con el largo del SKU, y `sellsByFixedLength` es la tercera pregunta de D-131. |
| **D-162** | «Valor de venta» es sin IGV y «precio de venta» es con IGV, en toda la app y en los PDF; en la cotización se tipea el precio y el valor se deriva. Sin migrar datos.                    |
| **D-163** | Piso duro de precio con el margen **sobre la venta** (`costo ÷ (1 − margen mínimo) × 1.18`), para todos los roles; el mínimo que se muestra es el que se puede tipear.                  |

RF actualizados: **RF-61** (plancha por metro, precio con IGV en el formulario y piso duro) y
**P-09** (resuelta por D-032, corregida por D-163).

---

## 4. Bloqueos y pendientes

### Lo que necesita acción tuya

- **Dar el OK para desplegar.** Está en local y **sin push**.
- **M2 — el ajuste de remanente al cerrar una bobina.** La propuesta está arriba; toca kardex,
  así que no se implementó sin tu OK.
- **¿Piso de precio en el mostrador?** Quedó **exento** a propósito: el carrito de caja no
  tiene dónde mostrar el mínimo, el cajero lo descubriría al cobrar con el cliente delante, y
  el rechazo tira abajo la transacción entera de D-099. Antes de esta sesión tampoco tenía
  piso, así que no se abrió nada nuevo. Si lo querés, hace falta mostrar el mínimo en el
  carrito y **medir antes cuántos SKU activos tienen `list_price_pen` por debajo** del piso
  nuevo, que es más alto que el de D-032.
- **Mirar los mínimos de `/configuracion/margenes`.** El cambio de fórmula es una decisión
  comercial y **los mínimos suben**: con 20% sobre un costo de 100, el markup daba 120 y ahora
  da 125. Los valores del seed (20% / 10%) no se tocaron.
- **`docs/analisis/` sigue sin commitear**: es tuyo, viene de dos sesiones atrás y no se tocó.

### Anotado, no hecho

- **El piso por kg de la venta de bobina entera no tiene E2E.** Está implementado
  (`minPricePen` en `/sales/sellable-coils`) y cubierto en unitarios; montar una bobina
  vendible entera cuesta una compra `COIL` más y no entró en esta tanda.
- **El costo se puede despejar del piso.** `minPricePen` viaja al formulario y el margen lo lee
  todo el equipo comercial, así que `costo = valor mínimo × (1 − margen)`. Es una contrapartida
  asumida por escrito en D-163: el vendedor tiene que ver su piso antes de tipear.
- **La suite completa sigue con 18 fallos ajenos a esta sesión**: nueve por `409 Ya existe un
proveedor con ese documento` (la base `ayr_local_e2e` envejecida) y nueve por el cupo de 50
  documentos de la cuenta demo de Nubefact. Los dos están anotados desde sesiones anteriores.
- **Incidente de método, sin daño:** un `node -e "..."` con backticks se lo comió la shell y
  disparó un `pnpm e2e` accidental que **vació `ayr_local_e2e` a mitad de otra corrida**. El
  comando falló al instante por un regex inválido y no llegó a correr tests, pero la corrida en
  curso se cortó y se relanzó limpia. La lección: los bloques largos para `docs/` van en un
  archivo y se insertan con un script, nunca por `node -e` con la shell de por medio.
- **Las series manuales, la corrección de un manual y `7f`** siguen igual que en el handoff
  anterior; ninguna se tocó.

---

## 5. Cómo verificar

```bash
pnpm turbo lint typecheck test build     # verde (341/341 unitarios)
pnpm exec eslint e2e
pnpm exec prettier --check apps packages docs CLAUDE.md scripts e2e

# **Antes de correr E2E**: matar cualquier servidor viejo en :3000/:3001 — `reuseExistingServer`
# reusa el que encuentre y el síntoma es `Login admin falló: 401`. NO tocar :4000/:4001.
netstat -ano | grep LISTENING | grep ":300"

pnpm e2e precios-d161-d163                       # los 10 casos nuevos
pnpm e2e fase7b-bordes fase7-consolidada         # los dos fixtures que el piso corrigió
pnpm e2e fase5a fase6 import-cotizaciones        # regresión de ventas e importador
```

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126).

### Checklist de deploy — sin correr, esperando tu OK

```bash
pnpm turbo lint typecheck test build && pnpm format:check && pnpm exec eslint e2e
pnpm db:prod     # incluye 20260909210000_d161_plancha_por_metro_lineal
pnpm deploy:api
# Web: por push a main (integración Vercel-GitHub)
pnpm smoke:prod  # solo lectura (D-126)
```

**La migración va primero.** Es aditiva —dos columnas nullable— así que el API viejo contra la
base migrada funciona igual; lo que rompe es el API nuevo contra la base sin migrar, porque
escribe `value_per_meter_pen`. Siguen pendientes además las migraciones de las sesiones
anteriores (D-145, D-146, las dos de D-153, la de D-154 y la de D-157).

**Lo que cambia para la gente el día del deploy**, y conviene avisarlo antes:

1. En la cotización y el pedido **se tipea el precio CON IGV**, no el valor sin IGV. Es el
   cambio más visible y el que más confunde si nadie lo dijo.
2. Una plancha de catálogo se cotiza **por metro** y la cantidad se escribe en su propio
   bloque, no en la columna de cantidad.
3. **Ninguna cotización ni pedido nuevo se guarda por debajo del mínimo**, tampoco para un
   administrador. El ajuste legítimo es cambiar el margen mínimo en Configuración → Márgenes.

---

## 6. Siguiente sesión

1. **Usar lo que se construyó**, que sigue siendo el pendiente de las seis sesiones anteriores:
   cargar agosto con el importador, registrar sus comprobantes con el modo manual (D-153) y
   producir esos pedidos desde `/planta`. Ahora además con los precios puestos como corresponde.
2. **Decidir M2** (el ajuste de remanente al cerrar una bobina) y, si va, implementarlo: es lo
   único de esta sesión que quedó escrito y no hecho.
3. **Fase 8 — auditoría, reportes y UAT**, la siguiente según `docs/ARQUITECTURA.md` §3.7.
4. **7f sigue sin alcance escrito**, arrastrado desde hace seis handoffs.
