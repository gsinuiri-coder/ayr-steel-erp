# cc29, corte 1 (M1: casilla de D-389 en drywall): autorrevisión

> **Autorrevisión.** La escribió un subagente nuevo de la misma sesión, que no leyó el handoff de
> implementación. Es una **lista de riesgos, no una aprobación**, y no vale como pase cruzado
> (AGENTS.md §2.2).

- Alcance: `git diff ecb4886a..HEAD -- apps packages e2e` (commit `95c69100`), con la intención
  tomada de las filas D-465 y D-467 de `docs/ARQUITECTURA.md` §0.2.
- Unitarios corridos: `drywall-tolerance-override.spec.ts`, `tolerance-override-*.spec.ts` y
  `coil-waste.service.spec.ts`: 5 suites, 78 tests en verde. El E2E no lo corrí.

## Lo que se revisó y no tiene hallazgo

- **El tope y el reparto.** `mountedKgForReport` recibe la suma de `assignedKg − consumedKg` de los
  flejes no liberados, leída después de `lockOrder`. Con la casilla devuelve `kg = available` y
  `allocateStripKg` vacía los flejes en orden de montaje. Nunca sale del kardex más de lo montado,
  la salida pasa por `InventoryService.record` y los bloqueos van por `lockInOrder` antes de la
  primera salida (regla 17).
- **Las ramas sin casilla.** Si `available ≤ 0`, el rechazo no lleva código y el mensaje dice
  «consume otro fleje». Pasado el 1 % sin casilla, el 400 lleva `TOLERANCE_OVERRIDE_REQUIRED` y
  las cifras. Una casilla dentro del 1 % no deja rastro (`overridden` es false).
- **La auditoría.** `drywallToleranceOverrideAuditAfter` escribe `reportId`, `reason`, `detail`,
  `differenceKg` y `differencePct`, que son las claves que lee `toleranceOverrideAuditSchema`.
  `readToleranceOverrideAudit` elige el schema según la acción, y un motivo de coberturas con la
  acción de drywall se descarta (tiene test).
- **Los consumidores.** Un grep de `report-tolerance-override`, `TOLERANCE_OVERRIDE_AUDIT_ACTION`
  y `toleranceOverrideAuditSchema` da tres lectores de la etiqueta: el detalle
  (`reportToleranceOverrides`), la merma (`CoilWasteService`) y el Panel. El Panel suma la merma
  de `COIL_REPORT_LINES`, que incluye DRYWALL, así que hereda el cambio. Los tres leen ya las dos
  acciones. `productionReport` es la misma tabla para las dos líneas.
- **Coberturas.** `ToleranceOverrideRow` conserva por defecto los motivos `_OVER`, sus etiquetas
  y «la bobina queda en 0». En `overrideInput`, el tipo del estado se ensanchó, pero un motivo de
  drywall no pasa `toleranceOverrideSchema` y queda en `null`. No veo regresión.
- **La idempotencia.** La clave ahora se toma por la huella del cuerpo
  (`submitKey.current(JSON.stringify(body))`), así que cambiar las piezas, la fecha, el
  `confirmBackdate` o la casilla regenera la clave, como pide §3.4. Antes no se regeneraba.
- **El tipo del DTO.** `productionReportSchema.toleranceOverride.reason` pasa a
  `ANY_TOLERANCE_OVERRIDE_REASONS`, y el detalle solo pinta `label` y `excessPct`.

## Hallazgos

### A-1 · P2: la UI no se refresca cuando el API pide la casilla y la pantalla no la ofreció

`apps/web/src/app/(app)/planta/drywall-order-panel.tsx:163` (el `onError` de `report`).

**Escenario.** Planta tiene el panel abierto con datos viejos: otra sesión reportó contra la misma
orden, o se cambió el peso por pieza del SKU. Con esas cifras la UI calcula que el reporte está
dentro del 1 %, así que no muestra la casilla y deja guardar. El API, con las cifras reales,
responde 400 `TOLERANCE_OVERRIDE_REQUIRED`. El `onError` solo muestra el toast; no invalida la orden
ni lee `excess` del error. La pantalla sigue sin la casilla, cada reintento da el mismo 400 y planta
queda trabada hasta recargar o volver a enfocar la ventana. El panel de coberturas sí lo maneja
(`roofing-order-panel.tsx:395`: con ese código llama a `invalidate()`).

**Corrección.** En el `onError`, si es `ApiError` con `code === TOLERANCE_OVERRIDE_REQUIRED`,
llamar a `invalidate()`, igual que coberturas. Opcional: un E2E que cambie `pieceWeightKg` con el
panel abierto.

### A-2 · P2: el API acepta la casilla para un exceso distinto del que se confirmó

`apps/api/src/production/production.service.ts:646-662` y
`packages/shared/src/schemas/production.ts` (`drywallToleranceOverrideSchema`).

**Escenario.** La UI confirma la casilla para un exceso de, por ejemplo, 2,4 %. Para eso guarda
`forExcessKg` y la anula si el exceso cambia; el comentario de `ToleranceOverrideState` lo dice:
«un 3 % confirmado no puede pasar como un 90 %». Esa defensa vive solo en el cliente. Si entre el
render y el POST otro reporte de la misma orden consume flejes, el exceso real en el servidor
puede ser del 60 %. El API recibe `toleranceOverride` sin cifra, lo acepta, vacía los flejes y
valoriza las piezas por una fracción de su material: es el margen inflado que D-249 quería
evitar. En drywall la ventana es real, porque el reporte es directo y sin borrador. Coberturas
tiene la misma forma, así que el riesgo no es nuevo, pero acá se extiende a otra línea.

**Corrección.** Que la casilla viaje con el exceso confirmado (`confirmedExcessKg`) y que el
servicio rechace con `TOLERANCE_OVERRIDE_REQUIRED` si no coincide con `mounted.excess.excessKg`.
Si se considera fuera de alcance, registrarlo como riesgo aceptado en la fila de D-465.

### A-3 · P2: el panel ya no dice «consume otro fleje» y empuja a la casilla cuando falta montar material

`apps/web/src/app/(app)/planta/drywall-order-panel.tsx:247-253`, `:362-375`;
`apps/web/src/app/(app)/planta/tolerance-override.tsx:106-117`.

**Escenario.** El caso más común en drywall es que el operario reporte la tanda entera con un solo
fleje montado de los dos que necesita. Antes de este cambio, todo exceso mayor al 1 % deshabilitaba el
botón con «solo alcanza para N piezas: consume otro fleje antes de reportar». Ahora ese texto solo
sale cuando `available ≤ 0`. En el resto de los casos aparece la casilla con «se descuentan los …
montados y los flejes quedan en 0», sin mencionar que se puede montar otro fleje. El API sí lo
agrega a su mensaje («Si el fleje montado no alcanzó, consume otro fleje…»), pero la UI nunca lo
muestra, porque decide sin ir al API. Con un 50 % de exceso y «Otro», el reporte entra: el primer
fleje queda en 0, el segundo sigue con stock que en realidad ya se usó y las piezas entran a la
mitad del costo. Además, el aviso fuerte dice «revisa cantidad, largo y bobina» (`:108`, y el
mensaje compartido en `production.ts:650`), un texto de coberturas que en drywall no aplica.

**Corrección.** Pasarle a `ToleranceOverrideRow` una línea propia de drywall, algo como «Si
falta montar material, consume otro fleje en vez de confirmar» (el mismo texto que el API), y
parametrizar el texto del aviso fuerte («revisa las piezas y los flejes montados»).

### A-4 · P3: el selector de motivo puede volver a armar la casilla sin que se marque de nuevo

`apps/web/src/app/(app)/planta/tolerance-override.tsx:134-160`. El defecto ya existía en el
componente compartido; drywall lo hereda.

**Escenario.** Se confirma la casilla para un exceso y después se cambian las piezas. La casilla se
ve desmarcada, porque `forExcessKg` ya no coincide, pero `value.checked` sigue en `true`, así que
el selector y el detalle siguen habilitados. Basta con cambiar el motivo o tipear en el detalle:
el `onChange` guarda el exceso nuevo en `forExcessKg` y la casilla aparece marcada sola, sin que
nadie la haya tocado.

**Corrección.** Habilitar el selector y el detalle solo si
`value.checked && value.forExcessKg === excess.excessKg`. En sus `onChange`, no actualizar
`forExcessKg`; que lo actualice solo el checkbox.

### A-5 · P3: si se quita «Fleje más pesado» del enum, las etiquetas ya grabadas desaparecen sin aviso

`apps/api/src/production/production-shared.ts:105-127` y
`packages/shared/src/schemas/production.ts:385-427`.

**Escenario.** D-467 deja la pregunta abierta y dice que «si “más pesado” no aplica a drywall, se
quita del enum sin migración». El enum lo comparten la entrada (`drywallToleranceOverrideSchema`)
y la lectura de la auditoría (`drywallToleranceOverrideAuditSchema`). Si se quita
`HEAVIER_STRIP`, toda auditoría ya grabada con ese motivo falla el `safeParse` y el reporte pierde
en silencio su etiqueta «Fuera de tolerancia» en el detalle, en la merma y en el Panel. Lo mismo
pasa si se agrega un motivo nuevo y no se suma a `ANY_TOLERANCE_OVERRIDE_REASONS`, que es una
lista escrita a mano.

**Corrección.** Separar el enum de lectura (todo lo que alguna vez se grabó) del de entrada
(lo que hoy se ofrece). Derivar `ANY_TOLERANCE_OVERRIDE_REASONS` de los dos enums en vez de
copiarlo a mano. Corregir la nota de D-467: quitarlo del enum de entrada no exige migración, pero
el de lectura lo tiene que conservar.

### A-6 · P3: falta el test de la casilla en la franja de 0 a 1 % con tope

`apps/api/src/production/drywall-tolerance-override.spec.ts`, test «una casilla dentro del 1 % no
deja rastro».

**Escenario.** El test usa 400 piezas (800 kg contra 1 000 kg montados), así que ni siquiera hay
tope. Lo que su nombre promete, una casilla mandada con exceso dentro del 1 % (por ejemplo, 505
piezas), no está cubierto. Ahí `mounted.overridden` es false y no debe haber auditoría ni prefijo
«Fuera de tolerancia» en `rawMaterialWarning`.

**Corrección.** Sumar el caso de 505 piezas con `toleranceOverride` y comprobar que la única
auditoría es `production.report` y que `rawMaterialWarning` es solo la nota de D-246.

### A-7 · P3: la acción nueva no tiene etiqueta en el visor de auditoría

`apps/web/src/lib/audit-labels.ts:87-99`. La de coberturas
(`production.roofing.report-tolerance-override`) tampoco la tiene; el defecto ya existía.

**Escenario.** El historial muestra la acción con `humanizeAction` en vez de un texto en español
coherente con las demás.

**Corrección.** Sumar las dos acciones a `AUDIT_ACTION_LABELS`, por ejemplo: «Reporte de
producción confirmado fuera de tolerancia (drywall/coberturas)».

### A-8 · P3: el E2E deja datos si falla en la mitad, y depende de un tamaño de página

`e2e/tests/tolerancia-drywall-cc29.spec.ts:117-130`, `:157-166`.

- La búsqueda de la entrada de auditoría depende de que entre en la primera página de
  `/api/audit`, porque no pasa `pageSize`. Hoy la orden tiene pocas entradas (crear, consumir,
  reportar, casilla), así que no falla, pero los demás specs pasan `pageSize=50`.
- La limpieza `purgeProductionOrder(...).catch(() => undefined)` traga el error: si la purga falla,
  quedan un fleje en 0 y un reporte en la base de E2E, que pueden ensuciar el conteo de merma de
  otros specs del mismo día (`panel-cc26`, `reportes-cxc-merma-cc25`).

**Corrección.** Agregar `&pageSize=50` y, al menos, registrar el error de la purga en vez de
descartarlo.

## Conteo

| Severidad | Cantidad          |
| --------- | ----------------- |
| P0        | 0                 |
| P1        | 0                 |
| P2        | 3 (A-1, A-2, A-3) |
| P3        | 5 (A-4 a A-8)     |
