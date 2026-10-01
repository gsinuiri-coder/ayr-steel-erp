# Diagnóstico: reactivar el comprobante manual BBV1-00000341 — 2026-10-01

**Solo diagnóstico.** Esta sesión no tiene código de producto ni escrituras. Se apoya en la lectura
del código en `origin/main` = `a1fa929` y en una foto de producción tomada en una transacción
`READ ONLY` (§1.1), corrida con el OK del dueño (D-251).

**Contexto (dueño).**

- El dueño anuló por error el comprobante **manual** `BBV1-00000341`. Ningún comprobante pasa por
  Nubefact.
- Al reingresarlo, el sistema rechaza el número duplicado, y es correcto que lo rechace.
- Hay que **reactivar el anulado**, no crear otro.

## 1. Qué era 341 y qué hizo la anulación

### 1.1 La foto de producción

Foto `READ ONLY` de producción del **2026-10-01 a las 09:26 UTC**, tomada con el OK del dueño. El
JSON completo está en `local-data/reactivar-341/insp-production.json`, fuera de git porque trae
datos reales. Acá no se transcriben nombres de clientes ni importes.

- **Comprobante.** `BBV1-00000341` es una **BOLETA**, `origin = MANUAL`, emitida el 2026-08-03 y no
  archivada. Hoy está **`ANNULLED`** desde el **2026-10-01 06:19:10 UTC**, con el motivo **«mal
  despacho»**. Pertenece al pedido **PED-000048**, que hoy está `CONFIRMED`. No tiene despacho
  declarado propio (`dispatch_id` nulo).
- **Líneas:**
  - 1: `UPVC36MT` 12;
  - 2: `AUTOPERF10X1` 100.
- **Cobros y notas de crédito.** **Ninguno**: no hay filas en `customer_payments` ni documentos que
  afecten a 341.
- **Otros documentos del pedido.** Hay **un borrador**: una BOLETA en `DRAFT` sin número, creada el
  2026-10-01 a las 06:20:28 UTC, 78 segundos después de la anulación. Por la hora y el pedido es el
  intento de reingreso: su registro manual chocó con el número de 341 y quedó como borrador. Sus
  líneas no se leyeron en esta foto.
- **Reservas.** Las dos líneas siguen con su reserva de producto **`ACTIVE`** (12 y 100): nada se
  despachó vigente.
- **Despachos.** El **despacho 35**, del 2026-08-03, sacó la línea 1 (`UPVC36MT` 12). Hoy está
  **`REVERSED`**. Su salida de kardex fue un `SALE OUT 12` el 2026-08-03. Por la regla dura 8, su
  reversa es un movimiento inverso; esta foto no lo leyó.
- **Auditoría de 341:**
  1. `invoicing.document.create` y `register-manual` el 2026-09-28 a las 20:00 UTC: nace
     `MANUAL`/`ACCEPTED`.
  2. `invoicing.dispatch-at-issue-date` el mismo día a las 20:00:57: la línea 1 se despachó a la
     fecha del papel (el despacho 35) y la línea 2 quedó en `REVIEW`, porque su salida dejaba negativo
     `AUTOPERF10X1` el 2026-08-03. Eso es el `BLOQUEADO-RECOSTEO` de la foto del 29.
  3. `invoicing.import.annul` el 2026-10-01 a las 06:19:10: `before {status: ACCEPTED}` →
     `after {status: ANNULLED, reason: "mal despacho"}`.

**Lectura de la secuencia.**

- La reversa del despacho 35 **no la hizo la anulación**: `annulExternal` no toca despachos (§1.2), y
  su auditoría solo registra el cambio de estado.
- Es una operación aparte, coherente con el motivo «mal despacho». Su hora exacta no se leyó en esta
  foto.
- Lo que hay que deshacer es **solo la anulación**. El despacho 35 queda revertido, como lo dejó el
  dueño.
- Al reactivar, las dos líneas vuelven a estar facturadas y pendientes de despacho:
  - la línea 1 por la reversa;
  - la línea 2 por el `REVIEW` de D-285.

**Antecedente en el repo.** La inspección `READ ONLY` del 2026-09-29 a las 17:55 UTC
(`docs/PROGRESO.md`, sección «D-363, deploy de PR #58») encontró a 341 **`ACCEPTED`** y **pendiente del
despacho D-285**, en estado `BLOQUEADO-RECOSTEO`:

- su salida en la fecha automática dejaba negativo `AUTOPERF10X1` el 2026-08-03
  (`docs/analisis/fecha-despacho-2026-09-29.md`);
- no tenía despacho declarado.

La anulación ocurrió después de esa foto.

### 1.2 Qué hace exactamente la anulación (código)

La anulación interna de un comprobante que el ERP no emitió es
`FiscalImportService.annulExternal` (`apps/api/src/invoicing/fiscal-import.service.ts:43-142`, D-110/D-153).
Hace esto y nada más:

1. **Lock** de la fila con `SELECT … FOR UPDATE` (`:52-54`).
2. **Guardrails:**
   - no alcanza a `ISSUED_HERE` (`:71-75`);
   - un segundo intento devuelve 409 (`:78-80`);
   - solo anula `ACCEPTED` (`:81-85`);
   - no anula una versión archivada (`:88-92`).
3. **Bloqueos:**
   - **cobros vigentes** (`customer_payments.reversed_at IS NULL`, `:97-104`);
   - **notas de crédito vivas** (`:105-119`).

   Si los hay, no anula.

4. **Una sola escritura:** `status = ANNULLED`, `annulled_at`, `annulled_by_id` y `annul_reason`
   (`:121-130`).
5. **Auditoría** `invoicing.import.annul`, con `before {status, totalPen}` y
   `after {status: ANNULLED, reason, number}` (`:132-139`).

**Lo que no hace:**

- No escribe kardex.
- No toca reservas, despachos ni el pedido.
- No revierte cobros: no puede haberlos vigentes.
- No crea notas de crédito.

Todo lo que «deshace» lo deshace **por lectura**: cada consulta que filtra
`LIVE_DOCUMENT_STATUSES` (`packages/shared/src/enums.ts:934`: `ISSUED`, `SEND_ERROR`, `ACCEPTED`,
`VOID_PENDING`) deja de ver a 341. En concreto:

- **Facturación del pedido.** Las líneas de 341 dejan de contar como facturadas: `invoicedByOrderItem`
  (`apps/api/src/invoicing/invoicing-net.ts`) solo suma vivos. Por eso la línea del pedido aparece otra
  vez «por facturar», y por eso se pudo armar un borrador nuevo para reingresarlo.
- **Deuda.** Sale del saldo propio, del listado y de cuentas por cobrar (D-110).
- **D-285 e inventario.** Deja de figurar como «sin despacho declarado» y como pendiente del despacho
  rápido (D-363).
- **Reportes de ventas.** Sale de «Ventas y margen», «Ventas por material» y la rentabilidad.

**Consecuencia para el diseño.** Reactivar no tiene nada que «devolver» en kardex, reservas ni
cobros: basta restaurar el estado. Lo que **sí** cambió mientras estuvo anulado es lo que otros
pudieron hacer con las líneas «liberadas»:

- un borrador o un comprobante nuevo sobre las mismas líneas del pedido;
- un despacho de esas líneas.

Eso es lo que la reactivación tiene que comprobar (§3).

## 2. Unicidad de serie + número: incluye a los anulados

- El número del comprobante manual es el string `SERIE-CORRELATIVO`, por ejemplo `BBV1-00000341`
  (`fiscalDocumentNumber`, `invoicing.service.ts:1211`).
- Su unicidad es el índice parcial **`fiscal_documents_number_active_key`**: `UNIQUE ("number")
WHERE "archived_at" IS NULL`
  (`apps/api/prisma/migrations/20260905170100_fase7c_comprobantes_importados/migration.sql:24`). Ese
  índice reemplazó al `UNIQUE` total de la Fase 5b.
- El filtro es por **archivado**, no por estado. Un `ANNULLED` sigue ocupando su número.
- `registerManual` lo comprueba antes con el mismo criterio
  (`findFirst({ number, archivedAt: null, id: { not: id } })`, `invoicing.service.ts:1214-1222`) y
  traduce el `P2002` del índice (`:1237-1243`).
- Por eso el reingreso de 341 se rechazó con «Ya hay un comprobante registrado con el número …». **Es
  correcto:** el papel `BBV1-00000341` existe una sola vez, y un segundo documento con ese número
  duplicaría la venta.

## 3. Diseño propuesto — D-373 «Reactivar comprobante manual anulado por error»

**Propuesta para decisión del dueño.** No se implementa en esta sesión.

### 3.1 Regla

`POST /invoicing/documents/:id/reactivate`, con cuerpo `{ reason }` (motivo obligatorio, 3 a 240
caracteres) e `idempotencyKey`.

- Solo **ADMINISTRADOR**.
- Solo `origin ∈ {MANUAL, IMPORTED}`. Es la misma frontera que la anulación interna (D-153): un
  `ISSUED_HERE` se deshace ante SUNAT y no se reactiva desde acá.
- Solo `status = ANNULLED`, y solo la versión no archivada (`archived_at IS NULL`).

### 3.2 Bloqueos

Todos se evalúan dentro de la transacción, después del lock de la fila.

1. **Cobros posteriores a la anulación.** Cualquier `customer_payment` del documento con
   `created_at > annulled_at` bloquea. Hoy no puede existir: un anulado no se cobra
   (`receivables.service.ts:133`). El chequeo queda como defensa ante datos escritos por otro camino.
   Los cobros revertidos **antes** de anular siguen revertidos y no se tocan.
2. **Notas de crédito.**
   - Cualquier nota de crédito que afecte al documento, viva o creada después de la anulación,
     bloquea.
   - Hoy tampoco puede existir: solo se acredita un `ACCEPTED` (`invoicing.service.ts:961`).
   - Una nota de crédito **anulada antes** de la anulación del comprobante no bloquea; queda como
     está.
3. **Las líneas del pedido ya se volvieron a facturar.**
   - Se repite el chequeo de emisión: `assertStillAvailable` con
     `invoicedByOrderItem(…, { excludeDocumentId: id })`, en `invoicing.service.ts:1810-1889`.
   - Si otro comprobante vivo facturó esas líneas mientras 341 estuvo anulado, reactivarlo las
     facturaría dos veces: bloquea y nombra el comprobante.
4. **Borradores sobre las mismas líneas** (el intento de reingreso). Un borrador no cuenta para el
   chequeo de emisión, pero quedaría huérfano: al registrarlo después chocaría con 341 ya vivo.
   - **Recomendación:** bloquear, nombrar el borrador y pedir que se elimine primero (es una acción
     explícita y ya existe).
   - Alternativa: reactivar y avisar. No se recomienda porque deja un borrador condenado.
   - **Para 341 este caso existe hoy:** la BOLETA en `DRAFT` del pedido PED-000048, creada a las 06:20
     UTC (§1.1). El paso previo a reactivarla es eliminar ese borrador.
5. **Despachos.**
   - La anulación no tocó despachos.
   - Si mientras estuvo anulado se despacharon esas líneas por otro camino, ese despacho ya consumió
     stock. Reactivar no lo duplica: D-285 calcula lo pendiente por lo despachado vigente.
   - No bloquea; se informa en la respuesta.

### 3.3 Qué restaura y cómo, append-only

- **Estado.** Vuelve al que tenía al anularse, leído de la auditoría
  (`invoicing.import.annul.before.status`), que siempre es `ACCEPTED`: la anulación no acepta otro
  (`:81`). Se exige que el registro de auditoría exista. Sin él, no se reactiva.
- **La fila.** El `CHECK` bicondicional `("status" = 'ANNULLED') = ("annulled_at" IS NOT NULL)`
  (`migrations/20260905233000_m4_check_de_anulacion_bicondicional/migration.sql:9`), junto con el que
  exige las tres columnas juntas (`20260905220100_m4_anulacion_de_importado/migration.sql:19-20`),
  **obliga a vaciar** `annulled_at`, `annulled_by_id` y `annul_reason` al volver a `ACCEPTED`. Así,
  la fila no puede guardar la constancia de la anulación.
- **La historia vive en `audit_log`, que es append-only (RF-95).** Se conservan dos eventos:
  - el `invoicing.import.annul` original, que no se toca;
  - un nuevo **`invoicing.document.reactivate`**, con `before` = {status `ANNULLED`, `annulledAt`,
    `annulledById`, `annulReason`} y `after` = {status `ACCEPTED`, `reason` de la reactivación,
    número}.

  Con eso la anulación y su reversa quedan legibles en orden, sin editar historia.

- **Alternativa con migración**, no recomendada ahora: columnas `reactivated_at/_by/_reason` en la
  fila. Duplica lo que la auditoría ya guarda y obliga a revisar los `CHECK`, que es la trampa de
  D-153.
- **Nada más que revertir.** La anulación no escribió kardex, reservas, cobros ni despachos (§1.2),
  así que la reactivación tampoco los escribe. Los efectos por lectura vuelven solos:
  - las líneas cuentan otra vez como facturadas;
  - la deuda vuelve a cuentas por cobrar con su saldo (cobros vigentes menos notas de crédito
    vivas);
  - el comprobante vuelve a «sin despacho declarado» y a la lista de D-285. Para 341, eso es volver a
    `BLOQUEADO-RECOSTEO`: el despacho sigue pendiente de la decisión del dueño, como antes de
    anularlo.
- **Fechas.** `issue_date`, `issued_at` y `accepted_at` se conservan. Reactivar no es emitir.

### 3.4 Concurrencia, idempotencia y pantalla

- **Concurrencia.** Se toma `SELECT … FOR UPDATE` sobre la fila, igual que `annulExternal`.
  - Hoy `registerManual` solo bloquea la fila de **su** documento (`invoicing.service.ts:1173-1175`),
    así que una reactivación y el registro de un borrador sobre las mismas líneas podrían pasar el
    chequeo de disponibilidad a la vez.
  - **Propuesta:** que los dos caminos tomen también el lock de la fila del pedido
    (`sales_orders … FOR UPDATE`) antes de comprobar la disponibilidad.
  - Si no se agrega, queda una ventana estrecha. El bloqueo por borrador del §3.2.4 la reduce, pero
    no la cierra.
- **Idempotencia.** Se usa `idempotencyKey`, regenerada si cambia el motivo. Un segundo intento
  sobre un documento ya `ACCEPTED` devuelve 409 («ya está vigente»).
- **Pantalla.** En el detalle de un comprobante `ANNULLED` de origen `MANUAL` o `IMPORTED`, y solo
  para el administrador, va el botón **«Reactivar (anulado por error)»** con un diálogo de motivo
  obligatorio que muestra la fecha, el autor y el motivo de la anulación.
- **Pruebas.**
  - Unitarias: cada bloqueo, la restauración y la auditoría.
  - E2E: anular → reactivar, verificando la deuda, la línea facturada, D-285 y el historial; además,
    los bloqueos por borrador, por otro comprobante y por nota de crédito.

## 4. BBV1-00000347

**Sigue `ACCEPTED`**, según la misma foto del 2026-10-01 a las 09:26 UTC:

- BOLETA `MANUAL` del 2026-08-14, pedido PED-000046 (`CONFIRMED`);
- `annulled_at` nulo;
- sin cobros ni notas de crédito;
- su auditoría solo tiene `create` y `register-manual` del 2026-09-28.

Sus dos líneas (`AUTOPERF10X1` 500 y `AUTOPERF12X212` 500) conservan la reserva `ACTIVE` y no tienen
despacho. Sigue pendiente del despacho D-285 (`BLOQUEADO-RECOSTEO` en la foto del 29), sin cambios.

**Numeración.** D-373 se reserva para esta propuesta, después de D-368..D-372 del PR #65 (cc06,
abierto). La fila de §0.2 se escribe cuando el dueño la apruebe, sobre un `main` que ya tenga #65,
para no chocar con las filas de ese PR.

## 5. Qué decide el dueño

1. Aprobar D-373 tal como está en §3, o con cambios.
2. Qué hacer con un borrador del reingreso: bloquear hasta que se elimine (recomendado) o reactivar y
   avisar.
3. Si la constancia de reactivación queda solo en `audit_log` (recomendado, sin migración) o también
   en columnas de la fila (con migración).

## 6. Cómo se tomó la foto de producción

Se usó un script de una sola sesión, fuera del repo. Abre una transacción `SET TRANSACTION READ
ONLY`, lee las tablas de §1.1 para `BBV1-00000341` y `BBV1-00000347`, y guarda el resultado completo
en `local-data/` (ignorada por git: trae datos reales). La credencial de la rama viaja por el entorno
del proceso (`scripts/lib.mjs#neonConnectionString`, salida silenciosa) y no se imprime. Las columnas
se validaron antes contra la base local `ayr_local_e2e`.
