# Revisión de segundo modelo — cc69 (D-728, D-729)

Revisor: segundo modelo (Sonnet), contexto limpio, solo lectura. No corrí E2E, db-specs ni builds; revisé el diff `bf9e8b99..HEAD` (18 archivos) y los consumidores de la devolución.

Resultado corto: **sin P0 ni P1 con evidencia.** Un P2 de cobertura, varios P3.

## P0

Ninguno.

## P1

Ninguno. Lo comprobado:

- `sales-return-allocation.ts`: el comparador es consistente (ambos elementos del par son del mismo grupo `afterNote`, así que `direction` es el mismo para los dos). Los posteriores quedan ascendentes por fecha y correlativo; los previos, descendentes. El tope (`available`) sigue contando todo lo despachado, incluidos los posteriores.
- `sales-returns.service.ts`: el orden de escritura (fecha más tardía primero) es coherente con el recosteo hacia adelante (D-649): la parte tardía ya está grabada con su enlace cuando la temprana recostea. Un `IN` atrasado nunca deja el kardex en negativo (D-652 solo frena salidas). `lockInOrder` se toma sobre el borrador, antes de escribir, y `assertLockedDispatches` cubre despachos nuevos.
- Consumidores: Ventas y margen (`sales-margin.service.ts:352`), ventas por material y rentabilidad por documento atan el costo de la devolución a la NC por `credit_note_id`/`credit_note_item_id`, no por `sales_returns.operation_date`; el mes de la NC resta, como pide D-728. `toSalesReturnDto` solo suma campos.
- Anulación: `reverseForCreditNoteInTx` no cambió; `inventory.reverse` con fecha de hoy sobre un `IN` fechado en el pasado es el camino ya conocido.
- D-729: la validación del alta (`purchases.service.ts:1816`) solo corre con `productId` (las líneas de bobina, KGM, no se tocan); el importador valida con el alias ya resuelto; «Editar compra» usa la misma función.

## P2

### P2-1. Sin prueba del límite que la entrega dice conservar (D-652) ni de la anulación del 01 con despacho posterior

- `apps/api/src/invoicing/sales-returns.db-spec.ts` (bloque `cc69`): cubre mismo mes, mes anterior, reparto en dos despachos, anulación y «sin despacho». No hay caso donde el reingreso fechado en el pasado cruce con salidas posteriores del mismo ítem (el recosteo de esas salidas cambia el costo de ventas de otras NC/despachos), ni una NC 01 (anulación, `upToAvailable`) con despacho posterior (rama nueva: antes el filtro `asOf` lo excluía; ahora lo reingresa en la fecha del despacho), ni una bobina (`reopenReturnedCoils` con fecha de despacho posterior a la NC).
- Escenario de riesgo: el 01 pasó de «ignora lo posterior» a «devuelve lo posterior». Una anulación de factura fechada antes de un despacho tardío ahora mueve kardex; sin test, un cambio futuro del filtro no se detectaría.
- Propuesta: sumar al db-spec (1) un 01 con despacho posterior y (2) una salida del mismo ítem entre la fecha de la NC y la del despacho, comprobando el costo efectivo de ambas.

## P3

### P3-1. El orden «previos antes que posteriores» pasa por encima de «el despacho del comprobante acreditado primero»

`sales-return-allocation.ts` (comparador): `later` se evalúa antes que `preferred`. Si el comprobante acreditado declara un despacho posterior a la NC y existe uno previo sin declarar de otro comprobante, se toma el previo. Es coherente con el pedido del dueño («primero ≤ NC») pero cambia el criterio de cc52 P1; conviene dejarlo escrito en D-728 como decisión consciente (el comentario de `ReturnPlanOptions.affectedInvoiceId` ya no lo dice).

### P3-2. Mensaje «de este comprobante» inexacto fuera del 01

`sales-return-allocation.ts` (nuevo rechazo `dispatched.lte(0)`): dice «no hay nada despachado de este comprobante» también para motivos 06/07, donde el filtro no restringe al comprobante, sino al pedido. Texto sugerido: «de este pedido» cuando no es `onlyAffected`.

### P3-3. Acoplamiento por texto entre el plan y `explainWithoutKardex`

`sales-returns.service.ts:~254`: `err.message.includes('no hay nada despachado')` y el corte en el primer `:` dependen de la redacción exacta del otro archivo. Un cambio de texto vuelve silenciosamente al mensaje genérico (ya con test unitario, que lo atrapa, pero es frágil). Propuesta: un `code`/clase de error, o que el plan reciba el dato de «sin kardex» en vez de reinterpretar el mensaje.

### P3-4. Aviso sin año

`lateReturnEntryNotice` (`packages/shared/src/schemas/invoicing.ts`) muestra `dd/mm` sin año; una NC de diciembre con despacho de enero se lee ambigua. Agregar el año cuando difiere del de la NC, o usar la fecha completa.

### P3-5. Borradores de compra viejos con unidad distinta

D-729 valida solo al crear (`purchases.service.ts:259`). Un borrador ya guardado con unidad distinta sigue pudiendo recibirse; si el saldo del producto es cero, el kardex lo aceptaría en la unidad equivocada (el riesgo que la propia función documenta). Propuesta: repetir `purchaseUnitMismatch` al recibir, o verificar en la ventana que no quedan borradores así.

### P3-6. Ampliación de alias fuera del alcance declarado

`purchase-import-validate.ts` suma KILO/KILOS/UNID/UNIDADES/METROS/CAJAS/TN/TON/TONELADA(S) además de lo que pide D-729. Es inocuo (cada alias se valida contra la unidad del producto), pero «TON» puede leerse como tonelada corta y «TN» como tonelada métrica según el proveedor; confirmar que el dueño lo quiere.

### P3-7. Selector de unidad deshabilitado sin salida para unidades viejas

`purchase-form.tsx` (`productUnitOf`): si el producto tiene una unidad fuera de la lista (D-723), el selector queda habilitado y el API rechaza con «corrige la del producto»; correcto, pero el formulario no avisa antes de enviar. Aviso opcional.
