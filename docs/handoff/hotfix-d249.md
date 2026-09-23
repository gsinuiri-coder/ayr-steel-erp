# Handoff — Hotfix D-249: tolerancia simétrica y filtro de línea

Rama `hotfix-d249`, worktree `ayr-steel-erp-d249`, **sin empujar** (el dueño empuja). Base:
`docs/ventana-rf-s4a` y no `origin/main`, porque D-248 y `docs/revision/rf-s4a-d246.md` viven
ahí sin mergear; arrancar de `main` habría dejado D-249 antes que D-248 y con conflicto seguro.

## Qué cambió

|           |                                                                                        |
| --------- | -------------------------------------------------------------------------------------- |
| **M0**    | `mountedKgForReport` acota el exceso **antes** de mirar la declaración (D-249)         |
| **M1**    | `/reports/coils` usa `fromDbLineCode` y compara contra la etiqueta de Postgres (D-250) |
| Tests     | 743 unitarios verdes, 5 casos nuevos en `mounted-kg.spec.ts`                           |
| E2E       | caso nuevo en `fase7-consolidada.spec.ts`: el filtro por línea, que no existía         |
| Migración | ninguna                                                                                |

**Quien revise esto no puedo ser yo**: implementé RF-S4a y escribí el documento de revisión que
originó el hotfix. El pase cruzado de §2.2 sigue debiéndose, ahora también para esta rama.

## M0 — por qué el mensaje de rechazo cambió

El texto viejo decía «Si el acero ya salió, declara los kg consumidos». Con la tolerancia
simétrica ese consejo es **falso**: declarar ya no levanta el bloqueo. El mensaje nuevo manda a
revisar las piezas o la bobina elegida. Un test que afirmaba el texto viejo se actualizó, y es
el único cambio de expectativa en toda la suite: los otros 15 casos de D-246 pasaron sin tocar.

**Riesgo que el dueño debe conocer:** la regla quedó **más estricta** que ayer. Si en planta
aparece un caso legítimo con más de 1 % de desvío, ahora se bloquea aunque declaren kilos —
antes pasaba. Si eso ocurre, la salida no es volver atrás sino subir
`THEORETICAL_KG_TOLERANCE_RATIO` con evidencia de cuánto rinde de verdad el rollo, o corregir la
geometría del producto.

`roofingConsumptionDeviation` **se deja como aviso**, no se convierte en rechazo. El motivo está
en D-249: con la tolerancia simétrica una declaración errada ya no cambia lo que sale del
kardex, y endurecer el mismo camino que D-246 acababa de desbloquear arriesga parar la planta
otra vez el mismo día.

## M2 — barrido del patrón: un solo sitio roto, y el importador queda descartado

**La regla, comprobada contra la base y no deducida:**

```
ORM  (findMany.code) -> DRYWALL, METALLIC_ROOFING, ROOFING, TRADING, SERVICES
RAW  (code::text)    -> drywall, metallic-roofing, roofing, services, trading
```

El ORM devuelve el **nombre** del enum; `$queryRaw` devuelve la **etiqueta** de `@map`. Los dos
mapas de `common/business-line-code.ts` están indexados por el nombre, así que solo el camino
crudo puede romperse.

| sitio                                          | estado                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `reports.service.ts:56,115` (`/reports/coils`) | **estaba roto** — arreglado en M1                                                  |
| `inventory-valuation.service.ts:121,175,200`   | correcto, ya usaba `fromDbLineCode`                                                |
| `sales-margin.service.ts:489`                  | correcto, ya usaba `fromDbLineCode`                                                |
| Los otros ~40 usos de `toSharedLineCode`       | correctos: todos reciben el valor del ORM                                          |
| `BUSINESS_LINE_LABELS` (D-174)                 | correcto: se indexa con el código de `@ayr/shared`, que es el que viaja en los DTO |

### El importador de cotizaciones: **no es este defecto**

El dueño sospechaba que una venta de bobina se clasifica como reventa genérica por el mismo
problema de enums. **No lo es**, y el importador no clasifica líneas: resuelve productos por SKU
(`quotation-import.service.ts:81-97`) y la línea sale del producto.

La causa real está declarada en el código y es **deliberada**: una venta de bobina entera se
factura contra un SKU de `trading` por **D-116 + D-037** (`sales-lines.ts:616,634`,
`BusinessLineCode.TRADING` por el ORM, correcto). O sea que aparece como Reventa **por diseño**,
no por un bug.

Lo que sí cambió la percepción es **D-247, de ayer**: antes, en el reporte de margen, el ingreso
caía en `trading` y el costo en la línea de la bobina; ahora los dos caen en `trading`, así que
la venta se ve **enteramente** como Reventa donde antes estaba partida. El reporte pasó de estar
mal a estar bien, y eso hizo visible una clasificación que siempre estuvo ahí.

**Decisión pendiente para RF-S4b, no para este hotfix:** si el negocio quiere ver una reventa de
bobina bajo la línea del acero (drywall / coberturas) en vez de bajo Reventa, eso es un cambio de
**D-116/D-037** —qué SKU usa esa venta— y no del reporte. Es una pregunta de negocio: ¿la
reventa de bobina es un negocio propio o es venta de la línea de origen? Del reporte no se puede
arreglar sin volver a partir el margen en dos filas.

## M3 — por qué hay pedidos que no pasan a LISTO

`deriveOrderReadiness` (`order-readiness.ts:40`) decide por el **estado de las OP**, no por los
metros: `LISTO` exige que **todas** las OP vivas estén `CLOSED`. De ahí salen tres mecanismos,
los tres confirmados con tests:

1. **Una OP con todo reportado pero sin cerrar deja el pedido `EN_PRODUCCION`**, con
   `missingMl = 0.000`. Es el caso que más se parece a lo que el dueño describe: en planta la
   corrida «terminó» —no falta un metro— pero nadie apretó cerrar, y cerrar pide declarar kilos
   o un motivo de merma.
2. **Una sola OP en `DRAFT` entre varias cerradas ancla el pedido entero.** Confirmar crea las
   OP (D-186); si una línea termina resolviéndose de otra forma, esa OP queda en `DRAFT` y nadie
   la anula.
3. **Con todas las OP anuladas el pedido vuelve a `SIN_PRODUCCION`, nunca a `LISTO`** — aunque
   se haya producido y revertido.

**Dos hipótesis que probé y descarté**, para que nadie las vuelva a recorrer:

- _El punto flotante._ `sales-orders.service.ts:2492` suma metros con `Number(...)` en vez de
  `Decimal`, contra D-003. Es una violación real y vale arreglarla, **pero no es la causa**: el
  `.toFixed(3)` posterior absorbe el desvío (`30.500000000000004` → `'30.500'`), y haría falta
  un error de más de 0,0005 m para cambiar el veredicto. Queda como deuda latente.
- _La invalidación de queries._ `invalidateProduction` **sí** invalida `['sales-orders']` y
  `['sales-order']` (`production-queries.ts:32-33`), así que cerrar una OP desde `/planta`
  refresca la lista de pedidos. No es un problema de caché.

**Relación con D-246, que es la parte accionable:** mientras el defecto del tope existió, un
reporte podía quedar bloqueado y la OP no se podía terminar de reportar → la OP quedaba
`IN_PROGRESS` → el pedido, `EN_PRODUCCION`. El hotfix de esta mañana desbloqueó los reportes
**nuevos**, pero **las OP que quedaron abiertas siguen abiertas**: hay que cerrarlas a mano.

**Consulta de diagnóstico** (solo lectura) que separa los tres casos sobre datos reales:

```sql
SELECT so.seq AS pedido, po.seq AS op, po.status,
       COALESCE(SUM(pr.meters_m), 0) AS metros_reportados
FROM sales_orders so
JOIN reservations r   ON r.sales_order_id = so.id
JOIN production_orders po ON po.reservation_id = r.id
LEFT JOIN production_reports pr ON pr.production_order_id = po.id AND pr.status = 'ACTIVE'
WHERE so.status IN ('CONFIRMED', 'IN_PRODUCTION')
  AND po.status <> 'CANCELLED'
GROUP BY so.seq, po.seq, po.status
HAVING po.status <> 'CLOSED'
ORDER BY so.seq;
```

Una fila con `status = 'IN_PROGRESS'` y metros reportados completos es el caso 1; una con
`DRAFT` y cero metros, el caso 2.

## Para armar RF-S4b

1. **Cerrar las OP colgadas** que salgan de la consulta de arriba, y decidir si conviene un
   aviso en `/planta` para la OP con todo reportado y sin cerrar — hoy nada la distingue de una
   que recién arranca.
2. **`Number(...)` en `sales-orders.service.ts:2492`** → `Decimal`. No es urgente, es correcto.
3. **La clasificación de la reventa de bobina** (ver M2): pregunta de negocio sobre D-116/D-037.
4. **Cobertura de Sonar**: el gate sigue en 74,8 %. El camino más barato está en el PASO 4 de
   `docs/revision/rf-s4a-d246.md`.
5. **Dos revisiones cruzadas pendientes**: RF-S4a y este hotfix.
