# Revisión de segundo modelo — cc68 (D-722..D-726)

Revisor: segundo modelo (Sonnet), contexto limpio, solo lectura. No corrí E2E ni builds.

## Alcance revisado

`git diff origin/main...HEAD` (40 archivos), commits:

- dfa80feb feat(imports): reversa de un lote de la carga inicial de productos (D-722)
- fb1ddf97 feat(catalog): la unidad del producto es una lista cerrada (D-723)
- 3bdac931 feat(units): la caja (BX) y la tabla 6 vigente del formato 13.1 (D-724, D-725)
- 5e4935f0 chore(deploy): el paquete de la API no lleva local-data ni archivos de entorno (D-726)
- 5641a5f8 test(e2e): unidad de la lista, la caja y el bloqueo al confirmar (cc68)

Resultado corto: **sin P0 ni P1 con evidencia**. Dos P2 reales (uno de ellos toca el uso previsto en producción) y varios P3.

## P0

Ninguno.

## P1

Ninguno.

## P2

### P2-1. Cambiar la unidad de un producto con saldo de kardex no se frena (riesgo del paso ESQ30 NIU -> BX)

- `apps/api/src/catalog/catalog.service.ts:355-361` (validación nueva) y `:392-399` (el único guard de cambio de unidad es solo de Drywall y mira OPs vivas, no saldo).
- `apps/api/src/inventory/inventory.service.ts:293-297`: `record()` rechaza con 400 «El ítem ya tiene saldo en NIU: no se puede mover en BX» si el saldo no es cero y su unidad difiere de la del movimiento.
- Escenario: si ESQ30 todavía tiene saldo distinto de cero (o reservas) cuando el admin lo pasa a BX, la edición pasa sin aviso; desde ese momento toda venta, despacho o ingreso de ESQ30 falla con ese 400, y las cotizaciones re-editadas a BX quedan reservando/confirmando contra un saldo en NIU. La prueba E2E asume «sin kardex, como ESQ30 después de anular su carga» (`e2e/tests/caja-bx-cc68.spec.ts`), es decir, el orden depende de que la reversa de D-722 corra primero, y nada en el producto lo obliga.
- Arreglo sugerido: en `update`, si `input.unit !== before.unit`, rechazar cuando `inventory_balances.qty <> 0` del producto (o existan reservas ACTIVE) con un mensaje que diga que primero se saca el saldo; o, como mínimo, dejar en el runbook de la ventana el orden fijo: revertir el lote -> verificar saldo 0 de ESQ30 -> cambiar unidad -> re-editar cotizaciones. Con saldo 0 y balance en NIU, el cambio funciona (`record` permite cambiar unidad cuando `qty` es 0 y `writeBalance` actualiza la unidad).

### P2-2. Huecos de prueba en la reversa (D-722)

- `apps/api/src/imports/initial-inventory-product-revert.db-spec.ts` (tres casos: ejecutar, bloqueo por movimiento posterior, lote inexistente). No hay caso db para: reserva de pedido ACTIVE, reserva temporal de cotización vigente, segunda corrida tras ejecutar (rama `alreadyReversed`), ni dos entradas del mismo producto en el lote. Las ramas están cubiertas solo por la función pura (`initial-inventory-product-revert.spec.ts`), que no prueba que las consultas de `plan()` (`groupBy` sobre `reservation` y `quotationReservation`, `expiresAt > now`) devuelvan lo esperado.
- Arreglo sugerido: sumar al db-spec los casos de reserva activa y de reejecución (debe fallar con «ya se revirtió», sin escribir).

## P3

### P3-1. La fecha de la reversa no es obligatoria en el CLI

- `apps/api/prisma/import-initial-inventory-cli.ts` (`runRevert`) y `scripts/import-initial-inventory.mjs`: `--operation-date` es opcional; si se omite, `OperationDateService.resolve` usa hoy. El uso real pide 2026-08-01 (la fecha de la carga). Un olvido deja la reversa con fecha de hoy, no equivale a «el lote nunca ocurrió» en los reportes por fecha, y no hay cómo corregirla (kardex append-only).
- Arreglo sugerido: exigir `--operation-date` con `--revert` (y mostrar en el dry-run la fecha de cada entrada original junto a la de la reversa).

### P3-2. `laterMovements` cuenta también movimientos anteriores a la carga

- `apps/api/src/imports/initial-inventory-product-revert.service.ts` (`others`: todos los movimientos del ítem fuera del lote) y el texto «posterior(es) a la carga» en `initial-inventory-product-revert.ts`. Un producto con una entrada previa a la carga (otro lote, otra fecha) se rechaza con un mensaje que dice «posterior». Es conservador y seguro (falla cerrado); solo el mensaje es inexacto. Filtrar por `id > entry.id` o por fecha si se quiere precisión.

### P3-3. `SHORT_UNITS` sin BX

- `packages/shared/src/schemas/operation.ts:77`: `{ KGM, NIU, MTR, TNE }`. El texto de D-652 (rechazo por kardex negativo) mostraría «10 BX» en vez de «10 caja»/«10 u» para una caja. Cosmético.

### P3-4. Texto de piso «por unidad» solo para NIU

- `apps/web/src/components/sales/sales-document-form.tsx:1197`: `product?.unit === 'NIU' ? 'unidad' : unitSymbol(...)`; para BX sale «por caja» (correcto). Sin acción; lo anoto porque es el único sitio que comparaba contra `'NIU'` en la web de venta y queda bien.

### P3-5. `storedUnitSchema` acepta cualquier texto en la edición

- `packages/shared/src/schemas/product.ts` (`updateProductSchema.unit`): el contrato por sí solo admite cualquier cadena; la lista cerrada se exige en `CatalogService.update` solo si la unidad cambia. Correcto para el requisito (editar un producto con unidad anterior a la lista), pero cualquier otro llamador de `updateProductSchema` fuera del servicio no tiene la barrera. Hoy no hay otro.

## Qué está bien (verificado leyendo)

- Reversa (D-722): dry-run por defecto; todo o nada (si `plan.ok` es falso no entra a la transacción; dentro se re-planifica bajo lock y se aborta si cambió); solo `InventoryService.reverse` (regla 8); saldos tomados con `lockInOrder` antes de leer lo que decide (reglas 15 y 17); `OperationDateService.resolve`; auditoría `imports.initial-inventory-products.revert` con lote, fecha, motivo y ids; la reversa no depende de que el CLI esté en prod porque el wrapper ya exige `--confirm-production` para `--execute` contra production. La reejecución tras ejecutar da «ya se revirtió» y no escribe (las filas de reversa quedan fuera de `laterMovements` por `reversalOfId`).
- Lista cerrada (D-723): la validación en `update` compara contra `before.unit`, así que un producto con `und` se edita sin tocar la unidad; probado en `catalog.service.drywall.spec.ts`. El CHECK `products_roofing_kind_unit_check` (PLANCHA `unit <> 'MTR'`) admite BX. Todas las líneas de cotización nacen con `product.unit` (`sales-lines.ts:478,707`) y las de bobina con KGM igual que su producto de venta (`coil-sale-product.ts:298`), de modo que `confirmUnitChange` no da falsos bloqueos en datos consistentes.
- BX (D-724): `UNITS` ya alimenta el selector de compras, comprobantes manuales y Nubefact (`nubefact-payload.ts:84-88` valida contra `UNITS`, así que BX viaja como BX); alias CAJA/CJA/BX en ambos importadores; formato de cantidades cuenta BX como NIU (`format.ts`, `unit-symbol.ts`). Los comparadores contra `Unit.NIU` que quedan (producción, plancha fija, importación de drywall, `sales-by-material`) son de producto fabricado/drywall/plancha, donde BX no aplica.
- Formato 13.1 (D-725): `reportUnit` se acota por `to` (la consulta ya filtra `operationDate <= to`) y toma el último del rango; `unitTable6` cae en «99 - OTROS» para códigos fuera de la lista; prueba que cada unidad de la lista tiene entrada.
- D-726: `.gcloudignore` excluye `local-data` y `.env*` en cualquier nivel; el guard usa `gcloud meta list-files-for-upload` (solo nombres, `quiet: true`, nunca lee contenido), normaliza `\` y `/`, y corre antes del `gcloud run deploy`. Con `cwd = ROOT` por defecto de `run`, el `'.'` coincide con el `--source .` del deploy.

## Qué se hizo con los hallazgos

- **P2-1:** corregido en `5f94c370`. Cambiar la unidad de un producto con saldo distinto de cero o con reservas activas se rechaza (`CatalogService.update`). La autorrevisión sumó el caso de un pedido vivo sin reserva, confirmado con faltante: también se rechaza (`bf3ea327`). Pruebas en `catalog.service.drywall.spec.ts`. El runbook mantiene el orden igual: primero la reversa del lote, después ESQ30 a BX.
- **P2-2:** la segunda corrida («ya se revirtió») ya estaba cubierta en el db-spec (primer caso, al final). Los rechazos por reserva de pedido o temporal quedan probados en la función pura (`initial-inventory-product-revert.spec.ts`), con las consultas del servicio a la vista. No se sumó un db-spec, porque armar una reserva real exige un pedido completo; queda anotado. Un mismo producto dos veces en el lote no puede pasar: la carga rechaza un producto que ya tiene kardex (D-207).
- **P3, `--operation-date`:** corregido. `--revert` lo exige.
- **P3, el mensaje:** corregido. Ahora dice «movimiento(s) de kardex además de la carga».
- **P3, `SHORT_UNITS`:** corregido. Suma `BX: 'caja'`.
- **P3, `updateProductSchema`:** queda así a propósito (D-723). El contrato acepta la unidad guardada y la regla vive en el servicio, que es el único llamador.
