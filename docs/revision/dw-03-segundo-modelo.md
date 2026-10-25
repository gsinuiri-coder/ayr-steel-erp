# Revisión de segundo modelo — dw-03 (Sonnet, contexto limpio)

**Alcance:** `git diff origin/main...HEAD`, commit revisado `79cbd175` (7 archivos, +548/-35): servicio
`initial-inventory-product-import.service.ts`, unit `initial-inventory-product-scope.spec.ts`, db-spec
`initial-inventory-drywall-profiles.db-spec.ts`, E2E `inventario-inicial-perfiles-dw03.spec.ts`, README y dos CSV de
`docs/plantillas/`. No se ejecutaron tests (solo lectura). Es un segundo modelo, no una persona: no cierra la revisión.

## P0

Ninguno.

## P1

Ninguno.

## P2

### P2-1 — Cantidad fraccionaria de piezas aceptada para el perfil

`initial-inventory-product-import.service.ts` (`parseRow`, `decimalField(raw, 'units', 'KG', ...)`). `UNIDADES` se
valida con escala KG (3 decimales): `120.5` pasa y entra al kardex como 120,500 NIU. Para UPVC/Reventa ya era así, pero
un perfil de Drywall es una pieza física y la planta lo trata por unidades enteras; una celda mal tipeada (`1,5` leída
como `1.5`) dejaría saldo fraccionario que luego no se puede despachar entero. Sugerencia: para el perfil de Drywall
(`DRYWALL`) exigir `units` entero (un error de fila nombrándolo), sin tocar el comportamiento de UPVC/Reventa. No es
bloqueante porque el dry-run lista las filas y el archivo es de una sola carga.

### P2-2 — Comentarios de cabecera desactualizados (el código dice lo contrario)

- `initial-inventory-product-import.service.ts` ~línea 34: el párrafo «Solo líneas compra-reventa. El producto terminado
  propio (Drywall, Metallic Roofing) no entra por acá» sigue sin matiz justo encima del bloque D-712 que lo contradice.
- `scripts/import-initial-inventory.mjs:14`: «`--kind products` carga productos UPVC/reventa por unidades». Un operador
  que lee la ayuda del CLI no se entera de que ahora acepta perfiles de Drywall.
  Sugerencia: ajustar ambos textos (una línea cada uno). Es un riesgo de mentira documental, no de comportamiento.

## P3

### P3-1 — El db-spec no cubre unidad distinta de NIU ni Drywall `PURCHASED`

`initial-inventory-drywall-profiles.db-spec.ts`: esos dos rechazos solo los prueba el unit (`productScopeError`), que es
una función pura; el camino `parseRow` → mensaje con el prefijo `SKU PRODUCTO "…"` no se prueba para ellos. El E2E tampoco.
La lógica es correcta (verificada a mano), así que es solo cobertura.

### P3-2 — El costo cargado no se contrasta con el costo teórico del perfil

Nada compara `COSTO UNITARIO` con kg/pieza × costo del fleje. Un error de magnitud (costo por docena en vez de por pieza)
entra tal cual al `avgCost` del saldo y de ahí al costo de lo vendido. El piso de precio **no** se contamina
(`price-floor-cost.ts:productFloorCost` usa `STRIP_SKU` por SKU y no el kardex para un perfil fabricado), pero margen y
rentabilidad sí leerán ese costo. Sugerencia: que el informe de dry-run muestre el costo por pieza al lado de la ficha, o
dejarlo como paso manual del UAT. Decisión del dueño, no del código.

### P3-3 — El orden `isActive` antes de `scopeError` oculta el motivo de alcance

`parseRow`: un perfil desactivado y además mal configurado reporta solo «desactivado». Es el orden anterior, sin cambio
de comportamiento.

## Verificado sin hallazgos

- **Lógica de alcance (`productScopeError`).** Drywall solo entra con `source MANUFACTURED`, `unit NIU` y los cuatro datos
  `> 0` (`isMissing` cubre `null` y `<= 0` con `Decimal.lte`, sin `number`); si falta más de uno los nombra todos.
  `METALLIC_ROOFING` cae en «ni un perfil de Drywall» con o sin ficha, tanto fabricada como comprada. UPVC/Reventa:
  `PURCHASED` entra, `MANUFACTURED` se rechaza con el mismo texto que antes; la unidad no se mira (igual que antes).
  El único cambio observable para ellos es el texto del rechazo de una línea fuera de alcance (ahora menciona Drywall); el
  spec E2E previo `inventario-inicial-productos-f8s6a2` solo asserta «fabricado», que sigue presente.
- **Todo o nada / dry-run / kardex previo.** `ok` exige cero errores en todas las filas antes de abrir la transacción;
  `hasKardex` rechaza cualquier SKU con movimientos (sin cambios); el bloqueo `FOR UPDATE` de productos y la revalidación
  de existencia se conservan. El perfil entra por `InventoryService.record` (`IN`, `IMPORT`, soles, `unitCost × tipo de
cambio` en `Decimal`), por lo que no hay escritor nuevo de kardex (regla 8, el centinela no debería cambiar). Los
  `select` nuevos de dimensiones llegan como `Prisma.Decimal | null` y no se convierten a `number`.
- **Resto del sistema con un perfil que entró por IMPORT.** Piso de precio: no depende del kardex para perfiles
  fabricados (`price-floor-cost.ts`), y justamente pide `pieceWeightKg`/espesor/ancho, que esta entrega exige: coherente.
  Reportes de ventas por material usan `pieceWeightKg` (`sales-by-material.ts:368`), también garantizado. Despacho:
  `invoice-dispatch.service.ts:779` y `undispatched-inventory.ts:125` ya tratan `IMPORT` como apertura
  (`BLOQUEADO-APERTURA`) para cualquier producto: sin cambio de semántica. Reservas: con stock el pedido reserva el propio
  producto (lo prueba el E2E contra D-598). No se encontró código que asuma que todo stock de un perfil fabricado nace de
  una OP (merma/rentabilidad parten de reportes de producción, que un perfil sin producción simplemente no tiene).
- **Tests.** El unit prueba lo que dice (matriz línea × source × unidad × cada dato, nombres exactos). El db-spec prueba
  dry-run sin escribir, ejecución con `IN`/`IMPORT`/costo/total (`120 × 3.11 = 373.20`), segundo intento rechazado por
  kardex previo, todo o nada con un perfil sin peso (setup por `updateMany` justificado: el alta ya no permite crearlo
  así) y cobertura fabricada rechazada. El E2E corre el CLI real contra `local-e2e`, verifica saldo/costo/`IMPORT` y la
  reserva del pedido, usa un ancho único y limpia con `purgeSalesTrail` + desactivación del SKU.
- **README y CSV.** Coherentes con el código: 4 filas válidas + 1 inválida (`EJ-DRYWALL-COMPRADO`, Drywall comprado); el
  CSV de UPVC/Reventa cambia el inválido a `EJ-COBERTURA-FABRICADA` (Metallic Roofing) y el README ajusta la tabla y el
  conteo («8 OK y 3 con error»). Los datos de ejemplo del catálogo (espesor 0.43, anchos, pesos) cumplen la ficha exigida.

## Veredicto

**Aprobable sin P0/P1.** Sugiero corregir P2-1 (entero para el perfil) y P2-2 (textos de cabecera y del CLI) antes del
deploy, o dejarlos registrados como aceptados por el dueño. P3 son de cobertura y de proceso (revisar costos del archivo en
el UAT). Ninguna parte de esta entrega toca kardex fuera de `InventoryService.record`, ni cambia el comportamiento de
UPVC/Reventa.

## Respuesta del autor

- **P2-1 (piezas enteras): corregido.** Una fila de Drywall con `UNIDADES` fraccionaria se rechaza («un perfil de
  Drywall se carga en piezas enteras»); UPVC y Reventa siguen como antes. Caso nuevo en el db-spec.
- **P2-2 (textos viejos): corregido** en la cabecera del servicio, en `scripts/import-initial-inventory.mjs` y en
  `apps/api/prisma/import-initial-inventory-cli.ts`.
- **P3:** el costo cargado frente al teórico queda para la parte 2, en el dry-run con los datos del dueño. Drywall
  comprado y unidad distinta de NIU están en la unitaria; no se suman al db-spec.

La autorrevisión (lista de riesgos, no pase cruzado) agregó: el comando de ejemplo del README sin `--operation-date`
(corregido: la sección explica la fecha y la carga real va con `--operation-date 2026-08-01`) y que un perfil con kardex
tumba todo el archivo (hoy ninguno de los siete tiene kardex en producción; se vuelve a mirar antes de la carga).

## D-713 (commit 325bc525)

Revisión de segundo modelo, contexto limpio, solo lectura. Alcance: piso del perfil de Drywall desde el costo de su saldo
(`price-floor.ts`, `price-floor-cost.ts`, `price-floor-report.ts`, specs) y los llamadores de `productFloorCost`
(`sales-lines.ts`, `sales-orders.service.ts`, `catalog.service.ts`, `price-list-import.service.ts`).

Lo que está bien: la decisión vive en un solo lugar (`addStripSkuCosts`), que alimentan todos los llamadores por
`computePriceFloors`/`computePriceFloorOutcomes`; todo en `Decimal`; el costo no viaja al vendedor (el mensaje de
`assertPriceFloor` no cambió); la clave de costo con `productId` no rompe el agrupado de flejes (se agrupa por `stripKey`);
una sola consulta extra de saldos por lote (no por perfil); el guion `check:price-floor` ahora usa las funciones de dominio.

### P0

Ninguno.

### P1

**P1-1. Un perfil con saldo pero con el SKU incompleto sigue sin piso: la regla se salta antes de mirar el kardex.**
`price-floor-cost.ts:62-68` (`productFloorCost`) devuelve `noFloorReason` (`NO_THICKNESS`, `NO_WIDTH`, `NO_PIECE_WEIGHT`)
**antes** de que nadie lea el saldo, y todos los llamadores descartan el candidato cuando no hay `cost`:
`sales-lines.ts:678-680`, `sales-orders.service.ts:4051-4064` (panel de stock; además rotula `NO_PIECE_WEIGHT`),
`catalog.service.ts:648-651` (`priceFloor(id)`), `catalog.service.ts:717` (card «lista bajo piso»),
`price-list-import.service.ts:176` y `price-floor-report.ts` (`sinCosto`). Escenario: perfil de Drywall `MANUFACTURED` cargado
como saldo inicial (D-712) sin `pieceWeightKg` (la carga solo exige SKU, unidades y costo) → tiene saldo y costo promedio, pero
cotización, pedido y mostrador lo venden a cualquier precio, y el panel dice «sin peso» aunque el costo exista. D-713 dice que
con saldo manda el kardex y los flejes solo aplican sin saldo; la dependencia del SKU (espesor, ancho, peso) es solo del
cálculo por flejes. Arreglo sugerido: para un perfil de Drywall, construir siempre un candidato que pueda caer a
`PRODUCT` (por ejemplo `STRIP_SKU` con la especificación de fleje opcional), de modo que `addStripSkuCosts` resuelva primero
el saldo y solo use el SKU completo para el respaldo por flejes; el motivo estático (`NO_*`) se reporta solo si tampoco hay
saldo. Prueba que falta: perfil con saldo > 0 y `pieceWeightKg = null` debe dar piso del kardex en panel, `priceFloor`,
`resolveSalesLines` y el reporte.

### P2

**P2-1. Doble criterio de «tiene saldo» entre perfil y resto de productos.** `price-floor.ts:469-474` exige `qty > 0` y
`avgCost > 0`; la rama `PRODUCT` de `unitCosts` (`price-floor.ts:~380-390`) toma `avgCost` sin mirar `qty`. Un perfil con
saldo en cero y costo viejo cae a flejes (intención de D-713, bien), pero un perfil `PURCHASED` o de otra línea con saldo en cero
conserva su costo viejo como piso. No es un defecto de este commit, pero la regla escrita en el docstring («con saldo»)
sugiere uniformidad; conviene dejar escrito en D-713 que la excepción es solo de Drywall fabricado, o unificar.

**P2-2. Saldo negativo con costo positivo.** El caso queda cubierto por el test («qty -3» sin flejes → `NO_COST`), pero no
está el caso `qty > 0` con `avgCost = 0` (carga con costo cero, que el importador no necesariamente rechaza): cae a flejes sin
aviso. Es coherente con la regla, pero sin prueba.

### P3

**P3-1. Cobertura E2E solo del camino feliz y del rechazo en cotización.** `inventario-inicial-perfiles-dw03.spec.ts` prueba
sin saldo, con saldo y rechazo en cotización; no hay caso en pedido ni mostrador, ni vendedor (que el mensaje no traiga costo
con el costo ahora más fácil de acertar). Las rutas comparten `assertPriceFloor`, riesgo bajo.

**P3-2. Una consulta más por lote con perfiles.** `addStripSkuCosts` agrega un `findMany` de saldos `PRODUCT` aunque la rama
`PRODUCT` de `unitCosts` ya consultó los suyos en el mismo lote (el panel de stock mezcla ambos). No hay presupuesto de
consultas que lo cubra; se puede fusionar con la consulta de `unitCosts` si el panel lo nota.

**P3-3. Comentario desordenado.** `price-floor-cost.ts:13-16` quedó con una línea larga (>100 columnas) en el docstring;
`pnpm format:check` lo marcará si no se pasó Prettier.

## Veredicto D-713

**P1-1 se corrige antes del deploy** (o el dueño lo acepta por escrito: afecta solo perfiles con saldo y SKU incompleto). Sin
P0. El resto es registro.

## Respuesta del autor (D-713)

- **P1-1, corregido.** El perfil al que le falta espesor, ancho o peso ahora da un costo `PROFILE_STOCK`: su piso sale del
  saldo propio si lo tiene (cantidad y costo positivos) y, si no, queda sin piso con el motivo del SKU
  (`noStockReason`, `missingFloorReason`). Pruebas nuevas: unidad de `computePriceFloors` y `CatalogService.priceFloor`
  con un perfil sin peso y con saldo.
- **P2 (saldo con costo cero), cubierto:** cae a flejes y tiene prueba. La asimetría con `PRODUCT` (que toma el promedio
  aunque el saldo esté en cero) quedó comentada como a propósito.
- **Consulta extra (P3 aquí, P2 en la autorrevisión), corregido:** el saldo propio del perfil se lee en la misma
  consulta de saldos `PRODUCT` de `unitCosts`, con prueba de una sola lectura por lote mixto. La prueba de presupuesto
  del card sigue en verde.
- **Queda como límite conocido:** el marcador estático del catálogo (`staticNoFloorReason`, «Sin espesor en el SKU: sin
  piso») no mira saldos, así que un perfil incompleto **con** saldo lo seguiría mostrando aunque la cotización ya le
  aplique el piso del kardex. Hoy no hay ninguno: el catálogo y el importador exigen los tres datos y los 8 perfiles de
  producción los tienen.
