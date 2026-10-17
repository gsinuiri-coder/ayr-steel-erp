# Corte C (cc57-c-reportes): revisión de segundo modelo (Sonnet, contexto limpio)

Alcance: commit `d77ac264`. Solo lectura; no se corrió nada.

## Hallazgos

| Sev | Archivo:línea | Escenario | Recomendación |
| --- | --- | --- | --- |
| P2 | `reports/cost-basis-cc55.db-spec.ts` (test E-02, final del archivo) | El test solo compara `doc.costPen` con `profit.total.costPen`; el costo DEV- se calcula y solo se imprime con `console.warn`. Si ambos reportes fallaran igual (p. ej. los dos en 0 por no leer la devolución) el test pasa. No prueba lo que dice («restan el mismo costo, el de la OP»). | Afirmar `expect(devCost).toBeDefined()` y que `doc.costPen` sea el negativo esperado (valor concreto, no nulo/cero) y quitar el `console.warn`. |
| P3 | `reports/sales-by-product.spec.ts` (tests E-03 nuevos) | Falta el caso «NC de otro mes» como prueba explícita (comprobante afectado fuera del rango: ausente de `tracedKeys`). La rama `!tracedKeys.has` se cubre solo con una venta no trazada del mismo rango; la lógica es correcta pero no está fijada. Tampoco hay caso NC 07 + NC 04 sobre el mismo comprobante. | Sumar un test con `affectedDocumentId: 'dX'` sin línea `dX` y otro con dos NC sobre `d1`. |
| P3 | `credit-note-reasons.db-spec.ts` (E-03) | Solo cubre una NC 07 sobre reventa trazada. No cubre NC 04 (rebaja) ni NC sobre comprobante no trazado a nivel BD. | Opcional; la cobertura unitaria alcanza para la lógica. |
| P3 | `cobranzas-view.tsx:~220` | `hint` de `Stat` es una segunda línea pequeña pensada para matices cortos («4 pedidos · 4 comprobantes», cc32). El texto nuevo (~90 caracteres) puede cortarse o romper la altura de la franja en escritorio. | Verificar visualmente; acortar a «Con vencimiento pasado; el Panel suma el contado» o llevarlo a un tooltip. |
| P3 | `sales-margin.service.ts:~177` (E-16) | Efecto de datos: una venta de mostrador/POS o un comprobante manual sin pedido pasa de «sin vendedor» a mostrar a quien lo registró (cajero/admin). Es lo pedido (misma regla que `documentOwnerId`), pero cambia lo que se ve en «Ver por vendedor». | Dejarlo anotado en el handoff/UAT; no es defecto. |

No hay P0 ni P1.

## Revisado sin hallazgo

- **E-03, NC de otro mes:** la NC en rango cuyo comprobante afectado está fuera del rango no está en `tracedKeys` y va a «No trazable» (motivo `NOTA_CREDITO`), igual que antes. Una NC fuera del rango con comprobante en rango no entra a `lines`, y la fila no se toca (igual que antes).
- **Cuadre `lineSales = filas + no trazable + otras pestañas`:** cada línea de NC entra una sola vez, a la fila o a «No trazable»; `lineSales` ya la suma antes de bifurcar. La fila suma la venta completa de la NC (no se parte por `fraction`), consistente con el cuadre. `reconciliation` y `untraceableSalesPen` se alimentan del mismo `assembly`, sin cambios.
- **`affected_document_id`:** columna existente (`schema.prisma:2098`), se escribe al crear la NC (`invoicing.service.ts:1610`), en el POS (`pos.service.ts:690`) y en el importador (`fiscal-import.service.ts:1327`). Si es null, cae en «No trazable» (rama `affected === null`).
- **Doble conteo de costo:** el costo de la venta (`declaredDispatches`) filtra `ref_type='SALE'` y une por `dispatch_items.movement_id`; los reingresos DEV- son `SALES_RETURN` y sus recosteos no resuelven a un `dispatch_item`, así que no están en el costo de la factura. Restar `return_cost` en la fila de la NC no duplica. La subconsulta es escalar y correlacionada por `fdi.id`: no multiplica filas. Solo cuenta `sales_returns.status='ACTIVE'` y suma recosteos por `recost_of_id`, la misma expresión que `returnCosts` y `document-profitability.service.ts:111`. Una NC sin devolución (rebaja) da `NULL` y se trata como 0.
- **E-15:** el `SCRAP` de RF-17 (merma de bobina) lleva `ref_id` = bobina (`coil-waste.ts:277`: `refId === itemId`), y la consulta une `po.id::text = m.ref_id`, así que no puede coincidir con una OP. Los `SCRAP` de cierre (`roofing-production.service.ts:2389`, `production.service.ts:1181`) llevan `ref_id` = OP. Reversas (reapertura, IN) y recosteos (ADJUST) restan por el `CASE`, igual que la rama PRODUCTION; mismo patrón que `coilUsage` en `sales-by-material.service.ts:~639`. El `UNION ALL` no duplica por la relación 1:1 OP-reserva.
- **E-16:** `fd.dispatch_id` es la columna correcta (la guía de remisión del comprobante; `dispatches.invoice_id` sería la otra punta, `schema.prisma:2198`). El COALESCE reproduce `documentOwnerId` (`collectible-documents.ts:143`). `created_by_id` es NOT NULL. Los comprobantes con pedido caen en un mismo cajón con el mismo `so.seller_id`; los sin pedido van uno por cajón (`doc:<id>`), así que `first.seller_id` no mezcla vendedores. El servicio no filtra por vendedor ni limita alcance por usuario (solo muestra `sellerId/sellerName`; el filtro «Ver por vendedor» es de la vista), de modo que no cambia el alcance de nadie.
- **E-08/E-09:** solo texto. `hint` existe en `Stat`. El aviso es coherente con D-667 y D-461.
- **Tests unitarios E-03:** los números de `sales-by-product.spec.ts` cuadran con el código (400/240; 450/300 y `d2`, `nc2` en no trazable). El db-spec E-03 verifica fila y `untraceable`, y la igualdad con Ventas y margen (venta y costo).

## Sospechas (no confirmadas)

- Si una factura queda trazada parcialmente (`DESPACHO_PARCIAL`), la NC resta toda su venta de la fila aunque solo se trazó una parte de la venta. No es un error de cuadre, pero la utilidad de esa fila puede subestimarse. Probablemente aceptable, porque la devolución exige lo despachado.
- El test E-02 imprime con `console.warn`: si el CI falla por ruido de consola (no verificado), habría que quitarlo.

## Resumen

Sin P0/P1. El diseño es correcto y consistente con las demás consultas; el único punto de peso es el test E-02, que no fija un valor y podría pasar con ambos reportes mal. El resto son cobertura adicional y detalles de UI.

---

## Respuesta del autor (cc57)

- **P2 (test de E-02):** ahora fija la cifra (−181,80, lo que acredita la OP) y que no es el costo de la DEV-. Se quitó el `console.warn`.
- **P3 (NC de otro mes, NC 07 + 04):** cubierto con un unitario nuevo (venta trazada en parte y 02). La de otro mes cae por construcción en «No trazable» (su venta no está en las claves trazadas).
- **P3 (pista larga):** acortada a «Sin el contado (el Panel sí lo cuenta)».
- **P3 (E-16 cambia «Ver por vendedor»):** anotado en el UAT.
