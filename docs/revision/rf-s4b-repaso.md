# RF-S4b — Repaso del delta posterior a la revisión cruzada

Fecha: 2026-09-23 (noche). Objeto: `git diff 2455291..73510e3`, 9 commits y 37 archivos: las
correcciones de `docs/revision/rf-s4b-cruzada.md`, el guard de `db-reset-dev.mjs` y los ajustes
de `.claude/settings.json`. La rama `rf-s4b-repaso` está adelantada a `origin/rf-s4b`
(`git merge --ff-only`: «Already up to date», HEAD `73510e3`).

Revisor: una sesión nueva de Claude Code. No escribió ni el delta ni la rama. No modifiqué código.

> **Sobre la independencia (AGENTS.md §2.2).** Esta sesión es distinta de la que escribió el
> delta. Esa sesión fue la misma que hizo la revisión cruzada y después corrigió lo que había
> encontrado. Pero es el mismo modelo, y el arranque incluyó leer `docs/handoff/rf-s4b.md`,
> porque lo pedía el prompt. Si este pase vale como independiente lo decide el dueño.

## Qué corrí

| Qué                                           | Resultado                                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`, `@ayr/shared` build, prisma   | ok                                                                                                                                  |
| `pnpm --filter @ayr/api test:cov`             | **963/963**, 74 suites                                                                                                              |
| `pnpm --filter @ayr/web test`                 | 11/11                                                                                                                               |
| `pnpm test:scripts`                           | 6/6 (incluye `db-reset-dev.test.mjs` y `run-api-cli.test.mjs`)                                                                      |
| `pnpm typecheck`, `pnpm lint`, `format:check` | verdes                                                                                                                              |
| CI de `73510e3` (run 35947418582)             | lint/typecheck/unit y análisis estático **verdes**. E2E del runner y smoke Neon `ci`: **en curso** al escribir esto (ver el cierre) |
| SonarCloud quality gate, PR #14               | **FALLA** en `6f82c31` y en `73510e3`: **79.3 %** de cobertura en código nuevo (exige ≥ 80 %)                                       |

No corrí E2E en local ni nada contra Neon. Los hallazgos salen de leer el código; ninguno lo
reproduje en ejecución.

## Hallazgos

No hay P0.

### P1-A — El quality gate de Sonar está en rojo, y el handoff lo pone como condición (1) de la ventana

- **Dónde:** check «SonarCloud Code Analysis» de `6f82c31` y de `73510e3`, con 79.3 %. El gate
  pasó con 80.6 % en `dd5ebd4`, y desde entonces se sumó código nuevo.
- **Qué pasa:** `docs/handoff/rf-s4b.md` («Estado y calendario») exige para la ventana «CI
  verde incluido el gate de Sonar». Hoy no se cumple. Que el gate quedara 0.6 puntos arriba ya
  estaba advertido en el handoff.
- **De dónde sale (lo leí en la tabla de cobertura del `test:cov` local):**
  - En `quotations.service.ts`, ningún unitario cubre el código nuevo de `storedCoilPools` y
    `storedCoilIds` (`:445-473`) ni `assertNoTypedImportMarker` (`:1146-1150`). Solo los
    ejercita el E2E, y el E2E no entra al lcov.
  - En el barrido quedan descubiertas `imported-documents-sweep.service.ts:489-503`.
- **Sugerencia:** unitarios de `assertNoTypedImportMarker` y de `storedCoilPools` con Prisma
  simulado. Son funciones chicas y alcanza para recuperar el punto. La otra salida es que el
  dueño acepte el gate en rojo como decisión `D-nnn`.

### P1-B — Los comandos que escriben en producción esta noche no pasan por el `ask` de D-251

- **Dónde:** `.claude/settings.json:14-35`.
- **Qué pasa:** el `ask` cubre `neonctl *`, `pnpm db:prod*` y `pnpm prod:*`, pero no cubre:
  - `pnpm normalize:coil-skus …`, `pnpm sweep:imported …` ni `node scripts/run-api-cli.mjs`.
    Tampoco `node scripts/{normalize-coil-skus,sweep-imported-documents}.mjs`.
  - `pnpm import:initial-inventory`.
  - `pnpm db:reset-dev` / `node scripts/db-reset-dev.mjs`, que desde `6f82c31` también
    resetea `demo`. `neonctl` se lanza desde dentro de node, así que la regla `neonctl *` no lo
    atrapa.
- **Escenario:** sesión en modo automático. El agente corre `pnpm normalize:coil-skus --branch
production --execute --confirm-production` o `--revert --execute --confirm-production` sin
  que el harness le pida el OK. Es justo el **punto crítico** del runbook. `--confirm-production`
  es una bandera que el agente mismo tipea, así que no reemplaza el `ask`. Lo mismo vale para
  reponer `demo` desde production: D-227 pide el OK del dueño.
- **Sugerencia:** agregar al `ask` los patrones anteriores: `Bash(pnpm normalize:*)`,
  `Bash(pnpm sweep:*)`, `Bash(pnpm import:*)`, `Bash(pnpm db:reset-dev*)` y
  `Bash(node scripts/*)`, o la lista explícita de `.mjs`. Es un cambio de configuración, no de
  código.

### P2

| #   | Dónde                                                                                                                 | Escenario concreto                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Sugerencia                                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `imported-documents-sweep.service.ts:596-614` (`amountsFinding`) y `:376-386`                                         | **El barrido pisa un cambio de precio hecho a propósito.** Empareja por producto + cantidad, y cualquier diferencia de importe la trata como el defecto de redondeo (b). Ejemplo: un ADMINISTRADOR bajó el precio de una línea de un pedido importado abierto, digamos de S/ 5 000 a S/ 4 500, con el mismo producto y la misma cantidad. El execute le devuelve S/ 5 000. D-256 (2) dice lo contrario: si cambia el precio, la línea deja de representar al comprobante. La corrección queda auditada, pero nadie la pidió.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Dos opciones. (i) Mandar a (c) toda diferencia mayor que lo que explica el redondeo de D-255 (del orden de `qty × 0.00005 + 0.01`). (ii) Mandar a (c) toda línea con un `sales.order.item-price` o una edición de precio auditada después de la importación. **Para esta noche:** en el dry-run, confirmar que cada (b) difiere en céntimos. |
| 2   | `sales-orders.service.ts:1155` (alta de pedido directo) y `quotations.service.ts` `duplicate` (`notes: source.notes`) | **La marca `Factura externa:` todavía entra sin pasar por el importador.** (a) En el pedido directo no hay `assertNoTypedImportMarker`: un VENDEDOR crea un pedido con `Factura externa: F001-1349` en las observaciones. Ese pedido queda `imported`, el barrido lo empareja con el papel de F001-1349 y le aplica `restorePaperAmountsInTx` si coinciden producto y cantidad. El cambio de precio del ADMINISTRADOR sobre ese pedido también queda exento del piso. (b) `duplicate` copia las observaciones: el duplicado de una importada nace con la marca. Es una cotización viva, pero el ADMINISTRADOR la edita sin piso y con `exactAmounts`, y el barrido la toma como segundo documento del mismo comprobante. D-256 (3) dice «el texto de las observaciones nunca otorga permisos». Hoy eso solo se cumple en el alta y la edición de cotizaciones. **Alcance limitado:** a un VENDEDOR no le da precio bajo el piso. El alta del pedido directo y el duplicado pasan por el piso, y el precio del pedido lo cambia solo el ADMINISTRADOR. | Aplicar `assertNoTypedImportMarker(null, input.notes)` en el alta de pedido directo, y quitar la marca en `duplicate`, que ya dice ser «una cotización viva de hoy» (D-157). **Para esta noche:** revisar en el dry-run del barrido que ningún comprobante aparezca en dos documentos.                                                       |
| 3   | `coil-sku-normalization.service.ts` `buildRevertPlan` (punto 3 del pedido)                                            | **Lo que pasa entre la normalización y el `--revert`.** Los documentos nuevos que apuntan al principal (SKU canónico) no se rompen: la reversa renombra el mismo `productId` y las líneas lo siguen. Pero hay dos casos que la reversa **no ve, no la detienen y no los deshace**. (a) Entra una bobina de un pool nuevo por la API nueva: `upsert` crea un producto con SKU **canónico** que no pertenece a la corrida. Después de `--revert` y de volver la API al SHA anterior, la API vieja busca el SKU viejo (`origin/main` `sales-lines.ts:666`) y rechaza la venta de esas bobinas con «no existe el producto de venta directa». Además, la próxima recepción crea el SKU viejo al lado del canónico, y el catálogo queda duplicado (D-168). (b) Una bobina de un color RAL unido se vende después de la corrida y su línea queda en el principal. Tras la reversa, esa venta figura bajo el producto de otro RAL, y los reportes por producto la atribuyen mal. Ninguno de los dos casos toca el kardex ni los importes.                     | Poner como parada en `buildRevertPlan`: productos `BOB…` creados después de `run.at` y líneas del principal creadas después de `run.at` sobre bobinas de un grupo unido. **Para esta noche:** escribir en el runbook que `--revert` solo es exacto dentro de la ventana, antes de que alguien opere.                                         |
| 4   | `sales-lines.ts` `assertPaperCoilsInPool`, rama `allowedPools`                                                        | En la edición de una cotización, la línea que manda `saleCoilId` sin `productId` (el barrido y la web) se valida contra los pools de **todo el documento**, no contra el de la línea. Si una cotización tiene líneas de 0.38 AZUL y de 0.45 ROJO, la línea AZUL acepta una bobina ROJO. La P2-1 de la revisión cruzada pedía «el pool de la fila (o de la línea)».                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Buscar la fila guardada por `reserveItemId` o por la posición emparejada y exigir su pool. Si no, dejarlo anotado en D-254 como alcance aceptado.                                                                                                                                                                                            |
| 5   | `scripts/db-reset-dev.mjs:43-50`                                                                                      | `--preserve-under-name` acepta cualquier nombre: `production`, `demo`, `ci` o `respaldo-pre-v4-20260915`. No verifiqué si Neon admite nombres de rama repetidos. Si los admite, una rama llamada `production` que en realidad guarda el demo viejo haría que `branches get production` o `connection-string production` resolvieran de forma ambigua en los guiones siguientes. Si no los admite, el reset falla después del guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Rechazar los nombres reservados y exigir un prefijo, por ejemplo `dev-antes-de-` o `demo-antes-de-`.                                                                                                                                                                                                                                         |
| 6   | `.claude/settings.json:7-8`                                                                                           | `allow` incluye `Bash(grep *)` y `Bash(sed -n *)`. Eso deja pasar sin preguntar `sed -n 1,50p .env.setup` o `grep … apps/api/.env`, y así se saltea el `deny` de `Read(**/.env*)` y AGENTS.md §3.1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Sumar `deny` para `Bash(* .env*)` o las variantes de `grep` y `sed` con `.env`, o sacar esos dos `allow`.                                                                                                                                                                                                                                    |
| 7   | `scripts/import-initial-inventory.mjs`                                                                                | Sigue levantando `AppModule` sin `EXTERNAL_OUTPUTS_OFF` ni `assertExternalOutputsOff`. Es el mismo defecto que la P1-2, en la CLI que la originó (D-206). No se usa esta noche.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Pasarla a `runApiCli` o aplicarle el mismo apagado.                                                                                                                                                                                                                                                                                          |

## Respuestas punto por punto

### 1. ¿Los P1 quedaron cerrados de verdad?

- **P1-1 (barrido): cerrado.** Busqué caminos alternativos:
  - **Emparejamiento:** es por clave normalizada + cantidad, con el importe como desempate. Si
    dos líneas reclaman la misma fila, las dos van a (c). Las filas `excluded` ya no entran
    (`report`, `byKey`).
  - **Línea común frente a un `BOB…` del papel:** las claves difieren (`PLA-X` ≠ `BOB38AZUL`),
    así que va a (c). Además, tanto `productFinding` como `fixQuotation` exigen
    `isCoilSaleProduct(line.product)` antes de atar una bobina: hay dos cerraduras
    independientes. En el pedido, `updateItemCoilInTx` también rebota.
  - **Pedidos:** el execute usa `f.amounts.paper` del hallazgo, no `paper[i]`. En todo el
    archivo ya no queda ninguna lectura por posición.
  - **Casos límite conservadores:** un `BOB…` viejo cuyo pool no se interpreta queda con una
    clave distinta de la canónica del papel y va a (c). Dos filas idénticas con el mismo
    importe también van a (c) y no se tocan.
  - **Lo que queda:** P2-1 (precio cambiado a propósito) y P2-4 de la revisión anterior (el
    execute recalcula el plan).
- **P1-2 (CLI con salidas externas): cerrado.**
  - El wrapper pone `EXTERNAL_OUTPUTS_OFF` **después** de `...process.env`.
  - `dotenv` no pisa una variable que ya existe aunque esté vacía, así que el `.env` no vuelve
    a encender R2.
  - `assertExternalOutputsOff` corre antes de `NestFactory` y aborta si algo quedó encendido,
    incluso si alguien corre el JS compilado a mano.
  - Los tres `onModuleInit` con efectos (`JobsService`, `InvoicingSendJob` con su barrido de
    arranque, `QuotationExpiryJob`) salen enseguida con `JOBS_ENABLED=false`.
  - `NUBEFACT_*` sigue heredándose, pero con `PSE_ENABLED=false` no se emite nada.
  - Si se pasa dos veces `--branch`, gana el primero y el filtro quita los dos. Con
    `--branch=production` (con `=`) la CLI cae en `local`, que es el lado seguro.
  - **Lo que queda:** P2-7 (`import:initial-inventory`).
- **P1-3 (exención del piso por rol): cerrado para el VENDEDOR.** Revisé estos caminos:
  - **Marca tipeada:** en el alta y la edición de cotización es un 400. `trimStart` cubre los
    espacios y el NBSP. Un carácter invisible al principio hace que `startsWith` tampoco
    reconozca la marca, así que no sirve para colarla.
  - **Importador:** es solo ADMINISTRADOR.
  - **Documentos importados:** su `sellerId` es el ADMINISTRADOR que importó, y
    `assertSellerAccess` le devuelve 404 al VENDEDOR.
  - **Línea cambiada:** cambiar precio, cantidad o producto saca la línea de `unchanged`, y
    entonces pasa por el piso y por D-116. Repetir una línea intacta no duplica la exención: la
    fila queda `taken`.
  - **Pedido importado:** el precio lo cambia solo el ADMINISTRADOR, y un cambio de cantidad
    hecho por otro rol pasa por el piso (`sales-order-edits.service.ts:717`).
  - **Lo que queda:** P2-2. La marca todavía entra por el pedido directo y por el duplicado. A
    un VENDEDOR no le da precio bajo el piso, pero contradice D-256 (3) y confunde al barrido.
- **P1-4 (`--revert`): cerrado como plan B dentro de la ventana.**
  - Lee solo la auditoría de la corrida, agrupada por `requestId`. Toma la última corrida sin
    deshacer y se guía por el orden del `id` autoincremental del `audit_log`.
  - Tiene paradas por SKU distinto, por un unido que ya no está unido y por un SKU viejo que
    tomó otro producto. Al final comprueba cada producto, y todo corre en una transacción.
  - Reactivar lo que se había unido es correcto: `buildPlan` solo une productos **activos**,
    así que ninguno estaba inactivo antes de la corrida.
  - **Límite:** P2-3.

### 2. ¿Las reglas del pool se validan en el servidor en los tres caminos?

Sí, con un matiz.

- **Importador:** `assertPaperCoilsInPool` compara el pool de la bobina con el del producto de
  la fila, que el importador siempre manda. También exige que la bobina sea una candidata de
  `coilPoolFor`: libre, sin OP, sin otra cotización abierta y con saldo suficiente.
- **Edición de cotización importada:** la bobina tiene que ser de un pool del documento y
  candidata, salvo que el documento ya la vendiera (`preexistingCoilIds`). El matiz es la P2-4:
  el pool se exige por documento, no por línea.
- **Pedido:** `updateItemCoilInTx`, sin cambios en este delta.
- **Líneas que no son del papel:** la línea que dejó de ser del papel, o la de un documento no
  importado, sigue con D-116 (rollo entero), igual que antes.

### 3. `--revert` con documentos nuevos creados después de la normalización

- **No rompe nada y no hace falta detenerse** cuando los documentos nuevos usan los productos de
  la corrida. Las líneas apuntan por `productId`, y la reversa solo cambia el SKU y la marca de
  unión de esas filas. El kardex y los importes no se tocan.
- **No detecta** dos casos (P2-3):
  - los productos canónicos que nacieron después, por una recepción con la API nueva;
  - la mala atribución de las ventas nuevas de un RAL unido.
- El primero sí rompe algo, pero recién **después** de volver la API al SHA anterior: esas
  bobinas quedan sin producto de venta hasta la próxima recepción, que además duplica el
  catálogo.
- Por eso `--revert` es exacto solo si corre dentro de la ventana.

### 4. `db-reset-dev.mjs`: ¿alguna combinación apunta a production?

No encontré ninguna.

- **Qué rama se resetea:**
  - `BRANCH` sale de una lista blanca con dos valores, `dev` y `demo`.
  - Si se repite `--branch`, gana el primero. Cualquier otro valor corta antes de tocar Neon, y
    eso lo prueba `db-reset-dev.test.mjs`.
- **Qué comprueba el guard (`reset-guard.mjs`)** sobre lo que **Neon devolvió**:
  - que el id del destino no sea el de production;
  - que el nombre del destino no sea `production`;
  - que el padre del destino sea production.
- **Por qué se resetea lo mismo que se comprobó:**
  - el reset va por `target.id`, así que no hay otra resolución por nombre entre el guard y el
    reset;
  - `--parent` escribe en el destino, nunca en el padre.
- **Entorno:**
  - `NEON_PROJECT_ID` es una constante de `lib.mjs` y no se lee del entorno;
  - `--project-id` va explícito;
  - `NEON_API_KEY` solo elige la cuenta.
- **Lo único que queda:**
  - el nombre de `--preserve-under-name` (P2-5);
  - que el reset de `demo` no pase por el `ask` (P1-B).

### 5. Regresiones del delta sobre lo aprobado

No encontré regresiones funcionales. Revisé lo siguiente:

- **Documentos no importados:** `withImportedAmounts` y `paperLines` solo actúan si el documento
  es importado, así que en los demás el comportamiento es idéntico.
- **Cambio de producto en una importada:** ahora el ADMINISTRADOR que cambia el producto de una
  línea importada pierde el IGV y el total del papel en **esa** línea, que se recalcula. Antes se
  conservaban si el importe coincidía. D-256 (2) lo decide así y queda acotado por la tolerancia
  del documento.
- **PDF:** la falla de `generatePdf` ahora suelta `pdfKey` también en producción, por ejemplo
  ante un error pasajero de R2. La descarga lo arma al vuelo, así que no se pierde nada.
- **`openCoilCodesInPool`:** suma las bobinas `CLOSED`, pero solo las que tienen saldo mayor que 0. Las cerradas vacías no bloquean desactivar el producto.
- **`check:coil-skus`:** usa `coilSaleSkus` y ya no da falsos «sin producto» después de la
  normalización.
- **`jest.config.js`:** solo cambió un comentario.

## Veredicto para la ventana de esta noche: **go con condiciones**

Las cuatro P1 de la revisión cruzada quedaron cerradas en el código, y los caminos alternativos
que busqué no las esquivan. Lo que bloquea es del proceso de la ventana, no del producto:

1. **P1-A:** el gate de Sonar en verde sobre el SHA que se despliega, o la aceptación explícita
   del dueño registrada como `D-nnn`. Hoy está en 79.3 %.
2. **P1-B:** el `ask` de `.claude/settings.json` cubre `normalize:coil-skus`,
   `sweep:imported` y `db:reset-dev` antes de correr cualquiera de ellos contra production o
   demo.
3. **CI:** el E2E del runner y el smoke Neon `ci` de `73510e3` (o del SHA final) en verde. Al
   escribir este informe estaban en curso.
4. **Runbook:**
   - en el dry-run del barrido, confirmar que cada (b) difiere en céntimos (P2-1) y que ningún
     comprobante aparece en dos documentos (P2-2);
   - anotar que `--revert` solo es exacto dentro de la ventana, antes de que se opere (P2-3).

Las P2-4 a P2-7 no bloquean.
