# Ventana cc58 · cierre de lo pendiente de cc57

2026-10-19, Lima, sesión de día y atendida. Cuatro cortes. Cada uno tuvo su PR, la revisión de un segundo modelo y una
autorrevisión, la CI completa, el despliegue de la API antes del merge y su smoke. Después vino este cierre de docs.

- **Decisiones:** D-676..D-691, **ratificadas por el dueño el 2026-10-19**; D-688 quedó postergada por el dueño.
- **Migración:** una sola, con el OK del dueño por nombre: `20261019_perf_indexes_cc57`.
- **Escrituras de datos:** ninguna. No hubo `--execute` ni SQL contra producción.

## En producción

| Corte                                                        | PR   | API         | `git-sha`  | Merge      | Smoke |
| ------------------------------------------------------------ | ---- | ----------- | ---------- | ---------- | ----- |
| A · índices y decisiones de comprobantes, pedidos y reportes | #230 | `00142-5p2` | `db134497` | `c664d9ab` | verde |
| B · topes, salida que agota el ítem, PEPS                    | #231 | `00143-ts6` | `d78f150e` | `11dccd53` | verde |
| C · flete que llega tarde                                    | #232 | `00144-nv6` | `7f9b2c23` | `9528090d` | verde |
| D · sesión, D-285, D-374, kardex leído una vez               | #233 | `00145-6qp` | `84e31868` | `c5f1b6a2` | verde |

- **Revisión final de la API:** `00145-6qp` (`git-sha=84e31868`).
- **Vuelta atrás:** `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=<anterior>=100` y revert del
  merge. La revisión anterior a cc58 es `00141-2l5`. La migración es solo de índices: se deja aunque se vuelva atrás.
- **Neon:** respaldo `respaldo-pre-cc58-20261019` (`br-spring-hill-aetbkbg9`). Por la regla 18 se borró
  `respaldo-pre-cc41-20261010` (`br-old-mountain-aeno2yqp`). Sigue en 10 de 10.
- **`migrate diff` de producción:** antes daba el drift aprobado más los 3 índices; después, solo el drift aprobado.

## Qué entró

La tabla punto por punto está en `local-data/cc58/INFORME.md` del checkout principal.

- **A (D-676..D-682):**
  - **D-676:** migración de índices.
  - **D-677:** el segundo 02 no se permite; el mensaje dice 01 y volver a emitir.
  - **D-678:** `assertStockCreditNoteRole` al crear, registrar, registrar a mano, emitir y corregir una NC 01/06/07.
  - **D-679:** transporte compartido, ya lo era.
  - **D-680:** `orderReturns` y el aviso en `pedido-detalle-view.tsx`.
  - **D-681:** `noCostSalesPen` en la fila y `summarizeSalesMargin` sobre la base de D-409.
  - **D-682:** `priceWithIgvPen` obligatorio.
- **B (D-683..D-685):**
  - **D-683:** `RECOST_TX_OPTIONS` de 60 s y techo en `transaction-options.sentinel.spec.ts`, con excepciones con nombre.
  - **D-684:** rama de `record()` para la salida que agota el ítem.
  - **D-685:** `pepsCorrectedCosts` en `kardex-peps.service.ts`.
- **C (D-686):**
  - `landed-cost-recost.ts` (entradas, nota con `compra <id>`, `landedCostShares`, `hasLandedRecost`);
  - `applyLandedCost` por `recostEntries`, `reverseLandedCost` y `assertNoLiveLandedCost` en `purchases.service.ts`;
  - guardas en `coil-entry-cost.ts` y `purchase-received-edit.service.ts`;
  - E2E de `fase2b` actualizado.
- **D (D-687, D-689..D-691):**
  - **D-687:** `refresh` con reuso, rotación condicional con reintento, `sessionCap` y `SESSION_CAP_FROM`.
  - **D-689:** fuera la herramienta D-285.
  - **D-690:** `deferRecost` y `recostOnce` en `purchase-received-date-fix.ts`, con `defer-recost.sentinel.spec.ts`.
  - **D-691:** `loadKardex` y `qtyRowsOfSnapshot`.
  - La cubeta por IP (D-688) se implementó y se revirtió.

## Revisiones

Están en `docs/revision/cc58-{a,b,c,d}-{segundo-modelo,autorrevision}.md`, con la respuesta del autor. Ningún P0. Los
P1 corregidos antes del deploy:

- **A:** un vendedor emitía, corregía o registraba a mano un borrador 01/06/07.
- **B:** el promedio en 0 hacía perder el piso de precio.
- **C:**
  - la nota no servía como llave;
  - la anulación chocaba con una bobina ya anulada;
  - el chequeo de la compra de bobinas corría después de las reversas;
  - el cambio de serie dejaba el flete huérfano.

## Medido

- **E-07:** lecturas del kardex antes de escribir una salida atrasada: de 3 a 1 (consultas contadas en
  `recost.db-spec.ts`).
- **D-11:** el camino viejo de la herramienta de D-374 deja filas de ruido; el nuevo, ninguna (misma prueba de base).
- **Suites db-spec locales:** A 225, B 226, C 230 y D 233, todas en verde.
- **`check:balances` de producción:** 155 saldos y 2 diferencias que suman S/ 0,31.

## Pendiente / para la siguiente sesión

- ~~Revisión del dueño: UAT y ratificar D-676..D-691~~ — **hecho el 2026-10-19**: UAT de cc58 aprobado y D-676..D-691
  ratificadas, D-683 y D-686 tal como quedaron.
- ~~Céntimos (punto 11)~~ — **el dueño decidió el 2026-10-19 dejarlos así**: se corrigen solos al consumirse esas bobinas
  (D-684).
- **D-688, login por IP:**
  - una variable nueva en Vercel y en Cloud Run (secreto compartido);
  - que el proxy de la web reenvíe la IP real del cliente firmada.
- **Datos (punto 13), solo propuesta:**
  - FFA1-00001426: poner el vencimiento desde el detalle del comprobante;
  - OP-000029: vender o dar de baja la unidad suelta.
  - La lectura nueva de producción para revisarlos se negó por permisos; se usó la de audit-01 (15/10).
- ~~`.claude/settings.json`~~ — **hecho con la autorización del dueño (19/10)**: salieron solo los dos permisos de la
  herramienta retirada.
- **Riesgos anotados:**
  - el tope de 500 filas puede rechazar la recepción de un flete tardío;
  - «Editar bobina» no cambia el costo de una bobina con flete;
  - restaurar una bobina anulada no recupera el flete;
  - confirmar pedido, editar líneas y generar OPs quedaron en 30 s sin medición contra Neon;
  - la cubeta general y la de `/auth/refresh` también son compartidas detrás de Vercel.
- **Pruebas de flete que faltan:** dos fletes sobre la misma compra, USD, partido y flejes, NC y OP cerrada.
- **Sigue en pie** el Excel de saldos de cc56.
