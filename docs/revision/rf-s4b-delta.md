# RF-S4b — Revisión del delta sin pase (`d29a342..57b10c9`)

Fecha: 2026-09-24. Objeto: `git diff d29a342..57b10c9 -- apps packages scripts` (15 commits, 27
archivos). Además, `scripts/snapshot-reports.mjs`, que entró en `a5a2022` (después de `57b10c9`) y
el pedido lo incluye, y los dos pendientes de UI y el reset de `demo` que dejó la ventana.

Revisor: una sesión nueva de Claude Code, en el worktree `ayr-steel-erp-rev-s4b` (rama
`revision/rf-s4b-delta`). No escribí ni el delta ni la rama, y no modifiqué código.

> **Sobre la independencia (AGENTS.md §2.2).** Es el mismo modelo que escribió RF-S4b, y el
> arranque incluyó leer el handoff de la ventana porque lo pedía el prompt. Como los dos pases
> anteriores, esto es una lista de riesgos y no una aprobación: RF-S4b sigue **PENDIENTE DE
> REVISIÓN INDEPENDIENTE**.

El código ya está en production, así que cada hallazgo se evalúa como **corrección hacia
adelante** (D-261).

## Qué corrí

| Qué                                                                                           | Resultado                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`, build de `@ayr/shared`, `prisma generate`                                     | ok                                                                                                                                                                                                                                                                         |
| `pnpm --filter @ayr/api test`                                                                 | **980 passed, 14 failed** (994). Los 14 son `auth.service.spec.ts`: el `beforeAll` (hash argon2) pasó el límite de 5 s mientras corrían las tres suites a la vez. Aislado: **14/14 en 4.1 s**. Lo clasifico como **infraestructura** (ver P2-9), no como defecto del delta |
| `pnpm --filter @ayr/web test`                                                                 | 11/11                                                                                                                                                                                                                                                                      |
| `pnpm test:scripts`                                                                           | 12/12 (`db-prod`, `db-reset-dev`, `run-api-cli`)                                                                                                                                                                                                                           |
| Dos scripts descartables (en el scratchpad, sin commitear) contra el `dist/` de `@ayr/shared` | Casos límite de `paperAmounts` / `paperTriplet`, cota de «editada a propósito» y NC parcial sobre la línea del trío (salidas abajo)                                                                                                                                        |

No corrí E2E, `typecheck`, `lint` ni nada contra Neon, Cloud Run o production. Dos tipos de
verificación, como en los pases anteriores: **en ejecución** (lo reproduje) y **leyendo** (lo
saqué del código).

## Hallazgos

No encontré P0. Hay 3 P1 y 9 P2.

### P1-1 — Guardar una cotización importada multiplica por el largo cada línea de plancha de catálogo (causa del ×6 de COT-000053/054)

- **Dónde:**
  - `apps/web/src/components/sales/sales-document-form.tsx:379` (`lineFromItem`): siembra el precio
    con `item.valuePerMeterPen ?? item.unitPricePen`.
  - `:233` (`isUntouched`): `!(l.kind === 'PRODUCT' && byFixedLength(product))`. Una línea de plancha
    de catálogo **nunca** cuenta como intacta.
  - `:283-289` (`linePricing` → `lineValues`, `:313-326`): si el producto es plancha de largo fijo,
    el número del campo se manda como `valuePerMeterPen`.
  - `:1702`: el campo solo cambia el rótulo a « /m».
  - El importador nunca carga `valuePerMeterPen`. En `apps/api/src/imports/` no aparece: la línea
    importada queda con `null` y el unitario por plancha.
- **Qué pasa (leyendo):**
  1. Una línea importada de `PL030NT6M` (plancha de 6 000 mm) tiene unitario 50.00 por plancha y
     `valuePerMeterPen = null`.
  2. Al abrir la edición, `lineFromItem` pone en el campo 59.00 (50 con IGV), que es el precio **por
     plancha**. El formulario le agrega « /m».
  3. Como la línea es de plancha, `isUntouched` da falso aunque nadie la haya tocado. Entonces no
     viaja el importe guardado (D-255) sino `valuePerMeterPen = 50`.
  4. El API calcula `6 × 50 = 300` por plancha. Como es ADMINISTRADOR sobre una importada, no hay
     piso. `recordPriceChanges` registra «S/ 59.00 → S/ 59.00 /m».
- **Escenario:** el ADMINISTRADOR abre cualquier cotización importada abierta que tenga una línea
  de plancha de catálogo. Corrige el producto de **otra** línea, o solo las observaciones, y
  guarda. La línea de plancha queda multiplicada por su largo: ×6 en las de 6 m y ×3.6 en las de
  3.60 m. Es exactamente la huella de COT-000053 y COT-000054 del 22/09 (handoff de la ventana,
  «Pendientes»). El total nuevo se ve en pantalla, pero nada lo marca como anómalo. Es la
  reinterpretación del mismo campo según el producto que D-161 prohíbe («nunca se reinterpreta el
  mismo campo según el producto»).
- **Alcance:** no sé cuántas de las 28 cotizaciones importadas abiertas tienen líneas de plancha,
  porque no consulté production. El diálogo de precio del **pedido** no tiene el defecto:
  `order-edit-dialogs.tsx:107` decide por metro con `lastItem.valuePerMeterPen !== null`, que es lo
  guardado, no el producto.
- **Arreglo mínimo (solo web):**
  1. En `lineFromItem`, si `item.valuePerMeterPen === null` y el producto es de largo fijo, marcar
     la línea como «cargada por unidad» (por ejemplo, `original.perUnit = true`).
  2. En `isUntouched`, no excluir esa línea: mientras no la toquen, viaja el importe guardado,
     como cualquier otra importada.
  3. Si la tocan, no reinterpretar el número. Sembrar el campo en modo importe
     (`amountMode: 'AMOUNT'`, `netAmountPen = subtotalPen`), o convertirlo a por metro dividiendo
     por el largo y mostrar un aviso («esta línea se cargó por plancha; el precio ahora es por
     metro»).
  4. Test de unidad de `lineFromItem` + `linePricing` con una plancha importada. Hoy esas
     funciones no se exportan.
  - **Cinturón del lado del API (opcional):** en `QuotationsService.update`, rechazar una línea que
    pasa de `valuePerMeterPen = null` a no nulo con el mismo producto y
    `nuevo por metro == unitario anterior`. Es la firma exacta del gesto.

### P1-2 — `snapshot-reports.mjs --ephemeral-admin` escribe siempre en production, aunque la foto sea de otro entorno, y el comando no está en el `ask`

- **Dónde:** `scripts/snapshot-reports.mjs:30-43` (`runInApi` fija `neonConnectionString('production')`),
  `:46-56` (crea el admin) y `:64-65` (lo borra). `--base-url` (`:187`) es independiente de esa
  base. `.claude/settings.json` no tiene ninguna regla para `node scripts/snapshot-reports.mjs`.
- **Qué pasa (leyendo):** la herramienta dice ser «solo GET, salvo el login». Pero con
  `--ephemeral-admin`:
  - crea un ADMINISTRADOR por Prisma directo (`prisma/e2e-admin.ts`, upsert + fila
    `e2e.admin.create` en `audit_log`);
  - después corre `cleanup-e2e-users.ts`, que borra **todos** los `e2e-…@ayr.test` de production,
    con sus turnos de caja.
    Todo eso contra production, sea cual sea la API que se fotografía.
- **Escenario A:** `node scripts/snapshot-reports.mjs snapshot demo-antes --out … --base-url
http://localhost:3000/api --ephemeral-admin`, para la foto del ensayo en demo. El admin se crea
  en **production**, el login contra demo da 401 y la limpieza borra en production. Quedan dos
  escrituras en production que nadie pidió, sin pasar por el `ask` (D-251). Si en ese momento
  corre un `smoke:prod`, la limpieza le borra su admin efímero a mitad de la corrida.
- **Escenario B:** `--env-file .env.demo` sin `--base-url`. El default es production, y
  `.env.demo` trae el `ADMIN_EMAIL` real con la contraseña de demo, así que queda un
  `auth.login.failed` del dueño en el `audit_log` de production. Es menor, pero es otra escritura
  en el entorno equivocado.
- **Sugerencia:**
  - `--ephemeral-admin` crea el admin en la rama que corresponde a `--base-url`, o se niega si el
    host no es el de production (`v2.mareliac.pe`, `*.vercel.app` del proyecto).
  - El default de `--base-url` debería ser explícito (sin default), o por lo menos tener que
    coincidir con la rama.
  - Agregar `Bash(node scripts/snapshot-reports.mjs*)` al `ask`.

### P1-3 — Resetear `demo` (o `dev`) le devuelve la contraseña de production al rol, y la rotación que documenta AGENTS.md usa un comando que no existe

- **Dónde:** `scripts/db-reset-dev.mjs:77-88` (reset por id con `--parent`, sin ningún paso
  posterior sobre roles) y `AGENTS.md` §3.1 («Rotar `neondb_owner` implica `neonctl roles
reset-password`»).
- **Confirmado (documentación de Neon + código; no lo medí contra Neon):**
  - Neon, _Protected branches_ y changelog del 2024-08-30: el reset o restore de una rama hija
    **devuelve las contraseñas de los roles a las del padre**, salvo que el padre sea una rama
    **protegida** (planes Scale/Business). En ese caso, las hijas nacen con contraseña propia y el
    reset las conserva.
  - AGENTS.md §3.1 dice que la contraseña de `neondb_owner` es la misma en las cuatro ramas. Eso
    solo es compatible con un `production` no protegido.
  - Conclusión: cada `db-reset-dev.mjs --branch demo` deja a `demo` con la contraseña de
    production, y `pnpm env:demo` la escribe en `.env.demo` (`scripts/env-demo.mjs:16-17,36-37`).
  - Lo mismo vale para `--branch dev` y su `apps/api/.env`.
- **El comando de rotación no existe:** el `neonctl` instalado (4.15.0) tiene en `roles` solo
  `list`, `create` y `delete` (lo leí en su código, sin ejecutarlo). La API sí lo tiene:
  `POST /api/v2/projects/{project_id}/branches/{branch_id}/roles/{role_name}/reset_password`
  (`resetProjectBranchRolePassword` en `@neon/sdk`).
- **Escenario:** alguien comparte `.env.demo` para una UAT, o lo filtra un log. Esa contraseña
  entra al host de production como `neondb_owner`. La mitigación de D-125 (`JWT_SECRET` propio)
  cubre las sesiones, pero no la base.
- **Propuesta (dentro del script, conexión y credencial solo por entorno):**
  1. Después del `branches reset` (`:88`), y **solo** si `target.id !== parent.id` (ya lo garantiza
     la cerradura), rotar el rol en la rama recién reseteada:
     - Credencial: `NEON_API_KEY` desde `process.env`, o desde `readEnvFile()` si el dueño la agrega
       a `.env.setup`. Nunca por argv.
     - `fetch` a `…/branches/${target.id}/roles/neondb_owner/reset_password` con
       `Authorization: Bearer`, reintentando mientras responda 423 (el reset deja operaciones en
       curso; `neonctl` usa `retryOnLock` por lo mismo).
     - De la respuesta no se lee ni se imprime la contraseña: solo el estado. En el error, nada del
       cuerpo.
  2. Verificar sin imprimir: pedir `reveal_password` de la rama **antes** de rotar (recién
     reseteada, es la de production) y **después**, y comparar los `sha256` en memoria con
     `timingSafeEqual`. Si son iguales, salir con código ≠ 0 y el mensaje «la rotación no se aplicó:
     `.env.demo` sería una llave de production». Así no hace falta pedir la credencial de la rama
     `production`.
  3. Como la contraseña cambió, invalidar el `.env.demo` viejo: borrar sus dos URL, o por lo menos
     imprimir que `pnpm env:demo` es **obligatorio** (hoy es el paso 1 de una lista).
  4. Test en `db-reset-dev.test.mjs` con `fetch` simulado: sin `NEON_API_KEY` corta **antes** del
     reset (no después, para no dejar la rama con la contraseña de production), y 423 → reintento.
  5. Corregir AGENTS.md §3.1: la rotación es por API, no con `neonctl roles reset-password`.
  - **Límite:** mientras `production` no esté protegida, cada reset vuelve a igualar las
    contraseñas. Por eso la rotación va dentro del mismo script y no como paso manual. La ventana
    entre el reset y la rotación son segundos.
  - Aparte, y como decisión del dueño: los `.env.demo` generados desde el 2026-09-24 ya contienen
    la contraseña de production. Si alguno salió de la máquina del dueño, por §3.1 corresponde
    rotar `neondb_owner` en production.

### P2

| #   | Dónde                                                                                     | Escenario concreto                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Sugerencia                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `quotation-import.service.ts:287` contra `:815` (`readPaperLines`)                        | **El importador y el barrido pueden leer distinto el mismo trío (en ejecución).** El importador pasa a `paperAmounts` el valor ya redondeado a 4 decimales (`money(net)`), y el barrido el crudo (`net ?? netPen`). Con un valor de 5 o más decimales hay doble redondeo: con 10 000.00495 / 1 800.00 / 11 800.00, el importador **descarta** el trío (10 000.01 deja el IGV a 0.0118 del 18 %) y el barrido lo **acepta** (10 000.00). Resultado: el documento importado queda con el IGV calculado y el barrido lo «corrige» después, al revés de lo que se aprobó en el dry-run. El comentario de `:792-796` promete «la misma lectura que `preview`». Con los exports vistos (valor de 3 decimales) no pega.                                                                                                                                                                                                                                                                                                                                    | Una sola función `paperRowAmounts(row)` usada por los dos, o pasar `netPen` en `:815`.                                                                                         |
| 2   | `imported-documents-sweep.service.ts:197-214, 419-421` y `price-changes.ts:50-51, 66`     | **«Editada a propósito» se decide por número de línea, y ese número envejece.** `recordPriceChanges` guarda el `lineNumber` **posterior** a la edición. La cotización recrea sus líneas 1..n en cada guardado. Si después se quita una línea anterior, el registro queda apuntando a otra: la línea editada ya no aparece como editada y otra inocente sí. Además, `recordPriceChanges` empareja por `productId`: si en la misma edición se cambió producto **y** precio, no hay registro. En los dos casos solo protege la cota de redondeo, que crece con la cantidad (en ejecución: S/ 0.21 a 4 194 kg, S/ 1.00 a 20 t y S/ 3.00 a 60 t por línea): un descuento deliberado por debajo de la cota se pisa. **Herencia pedido ← cotización:** está bien por número de línea: el pedido copia el `lineNumber` de la cotización al confirmar (`sales-orders.service.ts:801`) y agrega con `max + 1` (`sales-order-edits.service.ts:517`). La consulta no filtra por fecha, pero todo registro es posterior a la importación, así que no hace falta. | Registrar también el `quotationItem.id`/`salesOrderItem.id` en `sales_price_changes`, o emparejar por producto + cantidad como el propio barrido. Documentar la cota en D-258. |
| 3   | `imported-documents-sweep.service.ts` → `QuotationsService.update` → `recordPriceChanges` | **Las correcciones del propio barrido quedan como cambios de precio del ADMINISTRADOR.** Cuando el importe corregido mueve el unitario de 4 decimales (líneas de poca cantidad: 100.005 → 100.00 en 10 u), se crea una fila en `sales_price_changes` a nombre de `ADMIN_EMAIL`. La tarjeta de cambios de precio la muestra como una edición humana. Una segunda corrida del barrido (otro export, una regla afinada) manda esas líneas a (c) como «editadas a propósito» (leyendo; no sé cuántas de las 36 de production lo generaron).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Pasar el motivo a `recordPriceChanges` y excluir del criterio las filas del barrido, o no registrar cuando `auditReason` es del barrido.                                       |
| 4   | `quotations.service.ts:339`                                                               | **Los 30 s valen para toda edición por HTTP, no solo para el barrido.** La transacción tiene `FOR UPDATE` sobre la cotización (`lockQuotation`) y las filas de sus líneas desde el principio. Si hay reserva temporal, también toma el candado de `reserveLines`, pero recién al final. El bloqueo real se limita a otras operaciones sobre **la misma** cotización (confirmar, el vencimiento, otra edición). El costo que sí es de todos es la **conexión**: una edición lenta retiene una del pool hasta 30 s, en vez de soltarla a los 5. Con el pool por defecto de Prisma (2 × vCPU + 1) en una instancia de Cloud Run chica, dos o tres ediciones lentas dejan a las demás requests esperando `pool_timeout` (leyendo; no conozco el `connection_limit` de production).                                                                                                                                                                                                                                                                      | Pasar `{ timeout }` solo desde el camino del barrido (ya existe `options`), o medir el p95 de `PUT /sales/quotations/:id` en production y confirmar `connection_limit`.        |
| 5   | `packages/shared/src/schemas/quotation-import.ts:491` (`keepImportMarker`)                | **Una edición puede cambiar el comprobante al que apunta la marca.** Si las observaciones nuevas **empiezan** con la marca actual, se guardan tal cual: `Factura externa: F001-1349` → `Factura externa: F001-13490` pasa, y `externalInvoiceOf` devuelve otro comprobante. El barrido y el aviso de reimportación lo siguen. Solo el ADMINISTRADOR accede a una importada (`sellerId`), así que no es un bypass de rol. Pero es texto que cambia la procedencia, en contra de D-256 (3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Comparar la primera línea exacta (`newNotes.split('\n')[0] === marker`), no `startsWith`.                                                                                      |
| 6   | `apps/api/src/common/cli-branch-gate.ts:14-26`                                            | **La cerradura interna confía en `AYR_CLI_BRANCH`.** El JS compilado, corrido a mano con el `DATABASE_URL` de production y sin `AYR_CLI_BRANCH`, hace el dry-run (lee production). D-261 dice «ni siquiera en dry-run». Con `AYR_CLI_BRANCH=demo` y la URL de production, hasta el `--execute` pasa. Hace falta armar el entorno a mano, así que es de bajo riesgo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Sin rama declarada, no correr ningún modo. Opcional: comparar el host del `DATABASE_URL` con el endpoint de la rama declarada (el id del endpoint no es secreto).              |
| 7   | `.claude/settings.json` (`ask`)                                                           | **Huecos del `ask` de D-261.** No cubren `pnpm db:reset-dev …` (sí `node scripts/db-reset-dev.mjs`), ni `node scripts/normalize-coil-skus.mjs` / `sweep-imported-documents.mjs` / `run-api-cli.mjs` directos, ni `pnpm run normalize:coil-skus …` (la regla es `pnpm normalize:*`), ni `snapshot-reports.mjs` (P1-2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Agregar esos patrones. Es config: el dueño la aplica (el clasificador no deja que el agente edite `permissions.ask`).                                                          |
| 8   | `invoicing.service.ts:996-1011` (NC parcial) y `:802-806` (comprobante parcial)           | **Acreditar o facturar en partes una línea con el trío deja 0.0006 sin cubrir (en ejecución).** Sobre FFA1-1350 (12 439.83 / 2 239.17 / 14 679.00), dos partes de cualquier tamaño (2097 + 2097, 1 + 4193) suman 12 439.83 / **2 239.1694** / **14 678.9994**. Solo la línea entera copia el importe guardado. La última parte recalcula el IGV al 18 %, y el IGV del trío es la resta. Con el cobro que redondea al céntimo hacia arriba (D-169), queda el céntimo que D-169 vino a cerrar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | La parte que agota lo pendiente de la línea toma el **resto** (guardado − ya facturado o acreditado), en vez de recalcular.                                                    |
| 9   | `apps/api/src/auth/auth.service.spec.ts:41`                                               | **Infraestructura.** El `beforeAll` (hash argon2) tarda 4.1 s aislado, contra un límite de 5 s: con la máquina cargada se cae y arrastra los 14 tests del archivo. Es ajeno al delta, pero ensucia cualquier corrida local de la suite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `beforeAll(…, 20_000)`, o bajar el costo de argon2 en el test.                                                                                                                 |

### Los dos pendientes de UI

**1. La bobina atada no se ve (P2, confirmado leyendo).**

- `cotizacion-detalle-view.tsx:328-331` pinta `productSku` y `description` y nunca `reserveItemLabel`,
  aunque el DTO lo trae (`sales.ts:600`). El pedido tampoco lo muestra en la tabla: solo aparece
  dentro del diálogo «Cambiar bobina» (`order-edit-dialogs.tsx:541`).
- `coilPoolFor` (`coil-sale-product.ts:408-424`) descarta en silencio las bobinas atadas a una
  cotización `DRAFT`/`EMITTED`. Lo mismo hace con las montadas y las reservadas.
- **Arreglo mínimo:**
  - En las dos tablas, bajo el SKU, si `item.reserveItemType === 'COIL'`: `Bobina
{reserveItemLabel}`. Son cuatro líneas por vista.
  - En `coilPoolFor`, seleccionar el `seq` de la cotización que ata cada bobina y devolver
    `taken: [{ code, by: 'COT-000002' | 'OP …' | 'reservada' }]` junto a `candidates`. El selector
    lo muestra en una línea: «No se ofrecen: SALDO-… (atada a COT-000002)».
  - Sin cambios de regla ni de migración.

**2. Cambio de unidad que multiplica el total:** es P1-1. La causa no es un cambio de unidad que
haga el usuario. Es la reinterpretación automática del precio de una línea importada de plancha al
guardar.

### Casos límite del trío (D-255 opción A), en ejecución

| Entrada (valor / IGV / total)         | `paperAmounts`                    | `paperTriplet` del API | Lectura                                                                                                                   |
| ------------------------------------- | --------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 12 439.831 / 2 239.16958 / 14 679.000 | 12 439.83 / 2 239.17 / 14 679.00  | acepta                 | FFA1-1350, como D-255                                                                                                     |
| 100.00 / 18.01 / 118.00 (0.01 exacto) | 100.00 / 18.00 / 118.00           | acepta                 | La frontera entra (`gt`), coherente con `lte` del API. El IGV del papel (18.01) se reemplaza por la resta: manda el total |
| 100.00 / 18.0100001 / 118.00          | `null`                            | —                      | Afuera, bien                                                                                                              |
| negativos (−12 439.831 / …)           | simétrico (HALF_UP lejos de cero) | acepta                 | No llega a usarse: el importador rechaza el valor ≤ 0, y las filas de nota del barrido son `excluded`                     |
| signos mezclados, IGV 0               | `null`                            | —                      | IGV 0 cae al 18 % calculado (P2-9 de la cruzada, ya documentado)                                                          |
| valor o total en .xx5                 | HALF_UP                           | acepta                 | Sin sorpresa                                                                                                              |

NC y comprobante parciales: P2-8.

## Respuestas punto por punto

1. **Trío del papel.** La regla está bien implementada y es coherente con el API en la frontera
   de 0.01. Para datos consistentes, la cota del IGV no descarta tríos legítimos: redondear el valor
   a 2 decimales mueve el IGV como mucho ~0.0065. Hay dos grietas: el importador y el barrido
   redondean distinto (P2-1), y las operaciones parciales pierden la resta (P2-8).
2. **«Editada a propósito».** Cuenta como edición cualquier fila de `sales_price_changes` del
   documento o, si es un pedido, de su cotización: un cambio de unitario o de valor por metro sobre
   el mismo producto. No cuenta cambiar la cantidad (eso rompe el emparejamiento → (c)) ni cambiar
   producto y precio a la vez (P2-2). El pedido hereda bien por número de línea. Los agujeros son
   que el número envejece (P2-2) y que el barrido se registra a sí mismo (P2-3).
3. **D-256 por rol y la marca.**
   - La exención del piso y la venta parcial siguen siendo del ADMINISTRADOR, y el resto de los
     roles tiene `paperLines`.
   - La marca tipeada se rechaza en el alta y la edición de cotización (`quotations.service.ts:124,
221`) y en el pedido directo (`sales-orders.service.ts:1053`). El duplicado la quita
     (`:587`), el importador es solo ADMINISTRADOR y el pedido confirmado la hereda a propósito.
   - No encontré otro camino que escriba `notes` en cotizaciones o pedidos (los demás ponen
     `null`).
   - Queda P2-5: la edición de una importada puede cambiar el número del comprobante.
4. **Correcciones del ensayo.**
   - **`JWT_SECRET` al azar:** correcto. Va después de `...process.env` y no se imprime.
     `abortOnError: false` deja ver el error.
   - **La anulada que quitaba la bobina:** correcto. Los cerrados se reportan sin
     `autoCoilId` y ya no cuentan en la competencia.
   - **Timeout:** no bloquea nada fuera de la propia cotización. El costo real es la conexión
     retenida (P2-4).
5. **Scripts.**
   - **`db-prod.mjs`:** sin `--with-seed` solo migra. Una bandera desconocida corta antes de leer
     `.env.setup` o llamar a `neonctl`, y las credenciales del admin viajan solo con seed. Un
     `pnpm db:prod -- --with-seed` que pase el `--` literal falla cerrado.
   - **`reset-guard.mjs` / `db-reset-dev.mjs`:** ninguna combinación apunta a production. La
     lista blanca es `dev`/`demo`, la cerradura va por id y nombre sobre lo que devolvió Neon, el
     reset es por id y el nombre de preservación lleva prefijo.
   - **`snapshot-reports.mjs`:** sí escribe donde no debe (P1-2).
6. **UI.** Arriba: la bobina atada (P2, arreglo mínimo) y el ×L (P1-1).
7. **Reset de `demo`.** Hereda la contraseña de production (P1-3), con la propuesta de rotación
   por la API de Neon dentro del script.

## Qué corregir primero

1. **P1-1** (web, chico, en production hoy). Mientras no esté el arreglo, avisar al ADMINISTRADOR
   que **no edite cotizaciones importadas con líneas de plancha**. Después, revisar con una
   consulta de solo lectura (por servicio o por reporte) si alguna importada abierta tiene
   registros «S/ X → S/ X /m» como los de COT-000053/054.
2. **P1-3**: la rotación en `db-reset-dev.mjs`, y corregir AGENTS.md §3.1 (el comando no existe).
   Antes del próximo reset de `demo`.
3. **P1-2**: `snapshot-reports.mjs` ligado a la rama de `--base-url` y en el `ask`, antes de la
   próxima ventana. Junto con P2-7, el resto del `ask`.
4. **P2-8** (céntimo de las operaciones parciales) y **P2-1** (una sola lectura del trío), antes de
   encender el PSE o de otra corrida del barrido.
5. **P2-2 / P2-3**: antes de volver a correr el barrido.
6. Los pendientes de UI (bobina visible) y el resto de los P2, cuando toque.
