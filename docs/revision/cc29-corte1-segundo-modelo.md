# cc29, corte 1 (M1): revisión de segundo modelo

Alcance: `git diff ecb4886a..HEAD` (API, shared, web, e2e). Sin P0 ni P1. Se leyó el código y los specs; no se corrió nada contra producción ni se leyó `.env*`.

## Qué se verificó y está bien

- `mountedKgForReport` con `overrideBands` en drywall: 0 kg montados cae en el rechazo sin código (`available <= 0`), y la UI lo trata igual (`toleranceExcess === null` → `overCapacity`). Paridad UI–API correcta.
- Bordes: el 1 % exacto no pide casilla (`excess.gt(tolerance)`); el 5 % exacto no es `severe` (`gt`). El redondeo del porcentaje es hacia arriba. Varios flejes: el tope es la suma de `remainingKg` y `allocateStripKg` reparte en orden de montaje.
- Idempotencia: la clave se reclama dentro de la transacción antes de tocar nada; en la UI la clave se regenera con el cuerpo (`submitKey.current(JSON.stringify(body))`).
- Consumidores de la auditoría: se cubrieron los tres que leen la acción de coberturas (detalle de la orden, `CoilWasteService`, y por extensión el Panel). No queda ningún otro lector de `production.roofing.report-tolerance-override` en `apps/`, `packages/` ni `e2e/` fuera de la propia constante.
- Los reportes revertidos no entran al reporte de merma (`reversalOfId: null, reversals: none`), así que una casilla de un reporte anulado no infla la etiqueta.
- Regresión en coberturas: el camino de coberturas no cambia (`toleranceOverrideLabel` y su esquema se conservan; el default de `ToleranceOverrideRow` sigue siendo el de coberturas). `readToleranceOverrideAudit` rechaza un motivo de coberturas con la acción de drywall y viceversa, y hay test de ello.

## Hallazgos

### SM-1 (P2) El Panel cuenta dos veces un reporte de drywall que salió de varios flejes

- `apps/api/src/reports/admin-dashboard.ts:83-92` y `apps/api/src/reports/coil-waste.ts:226`.
- `outOfTolerance` se asigna por `reportId` a cada fila-bobina del reporte de merma. Un reporte de drywall con casilla que repartió su salida en 2 flejes (el caso normal cuando se topa en «la suma de flejes») aparece como una producción marcada en cada una de las dos filas. `productionCount` suma `r.productions.filter(...)` por fila, así que el tile «Fuera de tolerancia (mes)» muestra 2 para un solo reporte, y `coilCount` 2. En coberturas esto era raro (un reporte, una bobina); en drywall, con varios flejes por orden, deja de serlo.
- Corrección sugerida: en el Panel contar `reportId` distintos por línea (`new Set(...)`), dejando `coilCount` como está. Añadir un test de `admin-dashboard` con un reporte repartido en dos filas. El spec de `coil-waste.service.spec.ts` agregado solo prueba una bobina, por eso no lo detecta.

### SM-2 (P2) La API no comprueba que la casilla corresponda al exceso real del momento

- `apps/api/src/production/production.service.ts:643-664`.
- La UI protege con `forExcessKg` (un 3 % confirmado no sirve para otro exceso), pero el cuerpo que viaja no lleva ese exceso. Con dos operadores sobre la misma orden, el segundo puede tener la pantalla mostrando 2,4 % con la casilla marcada y que el reporte, para cuando llega, sea de un 40 %, porque otro reporte consumió los flejes en el medio: el API acepta cualquier casilla, sin tope (D-389), y baja lo montado a 0. Es el mismo defecto latente que coberturas, pero allí hay borrador y una vista previa recalculada; drywall reporta directo, sin esa segunda pasada.
- Corrección sugerida: que `toleranceOverride` (o el cuerpo) incluya `excessKg` visto y que el servicio rechace con 409 y las cifras nuevas si difiere de `excess.excessKg`. Si el dueño decide aceptar el riesgo (D-389 ya aceptó «sin tope»), dejarlo escrito en D-465/D-467.

### SM-3 (P3) «Fleje más pesado» se ofrece y se acepta para un exceso hacia arriba

- `packages/shared/src/schemas/production.ts` (`DRYWALL_TOLERANCE_OVERRIDE_REASONS`) y test `drywall-tolerance-override.spec.ts` («HEAVIER_STRIP» con la casilla).
- El exceso solo existe cuando el teórico pasa lo montado, o sea que el fleje rindió más de lo declarado: un fleje «más pesado» lo explicaría, no lo contradice, así que en drywall la dirección sí cuadra. Solo se deja constancia: la asimetría con coberturas (D-389 filtra `HEAVIER_COIL`) está documentada en D-467 y es intencional; no es un defecto. Sin acción.

### SM-4 (P3) Texto de coberturas en el aviso fuerte de drywall

- `apps/web/src/app/(app)/planta/tolerance-override.tsx` (bloque `excess.severe`): «revisa cantidad, largo y bobina antes de confirmar». En drywall no hay largo ni bobina (son flejes y piezas); el mensaje del API (`mountedKgForReport`) tiene el mismo texto. Sugerencia: parámetro `severeHint` en `ToleranceOverrideRow`, o dejarlo si el dueño lo prefiere genérico.

### SM-5 (P3) Mensaje de rechazo con dos instrucciones seguidas

- `apps/api/src/production/production.service.ts:652-656`. Sobre el mensaje con código se añade «Si el fleje montado no alcanzó, consume otro fleje antes de reportar.» a continuación de «marca la casilla y elige el motivo.». Sirve a la UI (que no muestra el mensaje y ofrece la casilla), pero a un cliente de API le llega un texto con dos caminos sin criterio para elegir. Mejor: añadir el sufijo solo en el caso sin código, y dejar el del código tal cual.

### SM-6 (P3) Estado de la casilla de drywall no se limpia al cambiar de orden

- `apps/web/src/app/(app)/planta/drywall-order-panel.tsx:83-86`. `override` y el ref `toleranceToSend` viven en el panel; si el componente se reutiliza para otra `orderId` sin remontar, una casilla marcada con el mismo `excessKg` valdría para la otra orden (la guarda `forExcessKg` hace esto improbable pero no imposible). Además `toleranceToSend.current` se asigna durante el render. Sugerencia: `key={orderId}` en el panel (o reset en un efecto) y leer el valor en el callback en vez de un ref mutado en render.

### SM-7 (P3) Tests: faltan los bordes exactos

- `drywall-tolerance-override.spec.ts` prueba 0,99 % y 1,97 %, y 10,72 %, pero ningún caso exacto en 1 % ni en 5 %, ni «0 kg montados con casilla» (debe seguir rechazando sin código), ni un reporte con un fleje a medias (`consumedKg > 0`). Son cálculos con `gt` correctos hoy, pero la regresión de `gt` a `gte` pasaría el suite. Añadir esos tres casos baratos.
- El E2E no hace ningún `expect` sobre el conteo del Panel (de ahí que SM-1 no se vea).

## Veredicto

Aprobado con reservas: no hay P0/P1. SM-1 y SM-2 conviene resolverlos (o aceptarlos por escrito) antes del deploy; el resto es opcional. La lógica de bandas, el tope en lo montado, la auditoría propia y su lectura en detalle de la orden y reporte de merma son correctos y están cubiertos.
