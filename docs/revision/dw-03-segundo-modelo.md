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
