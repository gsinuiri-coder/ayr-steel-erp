# Revisión de segundo modelo (Sonnet, contexto limpio) — cc17 / D-385

SHA revisado: `90f24c1` (rama `cc17/importador-bobina`, diff `origin/main...HEAD`, 15 archivos, 4 commits).
Alcance: A (importador: TONELADA a kg, unidad desconocida bloquea) y B (línea de bobina sin bobina libre entra «sin bobina asignada»; elección bajo lock al confirmar, ±1 %, reserva del saldo entero, importe intacto). Solo lectura; no se corrió código ni E2E.

## Resumen

| Severidad | Cantidad |
| --------- | -------- |
| P0        | 0        |
| P1        | 1        |
| P2        | 3        |
| P3        | 4        |

## P1

### P1-1. La pantalla de importación descarta el error de «unidad desconocida» y el aviso de tonelada sin producto: la fila se puede confirmar

- `apps/web/src/app/(app)/cotizaciones/importar/importar-view.tsx:1238-1246` reconstruye los `issues` de cada fila y de los `raw.issues` del API **solo conserva los de `field === 'product'`**. Los demás se recalculan en el cliente.
- El API emite los dos mensajes nuevos con `field: 'qty'` (`apps/api/src/imports/quotation-import.service.ts:283-297`): el error `La unidad «X» no se reconoce…` y el aviso `La fila está en TONELADA: … multiplica por 1000`.
- Escenario: el archivo trae `UNIDAD MEDIDA = TONELADAS` (plural), `QUINTAL` o cualquier valor fuera de las 10 claves de `QUOTATION_IMPORT_UNITS`, con un producto en kg. El preview del API la marca con error, pero `resolveRow` no la copia, `blockingRows` (línea 241) no la cuenta y el botón de importar queda habilitado. `confirm` no vuelve a mirar la unidad. Resultado: `4.192` se importa como 4,192 kg con el importe del papel (unitario 3 051 por kg en vez de 3,05). Es justo el error silencioso que el alcance A dice impedir («unidad desconocida bloquea la fila»).
- Mismo origen para fila con producto sin resolver en TONELADA: el usuario elige luego un producto en KGM en el desplegable, la cantidad no se reconvierte (el API la fijó sin convertir) y el aviso tampoco se ve.
- Los tests (`quotation-import-coil.spec.ts`, caso «unidad desconocida») prueban el preview del API, no la pantalla; por eso pasan.
- Propuesta: conservar también los `raw.issues` de `field === 'qty'` que no dependen de lo editado (por ejemplo los marcados como de unidad, con un `field` propio como `'unit'` mostrado bajo la cantidad) o, mejor, que el API rechace en `confirm` toda fila cuya unidad cruda no se reconozca (hay que mandar `rawUnit`/un flag) y que reconvierta al cambiar de producto. Añadir un test de `resolveRow` (o E2E) con unidad desconocida que verifique el bloqueo.

## P2

### P2-1. Posible deadlock: `resolvePaperCoilAssignments` toma el lock de la bobina elegida antes que el lock de unión de `createReservations`

- `apps/api/src/sales/paper-coil-assignment.ts:376-381` bloquea solo las bobinas elegidas. Después `createReservations` (`sales-orders.service.ts` ~1608-1625) pide en **una sola sentencia** la unión de bobinas nombradas más las de materia prima de las líneas a medida, justamente para evitar el cruce que su propio comentario describe.
- Escenario: cotización importada mixta (línea de bobina sin asignar + línea de cobertura a medida). Confirmación A ya tiene la bobina #5; B (otro pedido o un despacho) toma {3, 5} en orden y tiene la #3; A pide {3, 5} y espera la #3 que tiene B, y B espera la #5 que tiene A. Postgres aborta una con 40P01 y el usuario ve un 500.
- Propuesta: bloquear dentro de `createReservations` (pasarle las bobinas elegidas ya resueltas) o resolver las asignaciones **después** de armar la unión y bloquearla de una vez; o, mínimo, documentar el riesgo y reintentar ante 40P01.

### P2-2. El API acepta una línea `BOB…` sin bobina en cualquier fila que no traiga `saleCoilId`, no solo en la que no encontró bobina libre

- `quotation-import.service.ts:851-853` arma `unassignedCoilProducts` con todos los `productId` de filas sin `saleCoilId`. Quien llama al confirm sin pasar por la pantalla (o la pantalla cuando el usuario elige un producto `BOB…` a mano en una fila que no es de bobina) salta la regla D-254 R1 de `resolveSalesLines` (`sales-lines.ts:411`) aunque el pool tuviera una o varias candidatas. El comentario del código dice «solo para las filas que no traen bobina», pero eso no equivale a «filas que el preview marcó sin candidatas».
- Efecto real acotado (luego confirmar exige elegir bobina), pero la cotización nace emitida con una línea que el catálogo estaba pensado para rechazar, y la regla duplicada en dos sitios (importador y `storedUnassignedCoilProducts`, que además es por producto, no por línea: una línea nueva del mismo `BOB…` agregada al editar también entra sin bobina).
- Propuesta: pasar al servicio la marca por fila (solo `coilLine` sin candidatas) y comprobarla en el confirm contra `coilPoolFor`; en la edición, limitar por línea y no por producto.

### P2-3. Todo valor de `UNIDAD MEDIDA` fuera de 10 claves ahora es error; la no regresión real contra archivos solo cubre agosto y no corre en CI

- `quotation-import.service.ts:283-289`. Antes una unidad ajena (`SERVICIO`, `METRO CUADRADO`, `BOLSA`, `CAJA`…) era informativa. Ahora es error por fila (efectivo tras corregir P1-1).
- `quotation-import-real-files.spec.ts` verifica «no se reconoce» solo en el archivo de agosto y se salta si `local-data/` no está; en el de setiembre no se afirma nada sobre las demás filas. Si setiembre trae una unidad no mapeada, tras arreglar P1-1 el archivo quedaría bloqueado.
- Propuesta: correr el spec local con ambos archivos y listar las unidades distintas de cada uno; afirmar en el spec de setiembre que ninguna otra fila lleva ese error; ampliar el mapa si hace falta.

## P3

### P3-1. Cotas de tolerancia mostradas con redondeo que puede diferir de la comparación

`packages/shared/src/schemas/sales.ts:819-833`: `ok` compara contra `min`/`max` exactos (cinco decimales) y `minKg`/`maxKg` se muestran redondeados a 3. Ejemplo `paper = 4192.123`: `min = 4150.20177`, se muestra `4150.202`; con un saldo de `4150.201` el mensaje dice «entre 4150.202…» y es coherente, pero con `paper = 100.070` el mínimo real `99.0693` se muestra `99.069` y un saldo `99.069` se rechaza aunque el rango mostrado lo incluye. Proponer redondear `min` hacia arriba y `max` hacia abajo (o comparar contra los valores ya redondeados) y cubrirlo en el test de borde.

### P3-2. El diálogo deja elegir la misma bobina para dos líneas

`confirm-quotation-dialog.tsx` (`CoilChoice`): no excluye la bobina ya elegida en otra línea; el API responde 400 «La misma bobina no puede atender dos líneas» recién al confirmar. Marcar o deshabilitar la repetida, como hace `markSharedCoils` en el importador.

### P3-3. Candidatas del importador exigen saldo mayor o igual a la cantidad; el confirm acepta hasta 1 % menos

`coil-sale-product.ts:540` (`balance.gte(need)`) vs `paperCoilWeightCheck`. Con la bobina A de 4190 kg y el papel de 4192, el pool no la ofrece; si existe una B de 6000 kg libre, el preview la asigna sola (única candidata) y la línea vende B entera, aunque A era la que correspondía. Comportamiento de D-254 anterior a este diff, pero ahora incoherente con la tolerancia de D-385. Dejar registrado o alinear (usar la misma tolerancia al armar candidatas).

### P3-4. Línea sin bobina en la lista de «sin stock»: reserva temporal manual no considerada

Una cotización importada con línea `BOB…` sin bobina ofrece en el detalle el botón de reserva temporal, que calcularía contra el producto (saldo 0) y rebotará con el mensaje genérico de faltante. No es una regresión (esas cotizaciones antes no existían) pero conviene ocultar o explicar el caso.

## Lo verificado sin hallazgo

- Conversión: `Decimal` en `importQtyInProductUnit`, producto en `TNE` conserva cantidad, unitario por kg derivado del importe exacto, aviso de unidad suprimido cuando hay conversión; archivos previos en KGM sin cambio (`unitConversion: null`).
- Despacho: `proratedQty` sobre `reserveQty` mantiene coherente cantidad del papel contra saldo reservado de la bobina entera.
- Confirmación: la bobina se valida bajo lock tras el lock de la cotización, pertenencia al pool, ±1 % con `Decimal`, `reserveQty = saldo`, el importe y el IGV de la línea no se recalculan, la cotización queda con la bobina vendida, auditoría con ambos pesos, bloqueo con ambos pesos en preview y confirm (mismo `paperCoilWeightCheck`/`paperCoilBlocker`).
- Cotización manual: `unassignedPaperCoilLines` devuelve `[]` si no es importada, y `sales-lines` sigue rechazando `BOB…` sin la opción; la lista de sin stock solo cambia la etiqueta.
- No hay trigger ni CHECK que impida el `quotationItem.update` posterior a `CONFIRMED`.

## Veredicto

**No pasa a deploy todavía.** Corregir P1-1 (la pantalla deja confirmar una fila con unidad desconocida y deja mal una fila en toneladas con producto elegido a mano) antes del deploy. P2-1 a P2-3 recomendados antes del deploy o registrados como deuda con decisión del dueño; P3 a criterio. Sin P0. Esta revisión es de un modelo y no sustituye la revisión del dueño al cierre.
