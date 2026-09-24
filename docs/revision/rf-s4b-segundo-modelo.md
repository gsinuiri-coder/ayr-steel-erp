# Revisión RF-S4b — segundo modelo (contexto limpio)

**Alcance:** `git diff f60ab6c..e27570a -- apps packages scripts` (85 archivos, ~11.7k líneas).
**Modelo revisor:** Sonnet 5 (Claude Sonnet, vía Claude Code).
**Fecha:** 2026-09-24.

> Nota: esta es una revisión por segundo modelo, con contexto limpio (no leyó el handoff ni los
> informes previos de `docs/revision/` hasta después de formar sus propios hallazgos). No
> reemplaza una revisión humana independiente.

Enfoque: los caminos de dinero — trío del papel (D-255), exención por rol (D-256), barrido de
documentos importados (D-264), facturación parcial (D-265), selección de bobina (D-254) — y fugas
de información entre vendedores. Cada hallazgo se verificó leyendo el código real, no el diff
resumido ni los mensajes de commit; se cita archivo:línea y se indica confianza (confirmado /
plausible).

---

## P0

Ninguno encontrado.

---

## P1

### SM-P1-1 — `GET /sales/coil-pool` expone el código de la cotización de otro vendedor a cualquier VENDEDOR

**Confianza:** confirmado (trazado el camino completo: servicio → controlador → UI, sin ningún
punto de corte por vendedor).

**Archivos:**

- `apps/api/src/sales/coil-sale-product.ts:407-448` (`coilPoolFor`, construcción de `taken`)
- `apps/api/src/sales/sales-orders.service.ts:3076-3091` (`SalesOrdersService.coilPool`, sin
  parámetro `actor`)
- `apps/api/src/sales/sales.controller.ts:412-421` (`GET /sales/coil-pool`, sin `@Roles` propio —
  hereda el de la clase, `@Roles(Role.ADMINISTRADOR, Role.VENDEDOR)` en la línea 95 — y sin pasar
  `actor` al servicio)
- `apps/web/src/components/sales/order-edit-dialogs.tsx:549-552`
- `apps/web/src/components/sales/sales-document-form.tsx:1770-1814`

**Escenario concreto:** un VENDEDOR autenticado (rol base del módulo comercial, sin ningún
privilegio especial) abre el selector de bobina de **su propia** cotización o pedido para un
producto de venta de bobina (D-116/D-254) — o llama directo a
`GET /sales/coil-pool?productId=<bobina-de-venta>&qty=<n>`, que no exige nada más que estar
autenticado como VENDEDOR o ADMINISTRADOR. `coilPoolFor` arma la lista `taken` recorriendo
**todas** las cotizaciones `DRAFT`/`EMITTED` del sistema que tienen esa bobina atada
(`coil-sale-product.ts:417-427`, la consulta a `quotationItem` no filtra por `sellerId` en ningún
punto) y para cada una arma el texto:

```ts
// coil-sale-product.ts:437
for (const q of quoted) takenBy.set(q.reserveItemId, `atada a ${quotationCode(q.quotation.seq)}`);
```

Ese texto —p. ej. `atada a COT-000002`— viaja tal cual en `CoilPoolDto.taken[].by` y el web lo
pinta sin condición:

```tsx
// order-edit-dialogs.tsx:549-552 y sales-document-form.tsx:1812-1814
{
  pool.data.taken.length > 0 && (
    <p>No se ofrecen: {pool.data.taken.map((t) => `${t.code} (${t.by})`).join(', ')}</p>
  );
}
```

Así, un VENDEDOR que no tiene ninguna relación con `COT-000002` (que puede ser de otro vendedor,
con otro cliente) se entera de que existe, de su código y de que tiene esa bobina comprometida —
justo lo que la política única de alcance comercial RF-S3c prohíbe: _"Lo ajeno se presenta como
inexistente"_ (`apps/api/src/auth/seller-scope.ts:5`). El resto del módulo respeta esa regla
sistemáticamente (`findQuotations`, `assertSellerAccess`, `sellerWhere`/`quotationSellerWhere`
filtran por `actor.role === VENDEDOR ? {sellerId: actor.id} : {}`); este endpoint es la única
ruta del delta que no pasa `actor` al servicio y por lo tanto no puede aplicar el filtro.

Nótese la asimetría que delata el descuido: el mismo `taken` para una bobina **montada en una
OP** o **reservada por un pedido** usa un texto genérico (`'montada en una OP'`,
`'reservada por un pedido'`, línea 438 y 448) que no identifica el pedido ni a su dueño — solo la
rama de cotización filtra por `quotationCode`, exponiendo el único identificador de documento que
no se anonimizó.

**Por qué no es una decisión de diseño y sí un descuido:** el propio `docs/revision/rf-s4b-delta.md`
(revisión previa de esta misma ventana) recomendó agregar exactamente este texto («taken:
[{code, by: 'COT-000002' | 'OP …' | 'reservada'}]») como arreglo de un problema de UX distinto
(bobinas que se descartaban en silencio, P2), y esa misma sesión anterior había revisado
`RF-S3c` sobre este endpoint **antes** de que existiera el campo `taken` (`rf-s4b-cruzada.md`,
punto 5: _"`GET /sales/coil-pool` no devuelve costo, margen ni valuación: solo código, ancho y
saldo"_) — verificación que en ese momento era correcta, pero que ninguna revisión posterior repitió
después de agregarse `taken.by` con el código de cotización.

**Alcanzable hoy:** sí, por cualquier VENDEDOR con sesión válida, sin necesitar ningún permiso
adicional ni error de otro componente.

**Sugerencia de arreglo (costo estimado: barato):**

1. Pasar `actor: RequestUser` a `SalesOrdersService.coilPool` desde el controlador (ya está
   disponible vía `@CurrentUser()` en el resto de los endpoints de esta clase).
2. En `coilPoolFor`, filtrar la consulta de `quotationItem` por `sellerId` cuando el llamador no
   es ADMINISTRADOR (mismo patrón que `quotationSellerWhere`), **o** — más simple y sin tocar la
   firma de una función usada también por el importador y el barrido (que sí necesitan ver todo
   el sistema) — anonimizar `by` a un texto genérico (`'atada a otra cotización'`) cuando quien
   pregunta es un VENDEDOR y la cotización no es suya.
3. Cubrir con un test que arme dos VENDEDOR distintos y confirme que ninguno ve el código de la
   cotización del otro en `taken`.

---

## P2

### SM-P2-1 — `paperAmounts` puede acumular hasta ~S/0.02 de desvío frente al papel crudo (documentado como política, no como límite)

**Confianza:** confirmado, informativo (no es un defecto, es una observación de robustez/documentación).

**Archivo:** `packages/shared/src/schemas/sales.ts:177-191` (`paperAmounts`).

La función redondea `net` y `total` **independientemente** a 2 decimales (`ROUND_HALF_UP`) y
deriva `igv = total - net`, con dos tolerancias de S/0.01 encadenadas (la primera sobre
`net+igv-total` crudo, la segunda sobre `igv` contra el 18% esperado). En el peor caso teórico
esto puede alejar el trío guardado hasta ~S/0.02 del papel crudo, no solo S/0.01. Es exactamente
lo que la aclaración del dueño de 2026-09-24 (D-255) pidió y fue ensayado en demo con
FFA1-1350/1355, así que **no es un hallazgo que requiera cambio de código** — solo sugiero dejar
el peor caso documentado en el propio comentario de la función, para que una sesión futura no lo
redescubra creyéndolo un bug.

**Costo estimado:** barato (solo comentario).

### SM-P2-2 — `PartLedger`/`closingPartTotals`: falta cobertura de 3+ partes con edición de precio intermedia

**Confianza:** plausible (no encontré un caso concreto que falle; es una sugerencia de cobertura,
no un hallazgo de defecto).

**Archivos:** `apps/api/src/invoicing/invoicing-math.ts:108-178`,
`apps/api/src/invoicing/invoicing-math.spec.ts:376-451`.

Los tests cubren: reparto exacto en 2 o 3 partes sin edición de precio, y 2 partes donde **la
única parte anterior** tuvo un precio editado. No hay un caso de 3+ partes donde la edición de
precio ocurre en una parte **intermedia** (ni la primera ni la última). Por el diseño de
`closingPartTotals` (compara el resto real contra el recálculo con tolerancia de S/0.01) el
comportamiento debería seguir siendo correcto — cae a recompute si el resto ya no es
representativo — pero no hay una prueba que lo demuestre para ese caso concreto sobre datos reales
del proyecto.

**Costo estimado:** barato (agregar un `it` al spec existente).

### SM-P2-3 — Documentar el corte de `taken.by` entre cotización (identifica) y pedido/OP (anónimo) como parte del arreglo de SM-P1-1

Al corregir SM-P1-1, vale la pena decidir explícitamente si `taken.by` para una bobina
**reservada por un pedido** de otro vendedor debería seguir siendo genérico (`'reservada por un
pedido'`) o si, por simetría, la cotización debería anonimizarse de la misma forma en vez de
filtrarse por dueño. Cualquiera de las dos cierra RF-S3c; dejarlo mixto (como está hoy) es lo que
generó la asimetría que delató el hallazgo.

**Costo estimado:** barato (decisión de diseño, ninguna migración).

---

## Áreas revisadas sin hallazgos

- **Trío del papel (D-255):** `paperTriplet`, `lineAmounts`, `derivedUnitValue` (10 decimales) y
  su uso consistente en los cuatro puntos que D-255 promete — facturar la línea completa
  (`invoicing.service.ts:814`), nota de crédito parcial (`:1023-1026`), payload de Nubefact
  (`toIssueCommand`, `:2020`, y `nubefact-payload.ts:144-154`) y cambio de cantidad de un pedido
  (`sales-order-edits.service.ts:958-961`). No encontré ningún punto que siga usando el
  `unitPricePen` guardado a 4 decimales para una cuenta. `amountBasisOf`/`igvAmountPen` sin
  `positive: true` en el schema no es explotable porque `paperTriplet` exige el 18% del `net`
  (que sí es positivo) a menos de un céntimo.

- **Exención por rol (D-256):** `quotations.service.ts` (`update`, `create`, `withImportedAmounts`,
  `assertNoTypedImportMarker`) y `sales-orders.service.ts:1050-1057` (`createDirect`) — el corte
  `admin = actor.role === Role.ADMINISTRADOR` gatea correctamente el piso de precio y el
  `paperLines`/tolerancia; la marca `Factura externa:` en las observaciones se rechaza si alguien
  que no es el importador intenta escribirla, tanto en el alta de cotización como en el pedido
  directo y en la edición; el duplicado de una cotización importada nace sin la marca
  (`quotations.service.ts:591`, `stripImportMarker`).

- **Barrido de documentos importados (D-264):** `imported-documents-sweep.service.ts` —
  emparejamiento por producto normalizado + cantidad + importe como desempate (nunca posición,
  `pairLines`), `deliberatelyEditedProducts` por contenido (producto + precio vigente, no número de
  línea), documentos cerrados/anulados que no compiten por bobina (`dropSharedAutoCoils`), y
  corrección de pedido «entero o nada» en una sola transacción. Dry-run por defecto confirmado en
  `sweep-imported-documents-cli.ts:37-38` y `cli-branch-gate.ts` (ni siquiera el dry-run corre
  contra `production` sin `--confirm-production`); sin endpoint HTTP (solo CLI).

- **Facturación parcial (D-265):** `PartLedger`/`partKind`/`closingPartTotals` — conservación de
  dinero verificada por lectura y por los tests existentes (3-way split exacto, `FULL` solo
  alcanzable cuando nada se facturó antes). Concurrencia: `createInTx` toma
  `FOR UPDATE` sobre `sales_orders` (`invoicing.service.ts:487-489`) y `createCreditNote` sobre el
  `fiscal_documents` afectado (`:899-901`) **antes** de leer lo ya facturado/acreditado, lo que
  serializa dos facturaciones o dos notas de crédito concurrentes sobre la misma línea — el
  escenario de doble conteo pedido en el brief no es alcanzable por este camino.

- **Selección de bobina (D-254):** `sales-lines.ts` (`assertPaperCoilsInPool`, el `Set` de
  `seenCoils` que rechaza dos líneas del mismo documento sobre la misma bobina) y
  `sales-orders.service.ts:1362-1402` (`reserveLines`) — el candidato se lee sin lock en
  `coilPoolFor` (es solo para mostrar candidatas), pero la escritura real siempre pasa por
  `reserveLines`, que toma `FOR UPDATE` sobre el conjunto ordenado de ids de bobina antes de
  reservar: la carrera de "dos documentos atan la misma bobina" no es alcanzable por esta ruta.

---

## Cruce con informes previos

Leídos después de formar los hallazgos propios, según lo pedido.

- **SM-P1-1 es un hallazgo nuevo.** `docs/revision/rf-s4b-cruzada.md` (punto 5, "Roles y costos
  RF-S3c") revisó este mismo endpoint y concluyó correctamente que no devuelve costo ni margen —
  pero esa revisión ocurrió **antes** de que existiera el campo `taken.by`. Ese campo lo propuso
  la revisión siguiente, `docs/revision/rf-s4b-delta.md` ("Los dos pendientes de UI", punto 1),
  como arreglo de un problema de UX (bobinas descartadas en silencio) y **no** contempló la fuga
  de RF-S3c que introduce. Ninguna revisión posterior (`rf-s4b-repaso.md`) volvió a mirar RF-S3c
  después de que el campo se implementó. Es un caso de manual del proyecto: una regla verificada
  en un momento queda descubierta cuando un cambio posterior —motivado por una razón legítima y
  no relacionada— la vuelve a poner en juego.

- **SM-P2-1 (paperAmounts, doble redondeo) y SM-P2-2 (cobertura de PartLedger)** no aparecen en
  los informes previos; son observaciones nuevas, de severidad baja.

- **Ya conocido y ya corregido (no se repite como hallazgo):** el defecto de facturación parcial
  que dejaba S/0.0006 sin cubrir, documentado en `rf-s4b-delta.md` (fila 8, sobre
  `invoicing.service.ts:996-1011`/`:802-806` en el SHA anterior al de este diff). Verifiqué que
  D-265/`PartLedger` lo cierra y que el test correspondiente
  (`invoicing-math.spec.ts:413-418`, _"sin el resto, dos mitades dejaban 0.0006 sin cubrir (el
  defecto)"_) reproduce el número exacto del hallazgo previo como caso de regresión.

- **Ya conocido y ya corregido:** el hallazgo P0 de `rf-s4b-cruzada.md` (fila 1) sobre
  `assertPaperCoilsInPool` faltando en el confirm del importador y en la edición de cotización
  importada — el código actual de `sales-lines.ts:257` (`assertPaperCoilsInPool`) se llama una
  sola vez para todos los caminos que resuelven líneas (importador, alta directa, edición de
  cotización y de pedido), consistente con la corrección que ese informe pedía.
