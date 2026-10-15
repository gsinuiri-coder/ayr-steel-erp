# Ventana cc54 — deuda de cc53 y nota de crédito por motivo SUNAT en un solo diálogo

2026-10-14/15, Lima. Dos PR de código, cada uno con su despliegue, y este cierre de docs. Decisiones D-653..D-663
(provisionales). **Sin migraciones ni escrituras masivas.** Sin SQL contra producción. Sin ramas nuevas de Neon (sigue
en 9 de 10).

## En producción

- **Corte A (PR #209, merge `d902e5c9`):**
  - API `ayr-steel-erp-api-00129-5ll` (`git-sha=cc17f63f`), desplegada antes del merge;
  - `smoke:prod --expect-sha d902e5c9 --expect-api-sha cc17f63f` en verde en los dos dominios.
- **Corte B (PR #210, merge `a2acf50e`):**
  - API `00130-62b` (`git-sha=da3a1356`), desplegada antes del merge;
  - `smoke:prod --expect-sha a2acf50e --expect-api-sha da3a1356` en verde.
- **Vuelta atrás:** `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=<anterior>=100` (00129-5ll
  para el corte B, 00128-9nl para el A) y revert del merge. Sin cambios de schema: la API anterior lee todo.

## Qué entró

- **Corte A (D-653):**
  - un solo cálculo de negativos y de primera fecha válida (`recost-engine.ts`), usado por el kardex, el plan D-278,
    D-285 e `inspect:cc53`;
  - D-652 antes del acuse de retrofecha;
  - el rechazo, legible en toda la web;
  - `qtyRowsOf` en una consulta;
  - el centinela de topes sigue los auxiliares;
  - candado de `recosteo:historico --execute` (misma rama y commit, sin cambios sin commitear, menos de 2 h,
    comparación antes del commit);
  - cifras y fechas reales de UPVC6MT fuera de los specs.
- **Corte B (D-654..D-663):** la NC por motivo SUNAT.
  - API:
    - `POST /invoicing/documents/:id/credit-note/register` (un paso) y `…/credit-note/preview`;
    - `credit-note-lines.ts` (las líneas por motivo);
    - el reemplazo del 02 y su deshacer al anular la NC;
    - el 01 con DEV-;
    - el 13 con vencimiento derivado (`effectiveDueDate`);
    - solo los motivos de cantidad acreditan unidades (neto facturado, «acreditado», reversa de despachos, D-278,
      reportes);
    - la rentabilidad resta el costo de la DEV-.
  - Web: `credit-note-dialog.tsx` (modal ancho). El detalle del comprobante muestra el motivo SUNAT, la descripción
    corregida y el vencimiento fijado por un 13.
  - D-662: una salida atrasada tampoco agrava un negativo existente.
  - `seed:escenarios`: un caso por motivo (NC-01, NC-02, NC-03, NC-04, NC-05, NC, NC-07 y NC-13), con dos clientes
    DEMO con RUC.

## Verificación

- **Lint, typecheck y Prettier:** en verde.
- **Unitarias:** API 3 520 (con `invoicing-credit-note.spec`, `fiscal-import-nc02.spec`, `credit-note-lines.spec` y
  `credit-note-deadline.spec`); web 354.
- **db-spec en base propia:**
  - suite completa: 15 suites, 188 de 189; la que falló fue un caso agregado a mitad de la corrida, ya corregido;
  - `credit-note-reasons.db-spec`: 13/13;
  - par nuevo de `lock-order`, «NC 01 en un paso × revertir su despacho»: 20 carreras sin deadlock.
- **E2E locales:** del corte A, 13 (D-278, D-288, D-375); del corte B, `nc-motivo-cc54` 6/6 más `cc33-nc-borrador`.
- **`seed:escenarios:test`:** dos corridas en verde, en un Postgres descartable ya borrado.
- **CI completa en verde en los dos PR.** SonarCloud: cobertura del código nuevo del corte B 84,2 %, con unitarias
  agregadas.
- **Medido en local (NC de devolución):** en dos pasos, 98 consultas y 347 ms; en un paso, 74 consultas y 240 ms.

## Revisiones

- **Corte A:** autorrevisión y segundo modelo (`docs/revision/cc54-a-*.md`). Sin P0 ni P1; los P2 corregidos (saldo
  final sin eximir en el plan, candado probado).
- **Corte B:** autorrevisión y segundo modelo (`docs/revision/cc54-b-*.md`). Sin P0. Los P1 quedaron corregidos:
  anular el pedido después de un 01 con DEV- y el 01 con una línea sin pedido. Los P2 también:
  - deshacer el 02;
  - la vista previa en un comprobante electrónico;
  - el 01 sin DEV- en Ventas y margen;
  - el 02 solo para ADMINISTRADOR, bloqueado por guías y borradores;
  - la revalidación por importe;
  - el par de la regla 17.

  Los P3 sin cambio quedan anotados.

- Revisión del dueño: **UAT de `docs/uat/cc54.md` aprobado** (15/10, en la rama `demo`).

## Pendiente / para la siguiente sesión

- **El dueño:** nada de cc54. **UAT de cc54 aprobado y D-653 a D-663 RATIFICADAS por el dueño el 15/10** (D-655
  incluye que el 02 lo registra solo un ADMINISTRADOR y lo bloquean las guías vivas del pedido). El 06 es solo
  devolución total; sobre un comprobante despachado a medias corresponde un 07.
- **Anotado, sin hacer:**
  - **08, 09 y 10** no se agregaron (D-658: exigen migración del enum);
  - **cuotas reales del 13** (D-657: hoy, vencimiento único; exige migración);
  - el orden por vencimiento de las listas usa la columna guardada, no el vencimiento vigente de un 13;
  - 03 y 13 se aceptan sobre un comprobante ya acreditado por completo;
  - un 02 entre meses lleva el costo del despacho al mes del reemplazo;
  - la NC electrónica de 01 (mostrador) no genera DEV- (sigue revirtiendo el despacho).
- **Producción:** 0 NC (medido el 2026-10-15) y 0 ítems con el kardex en negativo (`inspect:cc53`). El cambio de
  criterio no tiene historia que migrar.
- **Neon:** 9 de 10, sin cambios en esta pieza.

## Commits

- **Corte A (PR #209):**
  - `7988e008` deuda de cc53;
  - `67e27008` revisiones (saldo final, candado probado);
  - `cc17f63f` Sonar.
- **Corte B (PR #210):**
  - `a414420b` D-662;
  - `a4204b45` API por motivo;
  - `359ab3cb` web y E2E;
  - `48324e3a` cantidad acreditada en reversas, D-278 y Ventas y margen;
  - `ea8ebb7a` revisiones;
  - `32a4b5f0` y `da3a1356` unitarias para la cobertura.
