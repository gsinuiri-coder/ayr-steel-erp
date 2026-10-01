# Revisión de segundo modelo — cc07 (D-373, reactivar comprobante manual/importado anulado)

- **Modelo:** Sonnet 5.5 (contexto limpio; no leyó handoff de implementación)
- **Fecha:** 2026-10-01
- **Rama:** `cc07/reactivar-comprobante`
- **Rango:** `origin/main...HEAD` = `5536da6`, `f6519cc`, `0d19ea4` (3 commits, 11 archivos)
- **Alcance:** diff completo. Contrastado con AGENTS.md §3, `docs/analisis/reactivar-comprobante-2026-10-01.md` y las migraciones de CHECK de `fiscal_documents`. No se ejecutaron tests; es lectura de código.

> Informe transcripto tal como lo devolvió el subagente. Las correcciones aplicadas están al final,
> en «Qué se hizo con cada hallazgo».

## Resumen

El servicio cumple los requisitos del dueño: solo ADMINISTRADOR (decorador y servicio), solo ANNULLED no archivado, motivo y casilla obligatorios, bloqueos, auditoría con copia de la anulación, no despacha, lock más `updateMany` condicionado. Los CHECK de `fiscal_documents` se verificaron y son compatibles. Hay un hallazgo P1 (no hay filtro por tipo de documento: una nota de crédito manual anulada se puede reactivar con lógica de líneas pensada para facturas) y un P2 de carrera. El resto son P3.

## Verificado sin hallazgo

- **CHECK de la fila.** Al pasar a `ACCEPTED` con `annulled_at/by/reason = NULL`:
  - `annul_shape_ck` (las tres columnas nulas) se cumple.
  - `annulled_trace_ck` bicondicional (`status = ANNULLED` equivale a `annulled_at IS NOT NULL`) se cumple.
  - `annulled_origin_ck`, ya ensanchado por `20260908213000` a `origin <> ISSUED_HERE`, no interviene.
  - `number_ck`, `shape_ck` y `archive_ck` no cambian porque no se tocan esos campos.
  - Vaciar los tres campos es obligatorio y se hace en el mismo `updateMany`.
- **Unicidad del número.** El índice parcial `UNIQUE(number) WHERE archived_at IS NULL` sigue ocupado por el anulado. Reactivar no puede crear duplicados, y el número no cambia.
- **Locks y versión.**
  - `SELECT … FOR UPDATE` sobre la fila, la misma que usan anular y cobrar (`receivables.service.ts:101,207`).
  - `updateMany where status=ANNULLED` más `count !== 1` da 409.
  - La auditoría se escribe dentro de la transacción y solo si el cambio se aplicó.
- **Permisos.** `@Roles(ADMINISTRADOR)` en el controlador y chequeo de rol en el servicio.
- **Decimal.** `assertLinesNotReinvoiced` usa `Decimal` y `toDecimal` de punta a punta; no hay `number` para cantidades.
- **Cobros y notas de crédito.** El criterio `reversedAt null OR createdAt > annulledAt` es correcto: un cobro revertido antes de anular no bloquea.
- **Idempotencia.** El segundo intento da 409 («ya está vigente»).
- **Regresión en RowActions.** `primary === null` solo cambia el comportamiento para quien pasa `null`; el resto de los usos no cambia.
- **Regresión en DispatchAtIssueDate.** `suggestedDate` solo siembra el estado inicial; sin la prop se comporta como antes.
- **Lista de comprobantes.** La columna y el `colSpan` van condicionados a `isAdmin`; `canReactivate` coincide con lo que la API acepta (salvo el P1).
- **E2E, bloque final.** `draft2` se crea después de volver a anular, así que `resolveLines` no lo rechaza por «línea ya facturada». El orden es correcto.

## P0

Ninguno.

## P1

### P1-1. Una nota de crédito manual anulada se puede reactivar con la lógica equivocada

- **Dónde:**
  - `apps/api/src/invoicing/fiscal-import.service.ts:189-300` (no hay filtro por `docType`).
  - `apps/web/src/components/invoicing/reactivate-document-dialog.tsx:33-41` (`canReactivate` tampoco filtra).
- **Escenario.**
  - `annulExternal` no restringe `docType`, y `registerManual` permite cerrar una NC como manual.
  - Una NC manual `ACCEPTED` se anula por error. Mientras tanto la factura afectada puede anularse, porque la NC anulada ya no cuenta como «viva».
  - Reactivar la NC la devuelve a `ACCEPTED` sobre una factura anulada, y nada lo detecta: el servicio no mira `affectedDocumentId`.
  - Además, `assertLinesNotReinvoiced` trata las líneas de la NC como si fueran de una factura. Da bloqueos falsos o pasa cuando no debería.
  - El chequeo de borradores usa `salesOrderItemId`, que las NC también guardan, así que un borrador de factura puede bloquear la reactivación de una NC sin relación.
- **Corrección sugerida.** Decidir con el dueño (D-230) si se reactivan NC.
  - Lo más simple es rechazar `docType === NOTA_CREDITO` en el servicio, con mensaje claro, y ocultar la acción en `canReactivate`.
  - Si se quiere soportar, hay que:
    - exigir que el afectado esté `ACCEPTED`;
    - re-validar el tope acreditable por línea;
    - excluir NC de la cuenta de líneas.
- **Prueba faltante.** Un caso de NC en el spec unitario.

## P2

### P2-1. Carrera con un borrador que se está registrando o emitiendo a la vez

- **Dónde:** `fiscal-import.service.ts:258-286` (conteo de borradores y `assertLinesNotReinvoiced`) frente a `registerManual` y `assignInTx`.
- **Escenario.**
  - `registerManual` y la emisión bloquean solo su propio documento.
  - Transacción A (registrar el borrador D como manual): pasa `assertStillAvailable`, porque 341 está anulado, y aún no hace commit.
  - Transacción B (reactivar 341): ve a D todavía como `DRAFT` y las líneas sin refacturar, y hace commit.
  - A hace commit: D queda `ACCEPTED` sobre las mismas líneas y las líneas se facturan dos veces.
  - Es un caso raro (solo admin, ventana de milisegundos), pero justo el que los bloqueos dicen cerrar.
- **Corrección sugerida.** Antes de los chequeos, tomar `FOR UPDATE` de los borradores sobre esas líneas, ordenados por id. Así la reactivación espera al commit de A y lo ve ya `ACCEPTED`. Documentar el orden de locks para evitar deadlock.

## P3

### P3-1. Borradores de nota de crédito sobre el documento no se consideran

Un borrador de NC creado **antes** de anular no se mira. Es coherente con anular (que tampoco lo mira), pero conviene decirlo en el diseño o en un test.

### P3-2. Códigos HTTP inconsistentes entre bloqueos

Cobros, notas de crédito, rastro de PSE y estado inválido dan 400; borradores y refacturación dan 409. Es defendible (el 409 es por estado concurrente). Solo dejarlo anotado.

### P3-3. La nota «Comprobante reactivado» persiste mientras `?despacho=` siga en la URL

Si el usuario despacha una parte y recarga, el aviso y la fecha sugerida reaparecen. Es inofensivo, pero puede confundir. Opción: quitar el parámetro con `router.replace` tras el primer render.

### P3-4. Huecos de cobertura en los tests

- **Unitarios.** Faltan:
  - el bloqueo por rastro de PSE/baja, un caso por campo;
  - el documento sin `salesOrderItemId`;
  - la NC (ver P1-1).
  - Además, el orden de los `mockResolvedValueOnce` acopla el test a la secuencia de llamadas.
- **E2E.** No cubre:
  - el 403 de no administrador;
  - el bloqueo por línea refacturada;
  - el bloqueo por cobro o NC;
  - `ISSUED_HERE`.

  Un caso de «línea refacturada» sería el más valioso, porque ejercita `invoicedByOrderItem` real.

- **Web.** No hay test de la visibilidad de la acción ni de que un VENDEDOR no ve la columna.

## Veredicto

**Aprobado con correcciones: no hay P0.** P1-1 se corrige antes del deploy: bloquear `NOTA_CREDITO`, o decidir con el dueño su soporte, y tocar también `canReactivate`. P2-1 se recomienda corregir antes del deploy, porque es barato; si se difiere, registrarlo como riesgo conocido. P3 a criterio del dueño. Esta revisión es de un segundo modelo y no sustituye la revisión del dueño al cierre (AGENTS.md §2.2.3).

## Qué se hizo con cada hallazgo

- **P1-1. Corregido.** Bloqueo conservador:
  - el servicio rechaza todo lo que no sea `FACTURA` o `BOLETA`, con mensaje propio;
  - `canReactivate` oculta la acción para esos tipos;
  - hay un unitario de NC.

  **Pendiente de confirmación del dueño:** si alguna vez se quieren reactivar notas de crédito, va
  como decisión nueva.

- **P2-1. Corregido.** Antes de los chequeos, la reactivación bloquea:
  - la fila del **pedido**, el mismo lock que toman la creación de borradores y las ediciones
    D-187;
  - los **borradores** de esas líneas, ordenados por id.

  El orden de locks es comprobante → pedido → borradores. Ningún camino los toma al revés: la
  nota de crédito bloquea el afectado y después el pedido. Hay unitario del orden.

- **P3-1.** Anotado en D-373. Coherente con la anulación.
- **P3-2.** Anotado; se deja así.
- **P3-3.** Anotado. Quitar el parámetro borraría el aviso.
- **P3-4. Parcial:**
  - los 9 campos de PSE, `IMPORTED`, sin líneas de pedido y estado auditado distinto de
    `ACCEPTED`, en unitarios (28 en total);
  - el **E2E de línea refacturada** contra Postgres real;
  - NC, cobro y 403 siguen solo en unitarios.

Verificado después de las correcciones:

- unitarios del servicio, 28/28;
- E2E `reactivar-comprobante-d373` (3) y `despacho-fecha-comprobante-d278` (3): **6 passed**.
