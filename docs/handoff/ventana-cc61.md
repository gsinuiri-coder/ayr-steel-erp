# Ventana cc61 · P1 de audit-02, vencimiento editable e importador

20/10/2026, sesión atendida; despliegue y punto 3 entre las 11:50 y las 12:15 de Lima.

- **Decisiones nuevas:** D-698, D-699 y D-700, provisionales. D-697 queda reservada para cc64.
- **Registro del dueño (19 y 20/10):**
  - ratificó D-695 y aprobó el UAT de cc60;
  - el accesorio suelto de A2-03 se queda en stock para venderse más adelante; habilitar su venta es cc64 (D-697);
  - NC-02 (una NC 01 sobre una factura cobrada) dejará el monto como saldo a favor del cliente; va en cc62 con el
    importador.
- **Migraciones:** ninguna.
- **SQL contra producción:** ninguno.
- **`--execute`:** uno, con OK del dueño por nombre (punto 3).

## En producción

| Qué   | Valor                                                          |
| ----- | -------------------------------------------------------------- |
| PR    | #240                                                           |
| API   | `00148-q6w` (`git-sha=b29fdf55`), con el tráfico al 100 %      |
| Merge | `c131044d`                                                     |
| Web   | `c131044d` en las dos URLs                                     |
| Smoke | verde, con `--expect-sha c131044d --expect-api-sha b29fdf55`   |
| Neon  | respaldo `respaldo-pre-cc61-20261020` (`br-shy-snow-aeuauyf9`) |

- **Orden:** la API se desplegó desde la rama (`b29fdf55`) antes del merge, porque la web nueva llama al endpoint nuevo
  (regla 11). El runtime de `main` es igual al de la rama.
- **Vuelta atrás:** `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=ayr-steel-erp-api-00147-5bk=100`
  y revert del merge. El cambio de vencimiento se deshace con el mismo diálogo o la misma CLI.

## Punto 3: el vencimiento de A2-02

El código y los montos están solo en `local-data/cc61/` y en el chat.

1. Respaldo de Neon. Había 10 ramas de 10, así que antes se borró por la regla 18 `respaldo-pre-cc51-20261013`
   (`br-divine-thunder-aetc4rfe`), el respaldo más viejo y sin ramas hijas.
2. Dry-run con `pnpm fix:vencimiento --branch production --confirm-production`.
   - La emisión es anterior al vencimiento pedido.
   - No hay NC 13 viva.
   - Cambian solo `dueDate` (de vacío a la fecha pedida) y `updatedAt`.
   - Hay una sola auditoría nueva y no se toca ningún otro comprobante.
3. `--execute` a las 12:11 de Lima: «EJECUTADO».
4. Un segundo dry-run lo rechaza con «El vencimiento ya es …».

Logs: `vencimiento-dry-prod.log`, `vencimiento-exec-prod.log` y `vencimiento-dry2-prod.log`.

## Qué entró

- **D-698 (NC-01, P1):** `fiscal-import.service.ts`.
  - `replacementLockScope` suma a la primera llamada de `lockDocuments` los despachos del reemplazo y el pedido.
  - `otherOrderDocumentsBlock` rechaza la anulación con otra factura o boleta del pedido, vigente o en borrador, o con
    una guía (por el despacho) a otro cliente.
  - Pruebas: db-spec en `credit-note-reasons.db-spec.ts` (también con un borrador) y unitarias en
    `fiscal-import-nc02.spec.ts`.
- **SEC-01 (P1):** `isLoginRoute` con `/i`. Las pruebas cubren variantes de mayúsculas y la barra final, y corren
  contra el enrutado real de Express (`throttler-client-ip.spec.ts`).
- **D-699: vencimiento editable.**
  - La regla está en `due-date-change.ts` (`dueDateChangeBlock` y `dueDateViolations`).
  - En el servicio: `updateDueDate` y `updateDueDateInTx`.
  - En la API: `PATCH /invoicing/documents/:id/due-date` (solo ADMINISTRADOR). El schema exige una fecha que exista en
    el calendario.
  - En la web: el diálogo `due-date-dialog.tsx`.
  - La CLI: `pnpm fix:vencimiento` (`apps/api/prisma/set-due-date-cli.ts`, `scripts/set-due-date.mjs`).
  - Pruebas: unitarias, db-spec y E2E en `nc-motivo-cc54.spec.ts`.
- **D-700: importador.** En `opening-balances-plan.ts` y `opening-balances.service.ts`: IMP-01, IMP-02, IMP-04,
  IMP-05 e IMP-08.
- **`lock-order.db-spec.ts`:** `withTurns` (las iteraciones 0 y 5 corren por turnos) y escalón en el par de cc57. El par
  (d) también usa turnos. El código de producción no cambia.

## Pruebas

- Formato, lint, typecheck y unitarias en verde: solo la API tiene 3755.
- `test:db` completo: 237 de 237, contra la base propia `ayr_local_e2e_cc61db`.
  - Par de cc57: 10 y 10. Par (d): 20 y 20.
  - Los db-spec de NC y del importador se corrieron otra vez tras las revisiones: 25 de 25.
- **E2E local completa** (build de producción, `CI=true`, base `ayr_local_e2e_cc61e`): 620 pasadas, 18 rojas, 1
  intermitente y 2 omitidas. Las 18 rojas son de infraestructura local:
  - 8 por el PSE apagado: «Emisión electrónica no habilitada».
  - 1 por R2 apagado.
  - 8 de CLI que apuntan a la base `ayr_local_e2e` de Docker y no a la propia.
  - 1 del XML de compras en `fase2a`, que en la CI pasa.
- **CI del PR #240:** en verde. Shards de la E2E, drift, smoke de Neon `ci` y SonarCloud, este último tras sumar
  unitarias de cobertura.

## Revisiones

- **Autorrevisión** por un subagente que no leyó este handoff: sin P0 ni P1. Es una lista de riesgos, no un pase
  cruzado.
- **Segundo modelo:** `docs/revision/cc61-segundo-modelo.md`, sin P0 ni P1. R-1 (fecha imposible) y R-2..R-4 están
  corregidos; la respuesta del autor está en el mismo archivo.

## No se hace (queda anotado)

- **`planReplacement`** tampoco ve las guías por despacho: es una pieza futura.
- **El `isoDateSchema` del resto del módulo de comprobantes** acepta fechas imposibles como `2026-02-31`, por
  `Date.parse`. Solo se blindó el vencimiento.
- **No hay par de concurrencia «anular 02 × crear factura del pedido»:** las dos operaciones bloquean el pedido y se
  serializan.
- **Que D-699 alcance a `ISSUED_HERE` y `VOID_PENDING`** es la regla tal como la aprobó el dueño. Queda como riesgo:
  hoy no hay ninguno, porque el PSE está apagado.

## Pendiente

- **Dueño:** ratificar D-698..D-700 y hacer el UAT de `docs/uat/cc61.md`.
- **cc62:**
  - el importador con el Excel: dry-run real, respaldo y `--execute` con OK;
  - NC-02 como saldo a favor del cliente (decisión del dueño);
  - IMP-03, IMP-06 e IMP-07 (operación y documentación).
- **cc63:** LK-01, LK-02, RC-01..RC-03.
- **cc64:** habilitar la venta del accesorio suelto (D-697).
- **cc65:** SEC-02, SEC-03, SEC-05/A2-07, NC-03, PERM-01, REG-01 y REG-02.

## Registro posterior (20/10/2026)

El dueño ratificó D-698, D-699 y D-700 y aprobó el UAT de cc61. Lo anota cc63.
