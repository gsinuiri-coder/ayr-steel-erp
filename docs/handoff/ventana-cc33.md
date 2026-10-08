# Ventana cc33 — Correcciones de API: compras, comprobantes y notas de crédito

## Resumen

- Sesión del jueves 8 de octubre de 2026, desatendida, de la madrugada hasta el mediodía de Lima. Despliegues a
  cualquier hora (D-533).
- Sin migraciones, sin SQL contra producción y sin reparar datos históricos: solo se
  diagnosticaron, con una CLI de solo lectura.
- Un PR por corte, encadenados (c4 ← c3 ← c2 ← c1) y sincronizados con `git merge`, sin push
  forzado.
- Cada corte entró con:
  - test primero y mutación (con el fix revertido, el test nuevo falla);
  - autorrevisión con un subagente nuevo y revisión de un segundo modelo (Sonnet), con P0/P1/P2
    corregidos (informes en `docs/revision/cc33-c{1,2,3,4}-*.md`);
  - la CI completa en verde, incluidos su smoke de Neon `ci` y SonarCloud.
- Después de cada corte: diagnóstico pre-deploy, `deploy:api`, smoke de producción, merge, smoke en
  los dos dominios web y logs de la revisión nueva (0 errores 5xx y 0 respuestas 409 en todos).

| Corte                                  | PR   | `main`     | API (Cloud Run)        | Vuelta atrás | Hora (Lima) |
| -------------------------------------- | ---- | ---------- | ---------------------- | ------------ | ----------- |
| 1 N1: TC 1 en soles (compra y pago)    | #138 | `c17a8fc5` | 00099-fpd (`673fff7e`) | 00098-drm    | 04:43       |
| 2 N2/N4: alcance y pedido del comprob. | #139 | `6826e826` | 00100-2hv (`4c6232ab`) | 00099-fpd    | 09:14       |
| 3 N3: NC en borrador y su afectado     | #140 | `9da3a058` | 00101-lvh (`49fad6c4`) | 00100-2hv    | 10:21       |
| 4 N5, B8, ceros y N8                   | #141 | `df0e0da7` | 00102-69b (`4e2f2dbf`) | 00101-lvh    | 11:57       |

## Qué entró

- **N1 (D-534).**
  - Una compra en PEN va siempre con TC 1. El API lo fuerza en el alta y en el pago al proveedor.
  - El schema rechaza un PEN con TC ≠ 1.
  - El web no envía TC en soles y lo limpia al cambiar de moneda, en la compra y en el pago.
  - Un registro viejo con TC ≠ 1 da 409 al recibir, recalcular o editar; hoy no hay ninguno.
- **N2 y N4 (D-535).**
  - `createInTx` lee vendedor, estado y cliente del pedido bloqueado y llama a
    `assertSellerAccess` antes de escribir.
  - Un pedido anulado o de otro cliente se rechaza en la cabecera.
  - `assertStillAvailable` revisa estado y cliente antes de la salida temprana.
- **N3 (D-536).**
  - Anular y dar de baja se rechazan con una NC en borrador, y el mensaje la nombra.
  - La baja comprueba en su transacción las NC vivas.
  - `registerManual` y `assignInTx` bloquean [nota, afectado] en una sola llamada a
    `lockDocuments` y exigen el afectado ACEPTADO y sin archivar. Par C10/C10b en
    `lock-order.db-spec.ts`.
- **N5.** Una fecha inexistente (`2026-09-31`) se rechaza en vez de pasar al 1 de octubre. Aplica
  al `isoDateSchema` de compras y a `parseCalendarDate` (también en ISO). Ventas y comprobantes no
  se tocaron.
- **B8 y ceros (D-538).**
  - El número de compra admite letras, dígitos, `-` y `/`, en mayúsculas y con un máximo de 20.
  - Los ceros a la izquierda se quitan solo si el número es todo dígitos.
  - El choque entre compras vivas se compara normalizado, con el mensaje de siempre.
  - La búsqueda encuentra la compra también con el número del papel.
- **N8 (D-537).** «Crédito sin vencimiento» en los cinco lugares; el cálculo de antigüedad no
  cambia.

## Diagnóstico histórico (solo lectura)

`pnpm inspect:cc33 --branch production --confirm-production`
(`apps/api/prisma/inspect-cc33-cli.ts`, transacción `READ ONLY`). Corrió antes de cada corte, con el
mismo resultado las cinco veces. Las salidas están en `local-data/cc33/diagnostico/`, que no se
sube al repo.

| Conjunto                                                     | Resultado                                                                                                                                           | Impacto |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Compras en soles con TC ≠ 1 y sus bobinas                    | 0 compras, 0 bobinas; 0 pagos en soles con TC ≠ 1                                                                                                   | S/ 0    |
| Comprobantes de un VENDEDOR sobre el pedido de otro vendedor | 0                                                                                                                                                   | S/ 0    |
| Comprobantes con pedido anulado o de otro cliente            | 1: FFA1-00001321 (manual, S/ 100 000), ya ANULADO; 0 vivos                                                                                          | S/ 0    |
| NC vivas o en borrador sobre facturas muertas                | 0                                                                                                                                                   | S/ 0    |
| Choques de número por ceros a la izquierda                   | 0 (9 de 26 compras vivas tienen ceros; quedan así); 0 fuera de B8                                                                                   | —       |
| Fechas distintas de lo tipeado                               | 0 en ediciones de recibidas y en el importador; 0 pagos auditados. El alta de compra no se puede detectar (la auditoría no guarda la fecha tipeada) | —       |

## Decisiones provisionales (D-534..D-538)

Están en `docs/ARQUITECTURA.md` §0.2. Las tres que piden atención del dueño:

- **D-536:** la carrera entre baja y NC tiene un riesgo aceptado. El arreglo de fondo es reclamar
  la factura antes de hablar con el PSE.
- **D-537:** el rótulo «Crédito sin vencimiento».
- **D-538:** los ceros se quitan solo en números de dígitos.

## CI: lo que se corrigió en el camino

- **#139.** El E2E N4 creaba el «otro cliente» con `createInvoiceableCustomer`. Con
  `E2E_CUSTOMER_RUC` definido (la CI lo define) devolvía el mismo cliente del pedido. Ahora usa un
  RUC propio.
- **#141.**
  - El mensaje de choque llevaba un sufijo con el número y `fase7final-m0` compara el texto exacto:
    volvió al mensaje de siempre.
  - Los números generados con el reloj podían empezar con 0, y la normalización se lo quitaba. Se
    corrigió el spec de cc33 y cinco copias locales de `uniqueDocumentNumber`.
- **Infra:** `dashboards.db-spec` falló por ±1 consulta en 4 corridas (en los PR #138, #139 y
  #140) y pasó al relanzar el job.

## P3 y notas fuera de alcance (para el dueño)

- **Fuera de la pieza:**
  - el `isoDateSchema` del tipo de cambio solo valida formato;
  - el estado de cuenta del proveedor rotula «Contado» una compra CREDITO sin días de crédito;
  - el importador no avisa en la vista previa de un duplicado dentro del mismo archivo
    (`F001-00012` y `F001-12`): el choque sale al confirmar.
- **P3 sin cambio:**
  - `assignInTx` lee el pedido sin bloquearlo (ya pasaba; D-383 cierra la ventana);
  - una réplica idempotente de otro vendedor responde 404 en `findOne` sin escribir;
  - un borrador de líneas libres queda sin poder emitirse si se cambia el cliente del pedido
    (`assertStillAvailable` lo rechaza con mensaje: se descarta);
  - `comparableDocument` (D-352) no usa la normalización nueva;
  - editar una recibida enviando por API el mismo número con ceros lo guarda sin ellos;
  - `isCalendarDate` no pone rango de años;
  - el reintento del mostrador con un borrador huérfano queda para la UAT.
- **B1, N6, N7 (cc34) y B3:** fuera de alcance.

## Estado al cierre

- `main` = cierre de docs sobre `df0e0da7`. API 00102-69b, label `git-sha=4e2f2dbf`, sin diff de
  runtime contra `main`.
- Worktree `../ayr-steel-erp-cc33`, sus ramas locales y la base `ayr_local_e2e_cc33` se borran
  después de copiar `local-data/cc33/` al checkout principal.
- Ramas remotas `cc33-correcciones`, `cc33-c2`, `cc33-c3`, `cc33-c4` y `docs/cierre-cc33`: las
  borra el dueño.
