# Handoff — Fase 5b (facturación electrónica, GRE, despacho y cobranza) — 2026-09-04

## 1. Resumen

Fase 5b según `docs/ARQUITECTURA.md` §3.7, **realcanzada por D-070**: dejó de ser "producción
de coberturas y venta" —eso pasó a **5c**— y pasó a cerrar el tramo posterior al pedido, que
era el hueco real de 5a: el pedido reservaba material y no tenía forma de salir del almacén, de
facturarse ni de cobrarse. **Cerrada.**
Entregado: comprobantes electrónicos (factura, boleta, nota de crédito) tras un puerto que el
dominio no puede saltarse, guía de remisión remitente, despacho que mueve kardex y cierra el
pedido, cobranza espejo de los pagos a proveedor, y las reversas de las tres cosas. Once
decisiones nuevas (D-070..D-080).
Estado: `pnpm turbo lint typecheck test build` en verde (**195 unit**); **19 E2E** contra la
cuenta demo del PSE y **89/89 contra producción**; **CI verde**; cinco migraciones aplicadas en
`dev` y `production`; API redesplegado y web por push a `main`. `pnpm prod:purge-e2e` deja
producción con **0 documentos electrónicos, 0 despachos vivos, 0 reservas activas y 0 cobros
vigentes**.

## 2. Hecho

1. **Decisiones (punto 1)** — `docs/ARQUITECTURA.md` §0.2 gana D-070..D-080, §3.7 parte la fase
   y crea la **5c**, y §4.6/§4.7 suman RF-70, RF-74..RF-79 y RF-86..RF-89. Contexto largo en
   `docs/DECISIONES.md`.
2. **Prisma (punto 2)** — `fiscal_series`, `invoicing_settings`, `fiscal_documents`,
   `fiscal_document_items`, `dispatches`, `dispatch_items` y `customer_payments`; más
   `customers.is_system` (D-077) y `SalesOrderStatus.PARTIALLY_FULFILLED` (D-074). Cinco
   migraciones, `20260904170000_*` a `20260904174000_*`.
3. **El puerto (punto 3, D-071)** — `apps/api/src/invoicing/ports/electronic-invoicing.port.ts`
   con cinco operaciones en vocabulario de SUNAT; `providers/nubefact/` es el único lugar que
   conoce al proveedor, y `providers/null-invoicing.provider.ts` cubre el arranque sin
   credenciales por la **misma ruta que una caída real**.
4. **Comprobantes (punto 4)** — `apps/api/src/invoicing/invoicing.service.ts`: borrador,
   emisión en dos fases (D-072/D-073), nota de crédito total y parcial, corrección de un
   rechazado, comunicación de baja, reconciliación, series administrables y descarte de
   borrador.
5. **Despacho (punto 5, D-074)** — `dispatches.service.ts`: mueve kardex por `InventoryService`,
   consume la reserva **solo por lo despachado**, cierra el pedido y su reversa deshace las tres
   cosas con el guardrail de los documentos vigentes.
6. **Cobranza (punto 6, D-075)** — `receivables.service.ts`, espejo de `supplier_payments`.
7. **Job (D-073)** — `invoicing-send.job.ts`: cada 15 minutos **y al arrancar**, porque el API
   escala a cero (§3.6). Misma lección que D-069.
8. **Web (punto 7)** — `apps/web/src/app/(app)/comprobantes/`, `despachos/` y `cobranzas/`,
   `components/invoicing/` y `lib/invoicing-queries.ts`; enlaces desde `/pedidos/[id]`.
9. **Revisión (punto 8)** — `revisor` ×2 (API y web por separado), `auditor-seguridad` y `qa`.
   Detalle en `docs/PROGRESO.md`.
10. **E2E (punto 9)** — `e2e/tests/fase5b.spec.ts` (8) y `fase5b-bordes.spec.ts` (11), con
    `e2e/helpers/invoicing.ts`.
11. **Deploy y purga (puntos 10-11)** — `pnpm db:prod`, `pnpm deploy:api`, push a `main`,
    `pnpm e2e:prod` 89/89, `pnpm prod:purge-e2e` sin residuo.

## 3. Decisiones tomadas

- **D-070** — Fase 5b se reasigna al ciclo fiscal y logístico; coberturas y venta directa pasan
  a **5c** y la Fase 6 queda reducida a la importación de comprobantes.
- **D-071** — Puerto `ElectronicInvoicingProvider`; el dominio no conoce a Nubefact y la
  respuesta cruda se **guarda sin leerla**.
- **D-072** — Series con correlativo atómico **asignado al enviar**; un rechazado conserva su
  número y la corrección toma otro.
- **D-073** — Contingencia: el correlativo y el estado `ISSUED` se confirman **antes** de hablar
  con el PSE, así que el despacho no espera a nadie. Job, barrido de arranque e interruptor
  manual.
- **D-074** — El despacho cierra el pedido; la factura no. Consume la reserva **solo por lo
  despachado** y su reversa la restaura.
- **D-075** — Cobranza espejo de los pagos a proveedor: saldo recalculado, cobro contra el
  comprobante, reversa que marca la fila. Detracción informativa.
- **D-076** — RF-85 cambia: VENDEDOR da de alta y edita clientes; documento, días de crédito y
  baja lógica siguen siendo de ADMINISTRADOR.
- **D-077** — Cliente `PÚBLICO EN GENERAL` sembrado e inmutable, con bloqueo suave de S/ 700 y
  excepción de ADMINISTRADOR registrada.
- **D-078** — GRE con modalidad de traslado **por despacho**; catálogo de vehículos y
  conductores diferido, reemplazado por autocompletado.
- **D-079** — La baja de la guía **no pasa por el puerto**: se hace en el panel del PSE y el
  sistema la reconcilia. La asimetría es de la implementación, no del contrato.
- **D-080** — Producción se despliega **sin credenciales del PSE**: toda emisión cae en
  contingencia, y así es imposible un falso "aceptado por SUNAT" contra una cuenta demo.

## 4. Bloqueos / pendientes

**Acción humana pendiente — el pase a la cuenta real del PSE.** Es su propia mini-sesión, con
checklist. Hoy producción emite en contingencia por D-080. Para habilitarla: cargar
`NUBEFACT_URL`/`NUBEFACT_TOKEN` en Secret Manager y volver a poner las dos líneas que
`scripts/gcp-secrets.mjs` y `scripts/deploy-api.mjs` dejan documentadas en su sitio exacto.

**Bloqueo abierto — la baja de una guía de remisión (D-079).** El proveedor no reconoce una GRE
aceptada en su operación de anulación (_"el documento no existe o no fue enviado"_). Camino
oficial: darla de baja **en el panel del PSE** y usar «Consultar al PSE» sobre ella para que el
sistema la reconcilie, con lo que se desbloquea la reversa del despacho. Sin eso, un despacho
con guía aceptada **no se puede revertir**.

**Sin cubrir por falta de camino, no por falta de prueba:** la reconciliación de una guía
anulada solo se puede provocar si alguien la da de baja en el panel; y `voidPath === 'NONE'` no
se puede montar desde el API, porque la ventana de emisión y la de baja son ambas de siete días.
Las dos quedan cubiertas por prueba unitaria y dichas en el test, no simuladas.

**Hallazgos que cambiaron el código** (detalle completo en `docs/PROGRESO.md`):

- **Bloqueantes de la revisión.** `SEND_ERROR` no contaba como emitido, así que con el PSE caído
  —el escenario de la contingencia— la misma línea se podía facturar dos veces; los topes se
  comprobaban al crear el borrador y no al gastar el correlativo; y **la baja se confirmaba
  sola**, porque consultaba por el comprobante y un documento con baja en trámite es por
  definición uno que SUNAT aceptó.
- **Lo que solo apareció contra el PSE real.** El más instructivo: `aceptada_por_sunat: false`
  **no siempre es un rechazo** —boletas, guías y bajas van por el camino asíncrono de SUNAT— y
  leerlo como terminal quemaba un correlativo por documento. Estaba escondido detrás de otro
  defecto: un `??` que no cubría la cadena vacía dejaba los rechazos sin motivo, y sin motivo no
  había forma de ver que el motivo no existía.
- **Encontrado revisando el propio código, no por la suite:** el despacho sacaba del kardex la
  cantidad **de venta** en vez de la que la reserva promete. En perfiles coinciden, así que
  habría esperado a la primera cobertura para aparecer.

**Ojo operativo — vaciar la cuenta del PSE deja huérfano lo que la base registró.** Al borrar
físicamente los comprobantes de la cuenta demo, doce documentos con baja en trámite volvieron a
`ACCEPTED`: el PSE ya no conoce esos números, así que ni la baja se completa ni se pueden volver
a anular.

**Ojo operativo — el cupo de la cuenta demo.** Son 50 documentos y **no se libera anulándolos**:
hay que borrarlos físicamente en el panel. Una corrida completa gasta unos veinte.

**Diferido, con motivo:** nota de débito (fuera de v1), cálculo de detracción (depende del
catálogo 54 y de reglas por tipo de bien), catálogo de vehículos y conductores (D-078), y
renombrar `NUBEFACT_*` a `PSE_*` (toca secretos en tres sistemas y no cambia nada funcional).

## 5. Cómo verificar

```
pnpm install && pnpm env:local
pnpm turbo lint typecheck test build   # exit 0 (195 unit)
pnpm format:check                      # exit 0
pnpm e2e                               # 19 E2E de 5b contra el PSE demo, más el resto
pnpm e2e:prod                          # 89 pasados, 13 saltados (los que emiten)
pnpm prod:purge-e2e --dry-run          # qué dejaría limpio; sin la bandera, lo deshace
node scripts/prod-e2e-leftovers.mjs    # solo lectura: qué dejaron los E2E en producción
node scripts/migrations-status.mjs --branch production
gh run list --limit 3
curl -s https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app/health
```

**No correr dos suites de Playwright a la vez**: comparten `test-results/`, que Playwright
limpia al arrancar, y el síntoma (`ENOENT` sobre un trace) no se parece a la causa.

**`pnpm e2e:prod` no emite comprobantes**, y es a propósito: el correlativo lo asigna nuestra
`fiscal_series` (D-072), así que emitir contra producción sin PSE dejaría huecos permanentes en
la numeración fiscal. Para habilitarlo en un entorno donde eso no importe:
`E2E_FISCAL_EMISSION=1`.

Producción:

- Web: https://ayr-steel-erp-web.vercel.app — nuevas rutas `/comprobantes`,
  `/comprobantes/nuevo`, `/comprobantes/[id]`, `/despachos`, `/despachos/nuevo`,
  `/despachos/[id]` y `/cobranzas`; `/pedidos/[id]` gana los botones de despachar y facturar.
- API: https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app
- DB: Neon rama `production`, con las cinco migraciones de Fase 5b.

Para redesplegar: el web sale solo con el push a `main`; el API con
`pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app`. Si se añade una migración,
`pnpm db:prod` **antes** de desplegar el API.

## 6. Siguiente sesión

**Fase 5c** (§3.7): producción de coberturas, venta directa y cola de producción (RF-30, RF-31,
RF-33, RF-36, RF-37, RF-38, RF-60, RF-64, RF-73).

Primera tarea concreta: **la orden de producción de coberturas**, que sigue siendo la única
pieza del ciclo que la reserva ya espera y todavía no existe. Lo que 5b deja listo y no hay que
rehacer:

- **El consumo parcial de la reserva está construido y probado.** `consumeReservationQty` y
  `restoreReservationQty` en `reservation-guard.ts` descuentan y devuelven **solo lo usado**, en
  la unidad del ítem de kardex. La producción de coberturas consume kilos de una bobina contra
  una venta por pieza, que es exactamente el caso que obligó a separar las dos cantidades.
- **La salida de kardex ya distingue la cantidad de venta de la del material** (`reserveQty` en
  `dispatch_items`). El mismo cálculo (`proratedQty`) sirve para la OP.
- **El puerto del PSE y su contingencia están probados de punta a punta**, así que facturar una
  cobertura no necesita nada nuevo del lado fiscal.
- **`SalesOrderStatus.PARTIALLY_FULFILLED`** ya existe y lo mantiene el despacho, no la
  producción.

**Antes o en paralelo:** la mini-sesión del pase a la cuenta real de Nubefact (ver §4).
