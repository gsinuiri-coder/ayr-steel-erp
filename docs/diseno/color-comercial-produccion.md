# Diseño — El color comercial manda en producción y reservas

Estado: **diseño, sin código ni migraciones.** 2026-09-24. Autor: Claude Code, a pedido del
dueño. Las decisiones que abre se numeran al aprobarse (D-270 en adelante).

## 0. La decisión del dueño, y cómo la leo

> Para producción y reservas, el color que cuenta es el **comercial**. Una OP de cobertura ROJO
> puede usar bobinas RAL 3002 o 3020, y lo mismo para azul, verde y los demás. Las que no tienen
> color se agrupan por tipo (NATURAL, GALVANIZADO). La llave es la misma del SKU canónico de
> D-252: espesor + color comercial o tipo. El RAL queda como atributo de cada bobina, para
> trazabilidad.

Lo que se deja de exigir es **el mismo color exacto** (`colorId`). Lo que se sigue exigiendo es
el **mismo color comercial**. Al RAL de cada bobina no le pasa nada: sigue en su acabado y en su
color, se imprime y se reporta. Lo único que cambia es qué bobinas cuentan como intercambiables.

Llamo **atributo de material** al valor que resulta: el token del color comercial (`ROJO`,
`AZUL`…) en una bobina prepintada, o el tipo del acabado (`NATURAL`, `GALVANIZADO`) en una sin
color. Es exactamente `attributeOf(finish)` de `coil-sale-product.ts:142-145` (D-252/D-254).

## 1. Todo lo que hoy exige el color exacto

Inventario verificado sobre `ebf5bb1`. Hoy la llave es una sola, `(businessLineId, colorId
exacto, espesor ± 0.02 mm)`, y la aplican **dos funciones centrales más tres comparaciones
sueltas**. La venta de bobinas (D-252/D-254) es lo único que ya agrupa por color comercial.

### 1.1 La regla y sus decisiones

- **D-085** (`ARQUITECTURA.md:108`): el color es un maestro propio y «todo matching es por
  `colorId`», con igualdad estricta y `NULL` incluido: un producto sin color solo monta bobinas
  sin color.
- **D-086**: el filtro de la OP de coberturas. Bobina `COIL`, `OPEN`, con saldo, de la misma
  línea, espesor ± `ROOFING_THICKNESS_TOLERANCE_MM` (0.02) y el `colorId` del producto.
- **D-134 / D-135**: la reserva genérica contra el agregado «línea + color + espesor ±
  tolerancia»; el acabado solo aporta la densidad.
- **D-154**: los avisos de faltante en producción. Usa la misma llave de D-134.
- **D-203**: el acabado es tipo + color + línea. Un trigger fuerza `coils.color_id` desde el
  acabado.
- **D-212**: la etiqueta por color comercial es solo presentación.
- **D-252**: la venta pasa a color comercial y deja escrito que producción sigue por `colorId`
  exacto. La pregunta «¿una 3020 sirve en una OP ROJO?» quedó abierta ahí.

### 1.2 Las dos funciones centrales

| Función                         | Archivo                               | Qué hace con el color                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roofingCoilWhere`              | `production/roofing-coil-match.ts:30` | Arma el `where` de las bobinas compatibles: `colorId` exacto (`null` = `IS NULL`). La usan `coilOptions` (el selector de planta), `rawMaterialCoilIds` y `rawMaterialAvailability` (D-134).                                                                       |
| `findSpecsAffectedByAttributes` | `sales/raw-material.ts:574`           | Dada una bobina, qué specs de materia prima toca: `colorId` exacto. Lo llama `assertRawMaterialInvariant` desde el kardex, el partido, el cierre, el corte, el cambio de acabado y la venta de bobina entera. `lockRawMaterialCoils` (`:620`) usa la misma llave. |

### 1.3 Las comparaciones sueltas

- `mountCoil`, en `roofing-production.service.ts:601`: `coil.colorId !== product.colorId` →
  «no coincide en color».
- `rawMaterialStock`, en `sales-orders.service.ts:2863` y `:2898-2904`, más
  `product-stock-picker.tsx:111` en la web: el panel de stock del vendedor agrupa por
  `colorId|espesor` y reparte lo prometido con `sp.colorId === group.colorId`.
- `tripleKey`, en `sales-orders.service.ts:863` y `:914`: la vista de faltantes, con
  `businessLineId|colorId|thicknessMm`.
- `costKey`, en `price-floor.ts:232`: el costo del piso de una línea `RAW_MATERIAL`,
  `R|línea|colorId|espesor|kg`.
- `assertFinishCoherence`, en `catalog.service.ts:117-143`: el color del producto tiene que ser
  el del acabado. Sigue valiendo: el producto conserva su color exacto (§3.4).

### 1.4 El dato: `raw_material_specs` (D-134)

- **Tabla:** `(id, business_line_id, color_id?, thickness_mm)`, con el índice único
  `raw_material_specs_key` sobre `(business_line_id, COALESCE(color_id, 0…0), thickness_mm)` y
  una FK a `colors` con `RESTRICT`.
- **Quién apunta a ella:** las reservas firmes y temporales, `quotation_items` y
  `sales_order_items`, como `item_type = RAW_MATERIAL` e `item_id = spec.id`.
- **Cómo se crea:** `resolveRawMaterialSpec` (`raw-material.ts:90`) busca o crea la spec con el
  `colorId` del producto; `findRawMaterialSpec` (`:145`) hace lo mismo sin crearla.
- **Dónde se llama:** al cotizar, al confirmar (`sales-orders.service.ts:1233-1284`) y en el panel
  por SKU.
- **El libro de reservas:** `reservedByItem` suma por `item_id`. El color vive en la spec.

### 1.5 Planta

- **API:**
  - `coilOptions` (`roofing-production.service.ts:2440`) usa `roofingCoilWhere` y devuelve
    `colorName` y `colorHex`.
  - El consumo de la reserva al producir (`:1027-1035`) supone, y lo dice en un comentario, que
    `mountCoil` solo admite bobinas del agregado. **Si montaje y agregado dejan de usar la misma
    llave, ese supuesto se rompe.**
- **Web:**
  - `coil-picker.tsx:116`, `:146` y `:268` dicen «del color y el espesor».
  - `coil-edit-dialog.tsx:235` dice «solo ofrece bobinas del mismo color que el producto».
  - `product-dialog.tsx:105-136` deriva el color del producto desde el acabado.
- **Drywall** (`production.service.ts:401-411`): compara `finishId` exacto. Drywall no tiene
  color comercial; **queda fuera** (pregunta 5).

### 1.6 Reportes

- **Reporte mensual de bobinas** (`reports.service.ts:59-93`): una fila por bobina. El color es
  una columna, no una llave; no cambia.
- **Inventario valorizado** (`inventory-valuation.service.ts:120`): agrupa por
  `línea|espesor|nombre del color exacto`, así que «Rojo» y «Rojo tráfico» son dos grupos
  (pregunta 6).
- **PDF de planta** (`sales-orders.service.ts:2756-2765`): dice «lo que decide qué bobina se
  monta (D-086): espesor, ancho y color». Hay que cambiar el texto.
- **PDFs de bobina**: el color exacto, como trazabilidad; no cambian.

### 1.7 Base de datos y validaciones

- **Índice:** `raw_material_specs_key`, único por `color_id`.
- **Índice:** `coils_business_line_id_status_color_id_thickness_mm_idx`, el del filtro D-086.
- **Triggers:** `color_from_finish` y `finish_color_to_items` (D-203). Siguen igual, porque el
  RAL sigue viajando por el acabado.
- **CHECK:** `finishes_color_by_kind`. Sigue igual.
- **Lo que no hay:** ningún CHECK compara el color del producto con el de la bobina; esa regla
  vive solo en la aplicación.

### 1.8 Tests que fijan el color exacto

**E2E que cambian de sentido:**

- `fase6-bordes.spec.ts:55-100`: «el filtro descarta color distinto».
- `fase7final-m1.spec.ts:226-298`: casos 4 y 5.
- `fase5a-bordes.spec.ts:254-340`: dos colores, dos agregados.
- `acabados-d203.spec.ts:282` y `:373`.
- `planta-avisos-materia-prima.spec.ts:71`, `:136` y `:193`.

**E2E que no se rompen:** los 15 que usan `createColor` para aislarse. El helper genera códigos
`E2E…` sin dígitos al final, así que cada uno es su propio color comercial. Lo mismo pasaría con
el campo explícito de §2.

**Unitarios:** `raw-material.spec.ts` ignora el `where` de color. Fija la aritmética, no el
filtro.

## 2. Cómo derivar la llave

La llave de producción es `(business_line_id, atributo de material, espesor ± 0.02)`. Hay dos
maneras de obtener el atributo.

### Opción A — sin campo nuevo: el normalizador de D-252

`attributeOf(finish)`: el tipo del acabado si no es prepintado; si lo es,
`commercialColorToken(color.code)`, que quita el sufijo RAL del **código** del color (`ROJO-3020`
→ `ROJO`).

- **A favor:** no hay campo que mantener. Es la misma función que ya usa la venta, así que
  venta y producción no pueden divergir.
- **En contra:**
  - **La agrupación sale de cómo se escribió un código**, no de una decisión. `RAL9010` da `''`
    (hoy corta). Un color nuevo `ROJO-OXIDO` sería un grupo distinto de `ROJO`, y cambiar un
    código cambiaría silenciosamente qué bobinas se montan.
  - Las specs y el índice único se siguen llaveando por `color_id` y habría que traducir el
    token en cada consulta.
  - **La base no puede sostener la unicidad por grupo** (la función es de aplicación), así que
    igual hace falta una migración para las specs.

### Opción B — campo explícito en el maestro de colores (**recomendada**)

`colors.commercial_color` (`VARCHAR(20) NOT NULL`, en mayúsculas y sin tildes, por ejemplo
`ROJO`), editable por el ADMINISTRADOR en el maestro de colores.

- **Sembrado:** la migración lo llena con `commercialColorToken(code)` para todas las filas, así
  que el primer día da exactamente lo mismo que la Opción A.
- **Espejo en otras tablas:** `raw_material_specs.material_key` (`VARCHAR(20) NOT NULL`)
  reemplaza a `color_id` en la llave. Guarda el color comercial o `NATURAL` / `GALVANIZADO`, y
  el índice único pasa a `(business_line_id, material_key, thickness_mm)`.
  - Para `coils` y `products`, recomiendo **no** agregar una columna: el atributo se lee por
    join (`finish → color.commercial_color` o `finish.kind`). La otra forma sería una columna
    derivada mantenida por un trigger, como `color_id` en D-203; la decisión es de §3.2.
- **Venta de bobinas:** `coilPoolKeyOf` pasa a leer `commercial_color` en vez de derivarlo,
  para que venta y producción sigan siendo **una sola** regla.
- **A favor:**
  - La agrupación es un dato que el dueño ve y corrige.
  - La base sostiene la unicidad de la spec.
  - El índice del filtro de planta se puede reconstruir sobre el mismo concepto.
- **En contra:** una migración con reapuntado de reservas (§3.1) y un campo más en el maestro.
  No es sustituto de ningún estado derivado (§3.4 de AGENTS): es la definición del grupo, no un
  cálculo.

**Recomiendo B.** La migración de las specs hace falta de todas formas. Con eso, lo único que A
ahorra es un campo, a cambio de que la regla de producción dependa de cómo alguien escribe un
código de color.

## 3. El cambio, pieza por pieza

### 3.1 Migración (la única con riesgo de datos)

1. **Maestro de colores:** agregar `colors.commercial_color`, sembrarlo (en SQL, con la misma
   regex que `commercialColorToken`, verificada contra la función en el dry-run) y ponerlo
   `NOT NULL`.
2. **Specs:** agregar `raw_material_specs.material_key` y sembrarlo.
   - Con color: el `commercial_color` de su color.
   - Sin color: el tipo del acabado. Una spec sin color no sabe su tipo, porque hoy NATURAL y
     GALVANIZADO comparten `color_id NULL`. La regla propuesta: el tipo de los productos que
     apuntan a ella (pregunta 1).
3. **Unificar las specs duplicadas:** las que quedan con la misma
   `(línea, material_key, espesor)` se funden en una, y se reapuntan `reservations`,
   `quotation_reservations`, `quotation_items.reserve_item_id` y `sales_order_items`. Es el
   mismo patrón que la migración `20260907120100_fase7final_reserva_generica_de_mp`.
4. **Índices:** reemplazar `raw_material_specs_key` por el único sobre `material_key`. Conservar
   `color_id` en la spec solo durante la ventana (nullable, sin índice) y quitarlo en la
   migración siguiente.
5. **Índice de planta:** `coils (business_line_id, status, thickness_mm)` alcanza, porque el
   atributo se filtra por join. Se mide en el ensayo antes de decidir si hace falta otro.

**Invariante al fundir.** Si cada spec cumplía `reservado ≤ disponible`, la fundida también:
suma reservas y suma bobinas. Fundir no puede dejar ninguna reserva viva en falta. **Separar**
NATURAL de GALVANIZADO, en cambio, sí puede (pregunta 1).

### 3.2 Dominio

- `roofingCoilWhere` recibe `materialKey` y filtra `finish.kind` o `finish.color.commercialColor`
  en vez de `colorId`.
- `mountCoil` compara el atributo, no el id. **Montaje y agregado usan la misma función**, para
  que siga valiendo el supuesto de `roofing-production.service.ts:1027`.
- `findSpecsAffectedByAttributes` y `lockRawMaterialCoils` pasan a `material_key`, y
  `assertRawMaterialInvariantFor` compara atributos viejos contra nuevos:
  - un cambio de acabado **dentro** del mismo color comercial ya no mueve la bobina de
    agregado;
  - un cambio **entre** colores comerciales sí la mueve, como hoy.
- `resolveRawMaterialSpec` y `findRawMaterialSpec` buscan por `material_key` desde el producto.
- `rawMaterialStock`, `tripleKey` y `costKey` del piso de precio pasan al atributo.
- `coilPoolKeyOf` de la venta lee `commercial_color`: la venta y producción comparten el dato.

### 3.3 Web

- **Selector de planta:**
  - Dice «del color comercial y el espesor».
  - Muestra el **RAL** de cada bobina en su propia columna.
  - Ordena primero las del RAL exacto del producto, si el dueño lo quiere (pregunta 8).
- **Maestro de colores:** agrega el campo «Color comercial» y lista los colores que lo
  comparten.
- **Textos:** se revisan `coil-edit-dialog.tsx:235`, el PDF de planta y la ayuda de
  `product-dialog.tsx`.

### 3.4 Lo que no cambia

- El producto conserva su color exacto: su SKU, su nombre y `assertFinishCoherence`.
- Cada bobina conserva su RAL: el acabado, el `typeKey`, los PDFs y el reporte mensual.
- Drywall sigue por `finishId`, salvo que la pregunta 5 diga otra cosa.
- El kardex no se toca: no hay movimientos nuevos. La unificación mueve punteros de reserva, no
  saldos.

## 4. Las reservas y OPs abiertas en production al cambiar la regla (dry-run)

**No lo corrí.** Esta sesión no tiene autorización para nada contra Neon. Propongo un script de
solo lectura, `scripts/color-comercial-dry-run.mjs` (vía `run-api-cli`, con `--branch` y
dry-run como único modo), que reporte:

1. **Colores:** cada color con `code`, RAL y el `commercial_color` propuesto. Marca los códigos
   donde la regex SQL y `commercialColorToken` no coinciden, y los que dan vacío.
2. **Specs que se funden:** para cada grupo `(línea, material_key, espesor)`, las specs de
   origen, sus reservas firmes y temporales vivas, y las líneas de cotización y pedido que
   apuntan a cada una.
3. **Specs sin color:** las que habría que partir en NATURAL y GALVANIZADO. Por cada una, los
   productos que apuntan a ella y de qué tipo son, y si alguna reserva quedaría en falta al
   separar.
4. **Agregado antes y después:** disponible, reservado y libre de cada grupo, en kg. Solo puede
   crecer, salvo por la separación de (3).
5. **OPs de coberturas vivas:** las bobinas montadas y si su atributo coincide con el del
   producto. Ninguna debería dejar de coincidir, porque la regla nueva es más amplia. El script
   lo verifica en vez de suponerlo.
6. **Faltantes (`findStockShortages`) antes y después:** qué cotizaciones y pedidos pasan de
   faltar a cubrirse.
7. **Piso de precio:** las líneas abiertas cuyo piso cambia porque el costo promedio del grupo
   ahora mezcla bobinas de RAL distintos. Muestra la diferencia en soles.
8. **Reportes:** `snapshot-reports` antes y después, en demo, para el inventario valorizado.

**Lo que espero, a confirmar con números.** El smoke de hoy listó 5 filas en la lista de
bobinas; no distingue abiertas de cerradas. Los pares conocidos son ROJO/ROJO-3020 (D-203) y los de la ventana RF-S4b
(SALDO-ALZ-ROJO-3020 y SALDO-ALZ-AZUL-5002). Espero pocas specs fundidas y ninguna OP afectada,
pero es una estimación, y AGENTS pide medir antes de afirmar.

## 5. Milestones

Una rama, sin sacrificar del medio:

- **M0. Dry-run.** El script de §4, sus tests y una corrida en demo con OK del dueño. Su salida
  decide si hace falta resolver la pregunta 1 antes de migrar.
- **M1. Migración.**
  - `commercial_color`, `material_key`, fusión de specs, índice nuevo y `color_id` de la spec
    nullable.
  - Se valida con `migrate deploy` sobre una base descartable, cargada con un escenario que
    tenga specs a fundir y reservas vivas.
  - **Si aparece algo fuera del plan, se para.**
- **M2. Dominio.** §3.2 completo. Una función única del atributo en `@ayr/shared` (la que hoy es
  `attributeOf`), y la invariante con sus tests de cambio de acabado dentro y entre colores.
- **M3. Venta unificada.** `coilPoolKeyOf` lee la columna. Los centinelas de D-252
  (`coil-sku-canonical.spec.ts`, `coil-sale-product.spec.ts`) tienen que seguir verdes sin
  cambios.
- **M4. Web y textos.** El selector de planta con RAL, el maestro de colores y el PDF de planta.
- **M5. Reportes.** El inventario valorizado según la pregunta 6.
- **M6. E2E.**
  - Cambian de sentido los de §1.8.
  - Nuevos:
    - una OP ROJO monta una 3020;
    - una reserva ROJO se cubre con una 3002 más una 3020;
    - un cambio de acabado 3002 → 3020 con reserva viva no cambia de agregado;
    - uno a AZUL sí cambia.

## 6. Riesgos

1. **Montaje y agregado desalineados.** Si uno cambia y el otro no, producir consume la reserva
   de un agregado que no respaldaba esa bobina, y el libro se descuadra en silencio. Mitigación:
   una sola función del atributo para las dos, y un test que monte una bobina del otro RAL y
   verifique la reserva consumida.
2. **Separar NATURAL de GALVANIZADO.** Hoy comparten `color_id NULL`. Separarlos puede dejar en
   falta una reserva viva que hoy se cubre con bobinas del otro tipo. El dry-run (3) lo mide; si
   pasa, es una decisión del dueño, no del script.
3. **La regex SQL contra `commercialColorToken`.** Si difieren en un solo código, la spec
   sembrada no coincide con la que busca el dominio. Mitigación: el dry-run los compara fila por
   fila y la migración se aborta ante cualquier diferencia.
4. **El piso de precio se mueve.** Un grupo más grande tiene otro costo promedio. Es correcto
   bajo la regla nueva, pero cambia lo que ve el vendedor el día del deploy.
5. **Irreversible sin respaldo.** Fundir specs no se deshace separándolas: las reservas ya no
   saben de qué color eran. Hacen falta respaldo Neon antes de migrar y un plan de vuelta atrás
   por PITR, no por una migración inversa.
6. **El cliente pidió un RAL.** Si un producto es «Rojo tráfico 3020» porque el cliente lo pidió
   así, montarle una 3002 es un error de negocio que la regla nueva permitiría (pregunta 8).
7. **El drift de production.** La migración toca `raw_material_specs` y sus FKs. El
   `migrate diff` de la ventana tiene que seguir siendo el drift conocido más esta migración
   (AGENTS §3.2).

## 7. Ensayo en demo y ventana

### Ensayo (demo, después de resetearla desde production, con OK del dueño)

1. Correr el dry-run contra demo y guardar la salida en `local-data/color-comercial/ensayo/`.
2. Tomar `snapshot-reports` antes.
3. `migrate deploy` de la migración.
4. Deploy de la API de la rama en demo.
5. Correr el dry-run otra vez: los grupos tienen que coincidir con lo planeado y no debe quedar
   ninguna spec duplicada.
6. Tomar `snapshot-reports` después y compararlo.
   - Esperado: iguales al céntimo salvo el inventario valorizado, si la pregunta 6 lo agrupa
     distinto.
7. UAT del dueño: una OP ROJO en planta ofrece las 3002 y las 3020, y una cotización ROJO ve el
   disponible sumado.

### Ventana (production, horario muerto, cada paso con OK explícito)

Sigue el runbook de `ayr-ventana`:

1. Respaldo Neon `respaldo-pre-color-comercial-<fecha>`.
2. Dry-run en production, y compararlo con el del ensayo. **Una diferencia nueva para la ventana.**
3. `migrate diff` = drift conocido + esta migración, **exacto**.
4. `migrate deploy`.
5. Deploy de la API con `git-sha`.
6. Merge a `main`, que publica el web.
7. `pnpm smoke:prod` desde el SHA desplegado.
8. Dry-run después y `snapshot-reports` después.

**Vuelta atrás:** PITR al respaldo del paso 1 y redeploy de la revisión anterior de la API.

## 8. Preguntas para el dueño

1. **NATURAL y GALVANIZADO.** Hoy comparten agregado porque los dos son «sin color». La regla
   nueva los separa por tipo. ¿Confirmás la separación, aunque el dry-run muestre que alguna
   reserva viva quedaría en falta? Mi recomendación es separarlos, como dice tu regla, y
   resolver cada caso que marque el dry-run antes de la ventana.
2. **Línea de negocio en la llave.** La venta de bobinas no filtra por línea; producción sí
   (`businessLineId`). Recomiendo **mantener la línea en producción**: una OP de coberturas no
   debería montar una bobina comprada para otra línea. ¿De acuerdo?
3. **Tolerancia de espesor.** La venta usa el espesor exacto; producción, ± 0.02 mm (D-086).
   Recomiendo **mantener la tolerancia en producción**. «La misma llave de D-252» sería
   entonces el mismo atributo, no el mismo espesor. ¿De acuerdo?
4. **¿Campo explícito o normalizador?** Recomiendo el campo `colors.commercial_color`
   (Opción B). ¿Aprobás la migración, y que el ADMINISTRADOR pueda editar el grupo de un color?
5. **Drywall.** ¿Queda fuera? Hoy empareja por acabado exacto y no tiene color comercial.
6. **Inventario valorizado.** Hoy agrupa por el nombre exacto del color (Rojo ≠ Rojo tráfico).
   ¿Lo agrupamos por color comercial con el RAL como detalle debajo, o se queda como está?
7. **Piso de precio.** Con grupos más grandes, el costo promedio del piso mezcla RAL distintos y
   el piso de algunas líneas abiertas se mueve el día del deploy. ¿Aceptás ese movimiento, o
   querés ver primero la lista del dry-run?
8. **¿Un producto puede exigir un RAL?** Si una cotización es de «Rojo tráfico 3020» porque el
   cliente lo pidió, ¿planta puede montarle una 3002? Recomiendo que **sí**, que es tu regla,
   pero que el selector de planta ofrezca primero las del RAL exacto del producto y marque las
   otras con su RAL. Así se prefiere lo exacto sin bloquear.
9. **Productos duplicados por RAL.** ¿Hay que fundir en el catálogo los productos de cobertura
   que solo difieren en el RAL (por ejemplo, una plancha ROJO y una ROJO-3020), como D-252 hizo
   con las bobinas de venta? Recomiendo **no** hacerlo en este cambio: es otra migración y otra
   ventana, y producción ya funciona sin eso.
