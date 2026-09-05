# Handoff — Fase 7c, importación de comprobantes ya emitidos (RF-71, RF-72) — 2026-09-05

## 1. Resumen

Tercer y último tramo de la Fase 7. El primero (`docs/handoff/fase-7.md`) entregó la cola de
producción; el segundo (`docs/handoff/fase-7b.md`), el punto de venta de mostrador; este
entrega la **importación de comprobantes ya emitidos**, y con él la fila de la Fase 7 en
§3.7 queda **completa**. Cinco decisiones nuevas, **D-105..D-109**. RF-11, que figuraba en
esa fila, ya estaba entregado desde la Fase 2a: seguía ahí por arrastre.

Modelo en una línea: **el comprobante importado es el mismo comprobante con otro origen**
(D-105). Vive en `fiscal_documents` con `origin = IMPORTED` porque es el mismo documento
para todo lo que importa —la cuenta por cobrar, el estado de cuenta, los reportes, la
búsqueda—, nace `ACCEPTED` porque SUNAT ya lo recibió, y no habla nunca con el PSE: ni se
envía, ni se reintenta, ni se consulta, ni se da de baja, ni recibe una nota de crédito
emitida acá. Su baja y su nota de crédito se hacen donde se emitió, y el resultado se vuelve
a importar.

Estado: `pnpm turbo lint typecheck test build` en verde (**255 unit**, 19 nuevos); **13 E2E
nuevos en verde**; tres migraciones aplicadas en `dev` y en `production`.

Lo que más importa de la fase no era el código nuevo sino **lo que no lo miraba**: una
versión archivada por reimportación conserva su `status = ACCEPTED`, y todo lo que sumaba
comprobantes la seguía sumando. Reimportar —el caso normal de RF-72— **duplicaba la deuda
del cliente** en cuentas por cobrar.

## 2. Hecho

1. **Decisiones D-105..D-109** en `docs/ARQUITECTURA.md` §0.2, con el contexto largo en
   `docs/DECISIONES.md` (por qué el corte va en el origen y no en el estado, cómo se
   sostiene la unicidad del número con dos versiones, y las fronteras). RF-71, RF-72 y §3.7
   al día.
2. **Prisma**: `FiscalDocumentOrigin`, `fiscal_documents.origin`/`archived_at`/
   `supersedes_document_id`, `import_rows.warnings` y `ImportEntity += FISCAL_DOCUMENTS`.
   Tres migraciones (el `ALTER TYPE` va solo en la suya, misma lección que D-103). La
   unicidad de `number` pasa a un **índice único parcial** (`WHERE archived_at IS NULL`).
3. **El importador genérico aprende a agrupar (D-107)**: `ImportAdapter` se parte en
   `RowImportAdapter` (una fila, una entidad) y `GroupedImportAdapter` (`groupKey`,
   `validateGroup`, `createGroup`). Un grupo se valida entero y se confirma entero, en una
   transacción. Corregir una fila revalida su grupo completo —y el que abandonó, si la
   edición le cambió el número—.
4. **`FiscalImportService`** (`apps/api/src/invoicing/`): las reglas de qué serie le toca a
   un importado, qué se puede reimportar y qué lo bloquea son de `invoicing`, no del
   importador. Sigue el patrón `*InTx` de D-099.
5. **La serie del importado (D-106)**: no toma correlativo pero empuja el de la serie con un
   `UPDATE … GREATEST(…) RETURNING` atómico y auditado; una serie que no existe se crea
   **inactiva**; un adelanto de más de 1000 números sobre una serie activa se rechaza.
6. **RF-72**: reimportar archiva la anterior en vez de pisarla, con tres puertas cerradas —lo
   que emitió el ERP, lo que tiene cobros vigentes y lo que tiene notas de crédito vivas no
   se reimporta—.
7. **Avisos no bloqueantes** (`import_rows.warnings`): "esta fila archiva la versión anterior
   de F001-00000123" no es un error, pero hay que verlo antes de confirmar.
8. **Web**: el diálogo de importación de siempre, montado en `/comprobantes` para
   ADMINISTRADOR; badge "Importado" en el listado; en el detalle, los botones que hablan con
   el PSE apagados, un banner que dice qué sí y qué no, y enlaces entre la versión archivada
   y la vigente.
9. **E2E**: `fase7c.spec.ts` (4) y `fase7c-bordes.spec.ts` (9). Se saltan enteras contra una
   URL externa con el motivo escrito (ver §4).
10. **Revisión (`revisor` API + `revisor` web + `auditor-seguridad`)**: seis bloqueantes,
    cuatro altos y una docena entre medios y bajos, todos corregidos. El detalle está en
    `docs/PROGRESO.md`.

## 3. Decisiones tomadas

- **D-105** — El importado es un comprobante de primera clase con otro origen y sin
  contraparte del otro lado. Los estados frenan la mitad de las operaciones del PSE (un
  `ACCEPTED` no lo tocan `send`, `retry` ni `correct`); la otra mitad —baja, nota de crédito,
  consulta— la frena `assertIssuedHere`.
- **D-106** — No toma correlativo, pero empuja el de su serie; la serie que no existe se crea
  inactiva.
- **D-107** — El importador genérico agrupa: N filas de planilla pueden ser una entidad.
- **D-108** — Reimportar archiva, no pisa, y solo alcanza a lo importado sin nada apoyado
  encima.
- **D-109** — El importado nace con su saldo entero por cobrar; lo ya cobrado se registra con
  el flujo de cobranzas de siempre.

## 4. Bloqueos / pendientes

**Sin bloqueos técnicos abiertos.**

**Frontera conocida — un importado no se anula desde el ERP.** Su baja y su nota de crédito
se hacen donde se emitió (el portal de SUNAT, o el sistema anterior) y el resultado se vuelve
a importar. Emitir una nota de crédito propia contra él sería peor que inútil: nacería
referida a un documento que para el PSE no es nuestro.

**Frontera conocida — un importado no trae lo ya cobrado ni su PDF.** El caso que importa —la
emisión de contingencia durante una caída del PSE— es nueva y sin cobrar. Adjuntar el PDF
original es una extensión evidente y ninguna decisión de esta fase la estorba.

**Frontera conocida — la suite de esta fase no corre contra producción.** Importar escribe
numeración fiscal real y deja comprobantes que no se pueden dar de baja: el mismo riesgo que
`fiscalEmissionAllowed()` gobierna desde la Fase 5b. Las suites igual están listadas en
`scripts/e2e-prod.mjs`, para que el informe diga "saltadas" en vez de callar.

**Anotado para Fase 8 (hardening).** El preview del importador hace hasta dos consultas por
fila (cliente y SKU): con 2000 filas son varios miles de viajes en una sola petición.
Resolverlo con dos `findMany` por archivo va junto con el buscador de cliente del mostrador,
que quedó anotado en la Fase 7b por lo mismo.

**Residuo en la rama `dev` de Neon.** Las corridas de E2E dejaron comprobantes importados que
**no se pueden borrar ni dar de baja por diseño**. No afecta a `ci` (se resetea) ni a
producción (la suite se salta allí). Limpiar `dev` exigiría SQL a mano; es decisión del dueño.

**Diferido, con motivo:** ticket térmico de 80 mm (D-102), venta a medida en mostrador y
multi-caja por usuario. Sigue pendiente el pase a la cuenta real del PSE (checklist en
`docs/handoff/fase-5b.md` §4) y el `vercel login` para dejar `pnpm deploy:web` operativo
fuera de un push.

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm turbo lint typecheck test build   # exit 0
pnpm e2e --grep "Fase 7c"              # solo esta fase (13 tests)
pnpm e2e:prod --grep "Fase 7c"         # contra producción: 13 saltados, con motivo
node scripts/prod-e2e-leftovers.mjs    # el residuo, leyendo la base (segundos)
```

**No correr dos suites de Playwright a la vez**: comparten `test-results/`.

Un recorrido a mano que prueba la fase entera:

1. `/comprobantes` → "Importar" (solo ADMINISTRADOR). Sube una planilla con una fila por
   línea y la cabecera repetida; las columnas están listadas en el propio diálogo.
2. Revisa el preview: una línea con un error deja el **comprobante entero** en rojo, y el
   mensaje dice cuánto suman las líneas y cuánto declara el archivo.
3. Confirma → el comprobante aparece en la lista con su número, marcado "Importado" y
   "Aceptado", con su saldo por cobrar.
4. Ábrelo: no hay botón de baja, de nota de crédito ni de consulta al PSE; sí de cobro.
   Registra el cobro y el saldo se va a cero.
5. Vuelve a importar el **mismo número** con otro total: el preview lo marca con un **aviso**
   ámbar (no un error) diciendo que va a archivar la versión anterior. Con un cobro vigente
   encima, en cambio, lo **bloquea**.
6. Tras confirmar, la lista muestra una sola fila con ese número; desde su detalle se llega a
   la versión archivada, que dice que su saldo ya no cuenta en cobranzas.

Producción:

- Web: <https://ayr-steel-erp-web.vercel.app> — el deploy llega con el push a `main`.
- API: <https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app>.
- DB: Neon rama `production`, con las tres migraciones de Fase 7c aplicadas.

## 6. Siguiente sesión

**Fase 8**: auditoría, reportes, hardening y UAT (RF-90..RF-96). Es lo único que queda en
§3.7.

Lo que esta fase deja listo y no hay que rehacer:

- **`GroupedImportAdapter`.** Cualquier importación futura de un documento con líneas —una
  orden de compra, un inventario físico— ya tiene el molde: agrupar, validar el grupo entero
  y confirmarlo entero.
- **`origin` en `fiscal_documents`.** El corte entre "lo que emitimos" y "lo que ya venía
  emitido" está hecho y probado; cualquier operación futura contra el PSE tiene dónde
  preguntarlo.
- **La unicidad parcial de `number`.** El patrón para convivir con versiones de un mismo
  documento, con su lock consultivo y su orden de transacción documentados.
- **Los avisos del importador.** `import_rows.warnings` sirve a cualquier entidad que
  necesite decir algo antes de confirmar sin bloquear.

Dos cosas que esta fase deja anotadas y no son suyas:

- El **costo del preview** (dos consultas por fila) es de RF-52 y lo hereda la Fase 8.
- El defecto de fechas de `parseSpreadsheet` llevaba ahí desde la Fase 1 y **ninguna entidad
  importable anterior tenía columna de fecha**. La lección vale más que el arreglo: una
  capacidad compartida solo se ejercita en los caminos que alguien recorre, y el primer
  usuario nuevo de una pieza vieja es el que encuentra lo que llevaba años roto.
