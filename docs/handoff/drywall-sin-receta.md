# Handoff — Drywall sin receta, ancho del accesorio y notas de crédito por línea (D-344 a D-347)

**Estado al cierre: desplegado.** PR #43 mergeado (`17b5097`). API en Cloud Run
`ayr-steel-erp-api-00061-rbw` (git-sha `d33ebd2`), migración `d344` aplicada en `production`, web
en Vercel (`v2.mareliac.pe`), smoke en verde en los dos, verificación de solo lectura hecha con
admin efímero (detalle en `docs/PROGRESO.md`, «Ventana de Drywall sin receta»). Ventana corrida un
domingo a propósito, con OK del dueño comando por comando. Decisiones **D-344** a **D-347** en
`docs/ARQUITECTURA.md` §0.2. Guion UAT: `docs/uat/drywall-sin-receta.md`. Bitácora:
`docs/PROGRESO.md`, entrada «Drywall sin receta» en el registro de riesgo. Respuesta a la revisión
de M1-M4: `docs/revision/drywall-sin-receta-segundo-modelo.md`; respuesta a la revisión de M6:
`docs/revision/drywall-sin-receta-m6-segundo-modelo.md`.

**M5** (editar un accesorio sin tocar espesor/color/subtipo) y el saneamiento de Neon `ci`
entraron a la misma sesión/PR después de escrito lo de arriba (ver §7 y §8). **M6** (D-347,
borrado físico de un producto sin uso, §10) también entró completo: Paso 0 resuelto con el dueño,
implementado, revisado (dos hallazgos P1 corregidos) y con tests.

**Lo más urgente ahora que está en producción:** los 10 perfiles de drywall activos no tienen
espesor cargado, así que **hoy no se puede abrir una orden de producción para ninguno** hasta que
el dueño los complete (punto 1 de §4, lista en `docs/cliente/revision-2026-09-25.md` §2.5).

**Dos filas en `audit_log` de producción del 2026-09-27 son de la verificación de esta ventana,
no de operación real:** `catalog.create` y `catalog.product-delete`, las dos sobre el SKU
`ZTEST-D347-074522` («Producto de prueba — verificación de ventana D-347 (borrar)», línea
Reventa/`trading`). Se creó y se borró con el admin efímero de la verificación de solo lectura
(§ de arriba) para confirmar que `DELETE /catalog/:id` funciona contra un producto real de
producción; el producto ya no existe.

## 1. Qué entró

| Milestone | Decisión | Resumen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1        | D-344    | **Drywall deja de usar receta.** El espesor y el ancho del fleje son datos del SKU (`products.thickness_mm`/`width_mm`; corrige la lectura de D-118: en drywall `width_mm` es el ancho del **fleje**, no el de la pieza). El acabado no se guarda: siempre galvanizado. Fleje compatible en un solo lugar (`apps/api/src/common/drywall-strip.ts`): `STRIP` + acabado `GALVANIZADO` + espesor y ancho **exactos** (sin la tolerancia de coberturas). Piso desde el SKU (`STRIP_SKU`), con motivos `NO_THICKNESS`/`NO_WIDTH`/`NO_PIECE_WEIGHT`/`NO_COMPATIBLE_STRIPS`/`NO_MARGIN`. La OP nace sin `bom_id`, con las mismas dos guardas que tenía la receta (fabricado y `NIU`) restituidas en `ProductionService.create`/`stripOptions` y en `CatalogService.update` (no se cambia unidad/origen/espesor/ancho con una OP en curso). Se retiran `BomsService`, `/production/boms` y el diálogo de receta. Aviso (no bloqueo) de kg/pieza a más del 5 % del teórico. |
| M2        | D-345    | El reporte de un accesorio **avisa** —sin bloquear ni cambiar ningún cálculo— cuando el ancho de la bobina montada no es el del SKU.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| M3        | D-346    | Lo facturado por línea de pedido descuenta las **notas de crédito vivas** (una sola función, `invoicedByOrderItem`, usada por el guard de facturación, la vista de avance y la revalidación al emitir).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| M4        | —        | Ramas de Neon: 3 borradas con OK del dueño por nombre (`respaldo-pre-s2-20260917`, `ensayo-v4-20260915`, `dev-antes-de-rf-s3-20260917`). Quedan 18 en el primer corte; ver §9 por el criterio final y la segunda tanda de borrados.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M5        | D-343    | **Editar un accesorio sin tocar espesor, color ni subtipo ya no rebota.** El diálogo mandaba siempre los campos estructurados en el `PATCH`, aunque no se hubieran tocado; ahora solo manda lo que cambió (mismo criterio que `colorId`/`finishId` desde F8-S5). El guard del servidor ya era correcto. Detalle en §7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| M6        | D-347    | **`DELETE /catalog/:id` borra físicamente un producto que nunca se usó** (ADMINISTRADOR). «Uso» = kardex, documento comercial (compra, cotización, pedido, comprobante, despacho, historial de precio por línea), reserva, producción, o ser destino de una fusión. No cuenta el historial de precio de **lista** ni `audit_log`. `canDelete` en el DTO; confirmación en la UI nombrando el SKU. Detalle en §10.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Cambios de comportamiento que el dueño debe tener presentes:**

- **Los 10 perfiles de drywall activos en producción no tienen espesor** (medido antes de esta
  sesión): quedan «Sin espesor en el SKU: sin piso» hasta que se cargue, y **no se puede abrir una
  orden** para ellos. Tres (`PERFILH`, `PERFILU`, `R39GALV090`) además tienen ancho y peso de
  relleno (1.00 mm / 1.000 kg) que hay que corregir. **En producción no hay flejes (`STRIP`)**: la
  producción de drywall espera al primer corte.
- **Los pesos declarados no llevan el 1 % de merma de D-165.** OMEGA045 (115 mm de fleje, 3 000 mm,
  0.45 mm) tiene declarado 1.220 kg; sin merma da 1.219, con merma 1.231. El piso de esos perfiles
  queda ~1 % por debajo de lo que debería hasta que se revisen los pesos. No es un defecto de
  código: es un dato de catálogo.
- **`product_boms` no se borra.** La migración `20260927120000_d344_drywall_sin_receta` agrega
  `CHECK (NOT is_active)` y **falla a propósito** si la rama tiene una receta activa; antes de
  aplicarla en dev o demo hay que correr `pnpm retire:boms --branch <rama> --execute` (dry-run por
  defecto, auditada). En producción el dry-run debe confirmar 0 activas (medido: 1 receta, de
  cobertura, inactiva).
- **NC de solo monto también liberan cantidad.** Una nota de crédito de motivo «descuento» o
  «ajuste» copia siempre `qty`, así que también repone cantidad facturable de la línea — igual que
  D-223 ya hace con el total en dinero. No se cambió: es una decisión de negocio, no un defecto.

## 2. Secuencia de commits (PR #43)

`c3cdf91` M3 (NC por línea) · `6725308` M1 (drywall sin receta) · `4989814` M2 (aviso de ancho del
accesorio) · `29cf0f3` guardas de la receta trasladadas · `a154590` E2E y docs · `4c59543`
correcciones de la revisión de M1-M4 · `28084c5` docs de cierre de M1-M4 · `aefbb25` fix de
densidad (constante física) · `91df936` M5 (editar accesorio) · `31f34a3` Neon `ci`/AGENTS
(checkpoint) · `a9f1e97` docs de la saga de Neon · `b793ee6` M6 (D-347) · `2cddbc2` docs de M6 ·
más el commit de las correcciones de la revisión de M6 (carrera con la carga inicial, audit
completo) que cierra esta sesión.

## 3. Revisiones

- **M1-M4**: autorrevisión + segundo modelo, 0 P0, 3 P1 corregidos antes del deploy.
  `docs/revision/drywall-sin-receta-segundo-modelo.md`.
- **M6**: autorrevisión + segundo modelo, 0 P0, **2 P1 corregidos** (carrera con
  `InitialInventoryProductImportService` sobre las tablas polimórficas sin FK; `before` del audit
  insuficiente para un borrado sin reversa). `docs/revision/drywall-sin-receta-m6-segundo-modelo.md`.
- **Ningún pase es independiente** (AGENTS §2): registrado en `docs/PROGRESO.md` como **PENDIENTE
  DE REVISIÓN DEL DUEÑO**, con las piezas de riesgo (el fleje compatible, la migración `d344`, la
  CLI de retirada, las lecturas de `productBom` eliminadas de ventas, la lista de tablas de «uso»
  de M6 y el riesgo residual del lock quirúrgico contra la carrera de kardex).

## 4. Pendientes y decisiones abiertas (del dueño)

1. **Cargar el espesor de los 10 perfiles de drywall** y corregir ancho/peso de `PERFILH`,
   `PERFILU` y `R39GALV090` (lista completa en `docs/cliente/revision-2026-09-25.md` §2.5).
2. **Revisar si los pesos declarados deben llevar el 1 % de merma de D-165** (ver arriba). Si el
   dueño decide que sí, es una corrección de datos, no de código: se recalculan y se recargan desde
   el catálogo.
3. **Decidir si una NC de solo monto debería seguir liberando cantidad facturable** (hoy sí, por
   coherencia con D-223). Si el dueño quiere separarlo, es alcance nuevo.
4. **`d344` sigue sin aplicarse en `dev` y `demo`** (solo se desplegó a `production` esta ventana).
   `retire:boms` dry-run ya confirmó 0 recetas activas en las dos, así que la migración entra sin
   `--execute` cuando cada una se resetee/sincronice de la forma normal (Docker local para `dev`,
   restablecer desde `production` con OK del dueño para `demo`).
5. **Revisión con ojos frescos** de las piezas de riesgo (§3).
6. **M6, riesgo residual a decidir en otra sesión** (§10): ¿vale la pena mover el lock de la
   carrera de kardex a `InventoryService.record()` mismo (sistémico, protege cualquier escritor
   futuro) en vez de dejarlo quirúrgico en `InitialInventoryProductImportService` (el único
   llamador vulnerable de hoy)? Es un cambio de alcance mayor sobre un camino caliente
   (toda venta/despacho/reporte de producción pasa por ahí) que no se decidió en esta sesión.

## 5. Rollback

- **Migración:** aditiva (`ADD CONSTRAINT ... CHECK (NOT is_active)`), no se revierte; deja de
  aplicarse volviendo a una API anterior. Si hiciera falta deshacerla, es un
  `ALTER TABLE product_boms DROP CONSTRAINT product_boms_none_active_ck` con aprobación explícita
  del dueño (regla dura 3: nunca SQL directo sin ella).
- **API:** llevar el tráfico a la revisión anterior. Una API anterior a esta ventana sigue
  funcionando sobre el esquema nuevo (ignora el `CHECK`); lo que no podría es abrir una OP de
  drywall sin receta, porque el código viejo la exige.
- **Datos:** `retireActiveBoms` es una desactivación (`isActive: false`), append-only en el
  sentido de que queda auditada; revertirla es reactivar la receta a mano si hiciera falta (no hay
  caso de uso previsto).

## 6. Lo que la sesión siguiente tiene que saber (aprendido en esta)

- **`width_mm` de drywall cambió de significado** (de «ancho de la pieza» a «ancho del fleje»):
  cualquier código o dato que asumiera lo primero para drywall específicamente hay que revisarlo
  (ya se revisaron todos los que existían: catálogo, planta, corte, piso, ventas).
- **Cargar un dato que faltaba con una OP en curso no debe bloquearse** — solo cambiar o quitar un
  dato que una orden ya usó. Es una distinción sutil (`null → valor` vs. `valor → otro valor` o
  `valor → null`) que el primer intento de la guarda no hacía bien; quedó cubierta con tests.
- **`getByText` en Playwright hace match por substring**: un texto de ayuda que contenga la
  palabra que se busca ocultar hace fallar un `toBeHidden()`. Usar `getByLabel` para campos de
  formulario.
- **Una densidad no sale de una búsqueda en BD si otro spec puede crear el mismo tipo de fila.**
  El primer diseño de la densidad del galvanizado (elegir el acabado `GALVANIZADO` más antiguo de
  la línea) se veía bien en aislado pero se rompió en la suite completa de CI: otro spec
  (`bobinas-metro-lineal-d281.spec.ts`) crea un acabado `GALVANIZADO` de la misma línea con
  `densityFactor:'1'` para su propia cuenta, y ese es «el más antiguo» cuando ambos corren juntos.
  Filtrar por línea de negocio no alcanza porque la contaminación está en la misma línea. La
  densidad del acero es un hecho físico (7.85 t/m³), no un dato de catálogo: quedó como constante
  (`STEEL_DENSITY_FACTOR` en `@ayr/shared`), sin consulta.

## 7. M5 — editar un accesorio sin cambiar espesor, color ni subtipo

Agregado a la sesión después del cierre inicial de M1–M4. El bug real (D-343) estaba en el web,
no en el guard del servidor: `product-dialog.tsx` mandaba **siempre** los campos estructurados
(`thicknessMm`, `widthMm`, `lengthMm`, `pieceWeightKg`, `roofingKind`) en el `PATCH` de edición,
aunque no se hubieran tocado — el guard los compara contra lo guardado, así que cualquier edición
(el nombre, el precio) rebotaba con «El SKU … refleja el espesor y el color». Arreglado con el
mismo criterio que ya tenía `colorId`/`finishId` desde F8-S5: el diálogo arma el cuerpo del PATCH
comparando cada campo estructurado contra el valor guardado y solo incluye el que cambió. Test
unitario (`catalog.service.accessory.spec.ts`) y E2E (`e2e/tests/accesorio-edicion-m5.spec.ts`).

## 8. Neon `ci` — dos incidentes encadenados con la migración `d344`, resueltos

La migración `d344` agrega `CHECK (NOT is_active)` sobre `product_boms`: es retroactiva y falla si
la rama tiene una receta activa en cualquier momento, no solo al escribir código nuevo. Contra
Neon `ci` (persistente, no se resetea entre corridas) esto destapó dos problemas reales,
resueltos con OK del dueño por comando en cada paso:

1. **P3009 — migración marcada «empezada, nunca terminada».** Un job de Smoke fue cancelado a
   mitad de `ALTER TABLE` cuando un commit más nuevo lo superó (arrancó 06:30:46, la migración a
   las 06:31:09, cancelado a las 06:31:12). Confirmado con `migrations-diagnose.mjs`
   (`steps=0, finished=NO`: nada llegó a aplicarse de verdad). Resuelto con
   `node scripts/migrations-resolve.mjs --branch ci 20260927120000_d344_drywall_sin_receta`
   —confirmado antes de correrlo que el script usa `--rolled-back`, nunca `--applied`.
2. **P3018 — el CHECK genuinamente violado.** El siguiente intento de `migrate deploy` falló de
   verdad: quedaba una receta activa real, `E2E-PERFDPILZ` (drywall, 0.50 mm, 600 mm), residuo de
   una corrida anterior y no relacionada de `pnpm e2e:smoke` contra Neon `ci` (D-202: ese job sí
   escribe datos reales ahí, a diferencia de la suite completa que corre contra el Postgres del
   runner). Diagnosticado con un script de un solo uso, de solo lectura
   (`oneoff-list-active-boms`), creado, corrido y **borrado en la misma sesión** (AGENTS §3.3).
   Resuelto con OK del dueño: `NEON_BRANCHES` de `scripts/run-api-cli.mjs` ahora incluye `'ci'`
   (comentario en el archivo explica el porqué); se corrió `pnpm retire:boms --branch ci --execute`
   (desactivó la receta, auditada con `actorKind: SYSTEM`) y se volvió a resolver la migración —el
   reintento fallido dejó una segunda fila de migración fallida. `node scripts/migrations-status.mjs
--branch ci` confirma la rama al día.

**Verificaciones adicionales pedidas por el dueño, todas hechas:**

- `pnpm retire:boms --branch dev` y `--branch demo` (dry-run): **0 recetas activas en ambas**, no
  hizo falta `--execute`.
- Los helpers E2E de esta rama (`e2e/helpers/api.ts`, `production.ts`, `sales.ts`) ya no crean
  `ProductBom` (verificado por grep, sin resultados para `upsertBom|ProductBom|productBom`), así
  que un futuro `e2e:smoke` contra `ci` no debería volver a dejar una receta activa.
- **`development_mm`** (columna + 2 CHECK en `ci`) no existe en `production` ni en `demo`
  (`migrate diff` de solo lectura contra ambas, limpio, coincide exacto con el drift ya conocido
  de `docs/ENTORNOS.md`). Rastreado con `git log -S"development_mm"` a la rama descartada
  `acc-demo`, commit `6d74f3b` (migración `20260922150100_d242_accesorios_de_cobertura`). Es
  residuo inofensivo de esa rama nunca mergeada; **no se toca**, por instrucción explícita del
  dueño.
- **Pendiente, para la ventana de deploy, no ahora**: `pnpm retire:boms --branch production`
  (dry-run) debe confirmar **0 activas** justo antes de `db:prod`. Si da más de 0, parar y avisar
  antes de seguir.

## 9. Limpieza de ramas de Neon (M4, criterio final del dueño)

Se conservan 8 ramas: `production`, `dev`, `ci`, `demo`, `respaldo-pre-v4-20260915`,
`respaldo-pre-corr03b-20260926`, `respaldo-pre-corr04b-20260926` y
`respaldo-pre-correcciones-02-20260924`. Esta última es la foto previa a las reescrituras de
kardex D-278/D-285/D-288 (Correcciones 02): es un **checkpoint con fecha propia**, no la política
general de 7 días — **se borra después del 2026-10-03**, con OK del dueño por nombre en ese
momento, no antes.

Se borraron 10 ramas (ramas de ensayo, `dev-antes-de-*`, `pre-api-*`, `pre-s1-hotfix-*` y los
`respaldo-pre-*` que no estaban en la lista de arriba), verificando en cada una que el id
correspondiera al nombre antes de borrar. Ninguna rama encontrada quedó fuera de las dos
categorías (conservar / borrar), así que no hubo que parar a preguntar.

`AGENTS.md §3.3` se actualizó con una frase que documenta el patrón de «respaldo checkpoint con
fecha propia de borrado» (la política general de 7 días sigue igual; esto es la forma de anotar
una excepción explícita como la de correcciones-02).

## 10. M6 — borrado físico de un producto sin uso (D-347)

**Implementado, revisado y desplegable.** El Paso 0 (solo lectura) listó todas las tablas con FK o
referencia a `products`; quedaron dos puntos dudosos, que el dueño resolvió: **(1)**
`sales_price_changes.productId` **sí cuenta** como uso (historial de cambios de precio por línea de
un documento comercial; el 409 nombra la cotización/pedido) — distinto de
`product_list_price_changes` (historial de precio de **lista**, catálogo, no cuenta); **(2)** ser
el **destino de una fusión** (`mergedFrom`, D-253) también cuenta, por el mismo motivo que el punto
1: borrar dejaría un `mergedIntoId` apuntando a un producto que ya no existe. Regla general que
cerró el resto del Paso 0: historia de catálogo no cuenta, historia de documento
comercial/inventario/producción sí.

**Qué entró:** `DELETE /catalog/:id` (ADMINISTRADOR), bloqueando la fila (`FOR UPDATE`, mismo
patrón que `mergeProductInto`/D-253) y revalidando el uso dentro de la transacción;
`apps/api/src/catalog/product-usage.ts` (`describeProductUsage` para el 409 con el detalle,
`productsWithUsage` en tanda para `canDelete` del DTO); auditoría `catalog.product-delete` con el
mismo `before` completo que `create`/`update` (`auditView`), sin `after`; UI «Eliminar» al final
del menú de fila, en rojo, deshabilitado con motivo cuando `canDelete` es falso, con diálogo de
confirmación que nombra el SKU.

**Revisión de M6** (autorrevisión + segundo modelo, `docs/revision/drywall-sin-receta-m6-segundo-
modelo.md`): 0 P0, **2 P1 encontrados por los dos pases de forma independiente y corregidos**:

1. **Carrera real** entre `remove()` y la única herramienta que escribe kardex de un producto sin
   pasar antes por una fila con FK real hacia él (`InitialInventoryProductImportService`, D-206/
   207): las tres tablas polimórficas (`InventoryMovement`/`Reservation`/`QuotationReservation`,
   `itemType=PRODUCT`) no tienen FK hacia `products`, así que el `FOR UPDATE` de `remove()` no las
   bloqueaba — un borrado y esa carga corriendo a la vez sobre el mismo producto podían dejar un
   movimiento de kardex huérfano. Cerrado con el mismo lock a mano en esa herramienta más una
   revalidación de existencia antes de escribir (aborta todo el lote si `remove()` ganó la
   carrera). Test: `initial-inventory-product-import-race.spec.ts`.
2. **El `before` del audit era demasiado pobre** (solo sku+nombre) para un borrado sin reversa —
   corregido, usa `auditView` (línea de negocio, unidad, origen, precio, color, acabado, espesor/
   ancho/largo/peso, `isActive`).

También corregido: el `onError` del `DELETE` en el web no invalidaba la lista del catálogo (un 409
real dejaba un `canDelete` viejo en pantalla), y el docstring de `productsWithUsage` que
sobreprometía «número fijo» de consultas (en verdad: fijo por tabla, más dos consultas por cada
`BOB…` sin uso todavía, acotado al puñado de SKU de reventa del catálogo).

**Riesgo residual, documentado a propósito, no cerrado en esta sesión:** el fix de la carrera es
quirúrgico sobre el único llamador vulnerable identificado hoy. Un futuro escritor de esas tres
tablas con `itemType=PRODUCT` sin una fila FK-protegida antes en la misma transacción reabre el
mismo hueco y necesita el mismo lock a mano; una alternativa más sistémica (mover el lock a
`InventoryService.record()` mismo) se dejó fuera a propósito por ser un cambio de alcance mayor
sobre un camino caliente, que merece su propia decisión del dueño si se quiere cerrar de raíz.

**Ningún pase es independiente** (AGENTS §2): PENDIENTE DE REVISIÓN DEL DUEÑO, con las mismas
piezas de riesgo de arriba (la lista de tablas de «uso», el `FOR UPDATE`, y el riesgo residual del
lock quirúrgico).
