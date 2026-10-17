# Ventana cc57 — resto del plan de audit-01 (P2 y P3 de código)

2026-10-17, Lima, sesión desatendida. Cinco cortes, cada uno con su PR, su despliegue de la API antes del merge y su
smoke; después este cierre de docs. Decisiones D-671..D-675 (provisionales). **Sin migraciones, sin `--execute`, sin
SQL contra producción y sin escrituras de datos.** No se crearon ramas de Neon: sigue en 10 de 10. La única corrida
contra producción fue `pnpm check:balances`, de solo lectura.

## En producción

| Corte                       | PR   | API         | `git-sha`  | Merge      | Smoke |
| --------------------------- | ---- | ----------- | ---------- | ---------- | ----- |
| A · reversas e idempotencia | #223 | `00137-tzq` | `dcdb8576` | `e6c8d113` | verde |
| B · recosteo y reemplazo    | #224 | `00138-89n` | `64962c38` | `2c2563a0` | verde |
| C · reportes                | #225 | `00139-6mb` | `00f887cc` | `868e8a3d` | verde |
| D · rendimiento             | #226 | `00140-6q9` | `6c6e64ac` | `cc5074d3` | verde |
| E · higiene                 | #227 | `00141-2l5` | `7a6abe57` | `3bec6271` | verde |

- **Revisión final de la API:** `00141-2l5` (`git-sha=7a6abe57`).
- **Vuelta atrás:** `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=<anterior>=100` y revert del
  merge. La revisión anterior a cc57 es `00136-q2t`. No hubo cambios de esquema ni de datos.
- `--web-origin`: `https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app`.

## Qué entró

La tabla completa, id por id de audit-01, está en `local-data/cc57/INFORME.md` del checkout principal. Por corte:

- **D-671 (A):**
  - `fiscal-import.service.ts` `annulExternal` bloquea la NC, sus despachos devueltos y su pedido;
  - `order-cancel-checks.ts` `fabricatedLooseLines` suma la DEV-;
  - `sales-return-allocation.ts` deja kardex para el resto;
  - `sales-returns.service.ts` `explainWithoutKardex`;
  - `idempotencyKey` en `createQuotationSchema`, `createDispatchSchema`, `createCoilSplitSchema` y `createCoilScrapSchema`,
    y sus servicios;
  - `invoicing.service.ts`: `sendClaimWhere` y `SEND_CLAIM_LEASE_MS`, más el 409 en `retry`.
- **D-672 (B):**
  - `inventory-recost.ts` excluye los ingresos anulados como destino;
  - `coil-operations.service.ts` rechaza el cambio de costo con recosteos;
  - `inventory.service.ts`: la precondición de `replaceEntry`, `assertChronological`, `findMovements` y `openingBalance`;
  - `purchase-received-edit.ts` `CLOSE_ADJUSTMENT`;
  - `close-recost.ts` `closeCostAudit`;
  - `apps/api/prisma/check-balances-cli.ts` y `pnpm check:balances`.
- **D-673 (C):**
  - `sales-by-product.ts` y `sales-by-material.service.ts`: la NC en la fila del producto;
  - `sales-margin.service.ts`: `opMaterialByOrder` con `SCRAP` y el vendedor por `documentOwnerId`;
  - `PROFIT_SOURCES_NOTICE`;
  - la pista de «Vencido» en cobranzas.
- **D-674 (D):**
  - `pendingDispatchByOrder` por pedido;
  - `loadCollectibleDocuments` con prefiltro SQL;
  - `findMovements` con tope explícito (`SINGLE_ITEM_KARDEX_MAX_ROWS`), y el kardex web muestra el mensaje del API.
- **D-675 (E):**
  - `KARDEX_TX_OPTIONS` en 19 transacciones, y el centinela de topes también para `lockDocuments` y `lockInOrder`;
  - `throttler.guard.ts` `isLoginRoute`;
  - roles de `/cutting/strips` y `/sales/dashboard`;
  - `price-list-import` valida contra `priceWithIgvPen` crudo;
  - `Button pending` en siete botones;
  - `requireRoofingProduct(…, tx)`;
  - `expireDue` con `updateManyAndReturn`;
  - `receive` relee la cabecera;
  - centinela de escritores ampliado;
  - el admin del smoke como `SYSTEM`.

## Verificación

- Cada hallazgo arreglado tiene su prueba. Las que reproducen el defecto se corrieron también **sin** el arreglo y fallaron
  (logs `*-antes.log` en `local-data/cc57/`).
- **Unitarias:** API, 3 676 en verde; web, 354.
- **db-spec:** suite completa sobre el código de los cinco cortes juntos, 224/224 (`dbfull-e.log`), en una base propia
  por corte.
- **CI completa en verde** en los cinco PR: E2E en dos shards, Neon ci, escenarios, drift y SonarCloud.
  - SonarCloud rechazó A y B por cobertura de código nuevo (51,5 % y 66,7 %). Se cubrió con unitarias y, en B, con la
    función `closeCostAudit`.
- **Medido en producción (solo lectura):** `pnpm check:balances` sobre 155 saldos. Las cantidades cuadran todas. Hay 2
  diferencias de valor por encima del redondeo del promedio.

## Revisiones

Cada corte tuvo autorrevisión y segundo modelo (`docs/revision/cc57-{a..e}-*.md`), con la respuesta del autor al pie.

Corregido antes del deploy:

- **B:** reingresar a la hija al costo efectivo duplicaba el recosteo en la cascada siguiente. Se reemplazó por el
  rechazo.
- **B:** D-03 (acuse de retrofecha del landed cost) abría el flete retrofechado, que se reparte con los kilos de hoy. Se
  retiró del corte.
- **C:** la NC sobre una venta trazada en parte restaba de más, y el 02 entraba a la fila.
- **D:** el filtro por el pedido del despacho podía dejar líneas afuera.
- **E:** D-16 redondeaba el precio de la celda, lo que daba falsos rechazos en el 22 % de los precios con decimales
  completos.

Revisión del dueño: UAT en `docs/uat/cc57.md`, pendiente.

## Pendiente / para la siguiente sesión

- **OK del dueño, migración:** `local-data/cc57/migraciones-propuestas.sql`.
  - Tres índices, de E-14: `fiscal_documents(issue_date)`, `dispatch_items(movement_id)` y
    `customer_payments(document_id, reversed_at)`.
  - El índice único parcial del segundo 02, de D-07, que además necesita decisión.
- **Decisiones del dueño:**

  | Id          | Qué hay que decidir                           | Recomendación       |
  | ----------- | --------------------------------------------- | ------------------- |
  | C-04        | Si el vendedor registra NC 06/07              | Solo ADMINISTRADOR  |
  | C-11        | Si las sugerencias de transporte se comparten | Aceptar             |
  | D-05        | Pedido atendido con todo devuelto             | Aviso en el detalle |
  | D-10 + D-03 | Landed cost sobre los kilos ya consumidos     | —                   |
  | B-03        | Techo de los topes                            | —                   |
  | E-04        | Base del % del pie de Ventas y margen         | D-409 por fila      |
  | E-05        | Valorizar la salida que agota el ítem         | Cambia el motor     |
  | E-11        | PEPS con costo efectivo                       | —                   |
  | P1-05       | Residuo del recosteo                          | Exige `--execute`   |

- **Para una sesión de día:**
  - E-07, cachear el kardex por transacción;
  - C-09, reuso del refresh token;
  - C-08, la cubeta por IP del login;
  - D-15/A-05, retirar la herramienta D-285;
  - D-11;
  - D-16 obligatorio (hoy `priceWithIgvPen` es opcional por la ventana del deploy).
- **Datos:**
  - P1-09, el vencimiento de FFA1-00001426;
  - P1-10, la unidad suelta de OP-000029.
- Siguen en pie el Excel de saldos de cc56 y el UAT de cc57.
