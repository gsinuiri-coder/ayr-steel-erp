# Autorrevisión — `fix/deudas-post-s4b` (2026-09-24)

**Autorrevisión, no pase independiente** (AGENTS.md §2.2): la hizo un subagente nuevo del mismo
modelo que escribió la rama, sin leer handoffs ni revisiones. Alcance: `be6ecb6..b00ab7b` (las
cinco deudas; el commit de la guía del cliente no se revisó). Solo lectura: no corrió nada.

## Resultado

0 P0. **1 P1, condicional a una decisión de alcance**, que se corrigió en la rama. 7 P2.

### P1-1 — un VENDEDOR seguía viendo `PED-…` de pedidos de otros vendedores (corregido)

En los mismos dos mensajes de D-275 (`reservation-guard.ts`, `raw-material.ts`), los titulares
firmes se nombraban con el código del pedido sin mirar quién lee. Escenarios: un VENDEDOR que
despacha y deja el producto por debajo de lo reservado por el pedido de otro vendedor; o que
reserva/confirma la venta de una bobina entera contra un pedido firme de otro sobre el agregado.

**Decisión de la sesión:** se aplica el mismo criterio. No es política nueva: D-238 ya cierra los
pedidos ajenos a un VENDEDOR (404) y RF-S3c dice que lo ajeno no se muestra. Se registra en
D-275. Un pedido de otro vendedor (o sin vendedor) se nombra «pedido no disponible»
(`firmHolderCode` en `reserved-ledger.ts`). Tests en `reservation-guard.spec.ts` y
`raw-material.spec.ts`.

### P2

| #   | Hallazgo                                                                                                                                                                                      | Estado                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | El guard de `smoke:prod` aceptaba cualquier `*.vercel.app` y cualquier host con `ayr` (p. ej. `ayr.evil.com`), y a esa URL van las credenciales del admin efímero.                            | **Corregido:** lista exacta (`v2.mareliac.pe`, `ayr-steel-erp-web.vercel.app`) y casos negativos en el test.                         |
| 2   | Ningún test detecta si el despacho deja de pasar el `viewer` a `InventoryService.record`; el E2E cubre solo el camino de «Reservar».                                                          | Pendiente: un spec de servicio de `DispatchesService` que verifique el `viewer`.                                                     |
| 3   | Con `E2E_API_PORT` puesto y un `next dev` vivo en 3001 apuntando a 3000, Playwright lo reusaba.                                                                                               | **Corregido:** con `E2E_API_PORT` el web no se reusa. `scripts/e2e-latency.mjs` sigue con 3000 fijo (pendiente, herramienta aparte). |
| 4   | D-276 + D-269 (c): el «origen» del producto nuevo puede ser un precio de otra unidad; solo falla por coincidencia numérica. Una línea nueva en la posición de una quitada queda como editada. | Aceptado y escrito en D-276 (del lado seguro para el barrido).                                                                       |
| 5   | `quotations.service.ts`: `unit: true` en `previousLines`, sin uso tras D-276.                                                                                                                 | **Corregido.**                                                                                                                       |
| 6   | `DUMMY_HASH_PROMISE` (`auth.service.ts`) sigue con costo de producción; los `it` de login con email inexistente pueden seguir cerca de los 5 s con la máquina cargada.                        | Pendiente, fuera de la deuda (e), que era el `beforeAll`.                                                                            |
| 7   | El E2E de D-275 no purga el cliente ni los dos usuarios VENDEDOR.                                                                                                                             | Pendiente; mismo patrón que `coil-pool-alcance-vendedor-sm-p1-1.spec.ts`.                                                            |

## Verificado sin hallazgos (resumen del revisor)

- Los otros llamadores sin `viewer` (`assertNotReserved`, `assertCoilsNotReserved`,
  `assertRawMaterialInvariant` en coils, cutting e `inventory.reverse`, `findRawMaterialShortfalls`
  en el montaje de OP) son de roles no VENDEDOR. La venta de mostrador pasa por
  `createReservations` y `dispatches.createInTx` con el `actor`.
- «Propia» se decide igual que `quotationSellerWhere`/`assertSellerAccess` (`sellerId`), y sin
  vendedor cuenta como ajena, como en D-267.
- Los tests nuevos fallarían sin el arreglo; el E2E llega al camino real.
- `PricedLine` sin `unit` no rompe llamadores; `e2eApiPort` valida bien y `test:scripts` corre en
  CI.
