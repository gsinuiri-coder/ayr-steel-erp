# cc19 — estados de la columna «Comprobante» (D-387): autorrevisión

> **Autorrevisión — no vale como pase cruzado.** Subagente nuevo, sin leer el handoff de
> implementación ni `docs/PROGRESO.md`. Es una lista de riesgos, no una aprobación.

Diff revisado: `87dfa20..2c57ed2` (worktree `ayr-cc19`).

Lo que corrió:

- `npx jest src/sales/imported-invoice-d387.spec.ts src/common/list-orderings.spec.ts`: 104 en verde.
- `npx jest src/sales src/common`: 56 suites y 748 tests en verde.
- `turbo typecheck --filter=@ayr/api --filter=@ayr/web`: en verde.

No corrí Playwright, `next build` ni `dev`.

## Resumen

No encontré ningún P0 ni P1. Lo que sí quedó verificado:

- **Qué cuenta como vigente.** `liveInvoiceDocuments` (`apps/api/src/sales/quotations.service.ts:97`) filtra por FACTURA/BOLETA, `LIVE_DOCUMENT_STATUSES` (ISSUED, SEND_ERROR, ACCEPTED, VOID_PENDING), `archivedAt: null` y `number` no nulo. Por eso quedan fuera DRAFT, REJECTED, VOIDED, ANNULLED, las archivadas y las notas de crédito. El pedido anulado queda fuera por el `where` de `salesOrders` (`status != CANCELLED`) en el include, en `findPageByImportedInvoice` y en la búsqueda.
- **Alcance por vendedor.** `quotationSellerWhere` solo agrega `sellerId` en la raíz del `where`. Los ids de `idsByInvoiceNumber` (que se calculan sin alcance) entran únicamente dentro del `OR` del buscador, y Prisma combina ese `OR` con `sellerId` mediante AND. Una cotización ajena no se cuela. Las dos consultas de candidatos tampoco devuelven datos al cliente.
- **Otros consumidores.** `quotationInclude` y el DTO solo los consumen `toDto`, `findAll`, `findOne` y las mutaciones que devuelven `toDto`. Agregar `fiscalDocuments` dentro de `salesOrders.select` no cambia ni el `where` ni el `take` de `salesOrders`, así que confirmar y duplicar siguen viendo el mismo pedido. El costo es una ida a la base más por lectura (lo detallo en P2-2). `invoiceDocumentsOf` tolera `fiscalDocuments` ausente, y por eso los mocks viejos de otras specs siguen en verde.
- **Enlace al comprobante.** El link `/comprobantes/:id` lo ven ADMINISTRADOR y VENDEDOR, los mismos roles que `/cotizaciones` (`INVOICE_LINK_ROLES`), así que no hay enlaces muertos por rol.

## P2

### P2-1 — «No coincide» se distingue solo por el color y por un `title`

- **Dónde:** `apps/web/src/components/sales/quotation-invoice.tsx:51-68`.
- **Escenario:** en el estado MISMATCH, lo único que lo separa de «registrado» es el tono ámbar y la ausencia del check. Los dos números (sistema y Excel) viven solo en el atributo `title`. Un lector de pantalla anuncia únicamente el número del sistema, sin aviso. Con teclado no hay tooltip, porque el foco cae en el `<Link>` y el `title` está en el `<span>` padre. Quien distingue mal el ámbar del texto normal ve un número sin check y no sabe por qué. Esto choca con WCAG 1.4.1 (uso del color). Lo mismo pasa con «solo referencia»: el gris más el `title` es todo lo que la separa de un número de verdad, y no tiene texto accesible.
- **Arreglo:** dar a cada estado un indicador que no dependa del color: un ícono de aviso (`TriangleAlert`) en MISMATCH y uno neutro o «ref.» en REFERENCE. Agregar un texto `sr-only` («no coincide con el Excel FFA1-1000», «solo referencia del Excel») o `aria-describedby`. Si la explicación tiene que leerse sin mouse, pasar a un `Tooltip` de shadcn que responda al foco.

### P2-2 — Buscar con dígitos sueltos trae todos los comprobantes del sistema

- **Dónde:** `apps/api/src/sales/quotations.service.ts:1423-1462`.
- **Escenario:** el sistema guarda el correlativo con ocho dígitos (`FFA1-00001419`). Una búsqueda sin serie como «0», «00» o «1» entra por `number: { contains: search, mode: 'insensitive' }`, y en la práctica coincide con todas las facturas y boletas vivas de la base (todas llevan ceros). `invoiceNumberContains` las confirma todas, y el `{ id: { in: [...] } }` resultante lleva miles de ids. Va dos veces, en `count` y en `findMany`, o en la carga completa si además hay `sort=invoice`. Es correcto según «contiene», pero el costo crece con todo el histórico de comprobantes y no con la página. `ILIKE` tampoco usa el índice de `number`. Antes del cambio solo se escaneaban las importadas.
- **Arreglo, cualquiera de estos:**
  - exigir un mínimo de caracteres, o al menos un dígito distinto de cero, antes de buscar por comprobante;
  - acotar la consulta de comprobantes al alcance del actor (`salesOrder.quotation.sellerId` para VENDEDOR) y poner un tope;
  - en Postgres, resolver con un `EXISTS` sobre `salesOrders.some.fiscalDocuments.some` dentro del mismo `where`, en lugar de traer ids a memoria. Esto pierde la normalización de ceros, que se puede recuperar buscando también por el correlativo con ceros.

  Con cualquiera de los tres, medir con datos de producción en tamaño realista.

## P3

### P3-1 — «Registrado» con varios comprobantes muestra el primero aunque no sea el que coincide

- **Dónde:** `packages/shared/src/schemas/quotation-import.ts:695-705`, `quotation-invoice.tsx:43-50`. Spec que lo consagra: `apps/api/src/sales/imported-invoice-d387.spec.ts:123`.
- **Escenario:** la marca dice `FFA1-1419` y el pedido tiene `FFA1-00001400` (anterior) y `FFA1-00001419`. El estado es REGISTERED y la celda muestra `FFA1-00001400` con check y «+1». El tooltip lista los dos, pero nunca nombra el número del Excel. Quien lee la fila cree que el Excel decía 1400. El orden de la lista también usa 1400.
- **Arreglo:** en REGISTERED con `reference`, poner primero el comprobante que coincide (reordenar `docs`) o mencionar el número del Excel en el tooltip. Ajustar la spec.

### P3-2 — El buscador sin serie no encuentra comprobantes del sistema por un fragmento con serie parcial

- **Dónde:** `quotations.service.ts:1424` y `:1446-1449`.
- **Escenario:** una búsqueda como «A1-1419» (la serie cortada) no activa la regex de serie de 4 caracteres. Postgres compara `number ILIKE '%A1-1419%'` contra `FFA1-00001419` y no hay coincidencia, así que la cotización **no importada** con ese comprobante no aparece. La importada sí aparece por la marca.
- **Escenario relacionado:** la búsqueda «FFA1-0001» se normaliza a `FFA1-1` y trae también `FFA1-12`, `FFA1-1000`, etc. Sobra resultado; no es grave.
- **Arreglo:** si se quiere, extraer el correlativo con la regex `-(\d+)$` y buscar `endsWith` sobre el número con ceros. Si no, documentarlo como límite.

### P3-3 — VOID_PENDING cuenta como «registrado» con check

- **Dónde:** `liveInvoiceDocuments` (`quotations.service.ts:97`).
- **Escenario:** una factura con la baja pedida a SUNAT y todavía pendiente se ve con check, como vigente. Es coherente con `LIVE_DOCUMENT_STATUSES` (sigue siendo vigente hasta que SUNAT responda), pero el usuario no recibe ninguna señal. Algo parecido pasa con una factura anulada del todo por una nota de crédito: sigue figurando como registrada. Así lo pide el brief («las NC no cuentan»), pero el dueño debería saberlo.
- **Arreglo:** decisión del dueño. Como mínimo, dejar el criterio escrito en la D-387.

### P3-4 — El orden con serie de forma distinta empata todo en cero

- **Dónde:** `compareImportedInvoiceNumbers` (`quotation-import.ts:627`), usada ahora con números del sistema.
- **Escenario:** si algún comprobante vivo tiene un `number` que no calza con `^[A-Z][A-Z0-9]{3}-\d{1,8}$` (por ejemplo, uno importado en la Fase 7c con otra forma), su serie queda en `''` y su correlativo en 0. Se ordena antes que todos y empata entre sí. Los de alta manual y por serie del ERP sí validan la forma, así que hoy es improbable.
- **Arreglo:** comprobarlo con un conteo en `demo` (`number !~ '^[A-Z][A-Z0-9]{3}-\d{1,8}$'`). Si aparece alguno, desempatar por texto.

### P3-5 — Accesibilidad del check y de «+N»

- **Dónde:** `quotation-invoice.tsx:60` y `:67`.
- **Escenario:** el `<Check aria-label>` de lucide 1.39 deja de llevar `aria-hidden`, pero es un `<svg>` sin `role="img"`, y algunos lectores ignoran el `aria-label` de un svg sin rol. El «+1» se anuncia como «más uno», sin contexto. Fuera de MISMATCH, la lista de los otros números solo está en el `title`.
- **Arreglo:** usar `role="img"` en el ícono, o un `<span className="sr-only">Comprobante registrado</span>` con el ícono `aria-hidden`. Para «+N», un `sr-only` que diga «y N comprobantes más: …».

### P3-6 — Tests débiles

- **`sort=invoice … con dos consultas y sin count` (`imported-invoice-d387.spec.ts:264`).** Cuenta las llamadas a `findMany` del mock. Con el nuevo `select` anidado (`salesOrders → fiscalDocuments`), Prisma hace más idas reales a la base (una por relación) y el mock no lo ve. El nombre del test promete un presupuesto de consultas que no mide. Ajustar el título o medir con Prisma real.
- **Filtro de la búsqueda (`:309`).** El `toMatchObject` sobre el `where` de los comprobantes no comprueba `salesOrder: { status: { not: CANCELLED }, quotationId: { not: null } }`: si se quita ese filtro, la spec sigue en verde.
- **Filtro del include.** Ningún unitario comprueba el filtro que se pasa en `quotationInclude` / `findPageByImportedInvoice`, porque el mock ignora el `select`. La exclusión de DRAFT, REJECTED, VOIDED, archivadas y NC solo la cubre la constante compartida. En E2E solo se ejerce ANNULLED (el alta manual anulada). VOIDED, REJECTED, borrador, archivada y nota de crédito no tienen prueba que corra contra Postgres.
- **Componente.** `QuotationInvoice` no tiene test de componente; los cuatro estados solo se cubren en Playwright.

### P3-7 — Nombre heredado

- **Dónde:** `findPageByImportedInvoice` (`quotations.service.ts:1471`).
- **Detalle:** ahora ordena también por comprobantes del sistema. Sería más claro llamarlo `findPageByInvoiceNumber`, en línea con `orderByInvoiceNumber`.

## Lo que no revisé

- El render real en 1366/1920 px y el contraste del ámbar: dependen de Playwright, que no corrí.
- Los tiempos medidos contra Neon.
