# Handoff — Importador de compras, edición de accesorio sin uso, inactivos del catálogo y purga de cotizaciones (D-348 a D-353)

**Estado al cierre: VENTANA PENDIENTE.** PR #46 (`feat/importador-compras`). Decisiones **D-348** a
**D-353** en `docs/ARQUITECTURA.md` §0.2. Guion UAT: `docs/uat/import-compras.md`. Guía del cliente:
`docs/cliente/revision-2026-09-25.md` §1.21. Plantillas: `docs/plantillas/importar-compras*.xlsx` y
`README-importar-compras.md`. Revisiones: `docs/revision/import-compras-autorrevision.md` y
`docs/revision/import-compras-segundo-modelo.md` (con la respuesta de la sesión al final de cada una).

## 1. Qué entró

| Milestone | Decisión     | Resumen                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | D-348        | Subtipo, espesor y color de un **accesorio** cambian si no tiene uso real (las cotizaciones anuladas o vencidas —también las EMITIDAS con `validUntil` pasado— no cuentan). Chequeo bajo `FOR UPDATE`; 409 que nombra qué lo usa; el SKU cambia con la estructura (error de campo `sku`); `canEditStructure`/`structureLockReason` en el DTO; duplicar una cotización cuyo producto cambió de forma rechaza con el motivo. Borrar sigue estricto (D-347). |
| M0b       | D-349        | Catálogo sin inactivos por defecto; chip «Inactivos» en la URL; buscar los encuentra; `GET /catalog?active=`.                                                                                                                                                                                                                                                                                                                                             |
| M0c       | D-350        | `pnpm purge:cancelled-quotations --numbers …` (dry-run por defecto): solo ANULADA sin pedido ni reservas temporales vivas; borra líneas, reservas RELEASED e historial de precio; audit `quotations.purge`; no toca R2 (lista los PDF huérfanos).                                                                                                                                                                                                         |
| M1–M4     | D-351, D-352 | Importador de compras: plantilla, preview sin estado, `/validate`, confirmar (SAVEPOINT por comprobante, todo o nada, idempotente), deshacer lote con motivo. Escribe solo por `PurchasesService.createInTx` y `SuppliersService.createInTx`; nace en BORRADOR. Doble conteo contra la carga inicial = «¿Es otra compra?». Migración aditiva `20260927200000_d351_importador_de_compras`.                                                                 |
| M5        | D-353        | «Recibir seleccionadas» en /compras (web, cada una por su `receive()`).                                                                                                                                                                                                                                                                                                                                                                                   |

**Decisiones del dueño en la sesión** (todas en §0.2): alcance de M0 solo donde involucra ACCESORIO;
qué no cuenta como uso real; fecha de emisión como dato del papel (sin regla de rol); columnas
agregadas a la plantilla (línea, condición de pago, tipo de servicio; solo factura/boleta; servicio
sin vínculo); TC SUNAT a la vista; SKU/acabado de otra línea = error de campo; purga sin R2; doble
conteo como aviso bloqueante con «Es otra compra»; **código corto del proveedor nuevo sugerido y
editable**; **SUPERVISOR_PLANTA también crea proveedores desde el padrón al importar** (recomendación
era exigir ADMINISTRADOR).

## 2. Lo que la sesión siguiente tiene que saber

- **`PurchasesService.create` ahora resuelve el TC antes de validar** (va a SUNAT antes de mirar el
  proveedor): en el alta manual, un TC que falla aparece antes que otros errores. Todo el resto
  del alta es idéntico; las validaciones leen de la transacción.
- **`PurchasesService.cancel` tiene `options.onlyDraft`**: lo usa deshacer lote para no anular una
  compra que se recibió en medio.
- **El importador valida contra `createPurchaseSchema`** además de sus reglas, con ids de relleno
  (los ids ya los resolvió el maestro).
- **Riesgo residual del lock de D-348** (el mismo de D-347): kardex y reservas son polimórficos,
  sin FK; los escritores conocidos pasan antes por una fila con FK. Un escritor nuevo de kardex de
  productos tiene que tomar el lock del producto.
- **La factura de referencia de la carga inicial es texto libre** (`… · factura ref: X · …` en las
  notas de la bobina y del movimiento): D-352 la compara por forma normalizada y sin proveedor.

## 3. Pendientes (P2 anotados de las revisiones)

- Cada revalidación vuelve a consultar el padrón y SUNAT (riesgo de 429 editando mucho).
- «Deshacer lote» solo desde la pantalla del resultado; no hay listado de lotes.
- El reintento idempotente no devuelve `createdSuppliers`.
- La selección de «Recibir seleccionadas» sobrevive a un cambio de filtro.
- El código externo de la bobina no se valida por repetidos ni se muestra en el detalle de la compra.
- El filtro de inactivos (D-349) es de la UI; el API sigue trayendo el catálogo entero por defecto.
- La CLI de la purga usa `PrismaClient` directo (como `retire:boms`), no `NestFactory`.
- Sin E2E del bloqueo de la purga por reserva temporal viva (solo unitarios).
