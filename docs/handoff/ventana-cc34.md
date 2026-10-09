# Ventana cc34 — Despunte por bobina, rentabilidad, baja en trámite y pendientes de cc33

## Resumen

- Sesión del jueves 8 de octubre de 2026, desatendida, de la tarde a la noche de Lima. Despliegues a
  cualquier hora (D-533).
- Sin migraciones, sin SQL contra producción y sin reparar datos históricos. El despunte viejo solo
  se diagnosticó, con una CLI de solo lectura.
- Un PR por corte, encadenados (c4 ← c3 ← c2 ← c1) y sincronizados con `git merge`, sin push
  forzado.
- Cada corte entró con:
  - test primero y mutación (con el fix revertido, el test nuevo falla);
  - autorrevisión con un subagente nuevo y revisión de un segundo modelo (Sonnet), con P0/P1/P2
    corregidos o registrados como decisión (informes en `docs/revision/cc34-c{1,2,3,4}-*.md`);
  - la CI completa en verde, incluidos su smoke de Neon `ci` y SonarCloud.
- Después de cada corte: diagnóstico pre-deploy, `deploy:api`, smoke de producción, merge, smoke en
  los dos dominios web y logs de la revisión nueva (0 errores 5xx y 0 respuestas 409 en todos).
- D-534..D-538 (cc33) quedaron ratificadas por el dueño. D-539..D-543 son provisionales; D-544 es
  la regla del dueño de no pedir `/add-dir`.

| Corte                                       | PR   | `main`     | API (Cloud Run)        | Vuelta atrás | Hora (Lima) |
| ------------------------------------------- | ---- | ---------- | ---------------------- | ------------ | ----------- |
| 1 B1: despunte por bobina                   | #143 | `68962de9` | 00103-8q8 (`7018a5af`) | 00102-69b    | 15:36       |
| 2 N6/N7: rentabilidad                       | #144 | `858d2879` | 00104-xm4 (`f683bb21`) | 00103-8q8    | 16:52       |
| 3 baja en trámite (fondo de D-536)          | #145 | `3092e833` | 00105-xwf (`f5007672`) | 00104-xm4    | 18:55       |
| 4 pendientes de cc33 y `dashboards.db-spec` | #146 | `7b26c262` | 00106-xp4 (`1ca756e5`) | 00105-xwf    | 20:09       |

## Qué entró

- **B1, despunte por bobina (D-539).**
  - `allocateRoofingScrap` (`apps/api/src/production/roofing-scrap.ts`, función pura, 17 unitarios)
    reemplaza la cuenta global en `closeInTx`.
  - Cada bobina carga el exceso de sus propios partes, `max(Σ declarado − Σ salida, 0)`, sin
    compensar entre bobinas. La bobina de un parte sale de su COIL OUT.
  - Un total escrito con varias bobinas vivas se reparte en proporción a lo reportado de cada una,
    topado por su saldo; lo que sobra va a la siguiente con saldo en orden de montaje.
  - Con una sola bobina, igual que antes. Reabrir devuelve cada despunte a su bobina.
  - E2E «cc34 B1» en `multi-montar-f8s3.spec.ts` (rojo contra el código viejo).
- **N6 y N7, rentabilidad del comprobante (D-540, D-541).**
  - Las NC de anulación o devolución netean cantidad de lo facturado de su línea; las de descuento y
    otros ajustes, solo venta. Caso del brief: 500 / 400 / 100.
  - Solo se costea lo despachado con salida de kardex; el resto queda sin costo y la línea pasa a
    PARTIAL con su nota. La pestaña de producto de Ventas por material se alineó.
- **Baja en trámite (D-542).**
  - `voidDocument` deja la factura `VOID_PENDING` en su propia transacción antes de llamar al PSE (sin
    migración: `VOID_PENDING` + `voidRequestedAt`).
  - Mientras dure, crear una NC da 400 y registrarla o emitirla, 409.
  - Con ERROR o REJECTED se quita la marca de esa llamada.
  - Auditoría `void-requested` / `void` / `void-released` / `void-conflict`. Una marca sin resultado
    y con menos de 5 min «se está comunicando»; con 5 min o más se reintenta.
  - El aviso «Consultar al PSE» sigue.
- **Pendientes de cc33 (D-543).**
  - El tipo de cambio rechaza un día inexistente (`2026-09-31`).
  - El estado de cuenta del proveedor dice «Crédito sin vencimiento» en vez de «Contado».
  - La vista previa del importador avisa en los dos comprobantes cuando el mismo papel aparece con y
    sin ceros a la izquierda.
- **`dashboards.db-spec` (pedido del dueño).** Ver «CI» más abajo.

## Diagnóstico del despunte (solo lectura)

`pnpm inspect:cc34 --branch production --confirm-production`
(`apps/api/prisma/inspect-cc34-cli.ts`, transacción `READ ONLY`). Corrió antes de cada corte, con el
mismo resultado. Salidas en `local-data/cc34/diagnostico/`, que no se sube al repo.

- 71 OP de coberturas cerradas, 17 con despunte, 29 con dos o más bobinas.
- **2 OP cambian de bobina con la regla nueva** (no se reparan):

| OP  | Cerrada | Despunte   | Hoy en         | Con la regla nueva en | Soles     |
| --- | ------- | ---------- | -------------- | --------------------- | --------- |
| 62  | 06/10   | 224.966 kg | JRSTEE…4315-7  | JRSTEE…4293-6         | S/ 613.12 |
| 64  | 06/10   | 196.472 kg | JRSTEE…3850-11 | JRSTEE…3815-10        | S/ 518.75 |

- En total, 421.438 kg y S/ 1131.87 cambian de bobina. El neto es S/ 0, porque cada par tiene el
  mismo costo unitario: el kg total y el costo de la OP no cambian.
- 12 OP son ambiguas: con un total escrito igual a lo declarado se repartiría en proporción. En 10 de
  ellas la lectura por parte reproduce el SCRAP real.

## Decisiones provisionales (D-539..D-543)

Están en `docs/ARQUITECTURA.md` §0.2. Las que piden atención del dueño:

- **D-539:** un parte que sacó de dos bobinas reparte su exceso en proporción a lo que sacó de cada
  una; lo que una bobina no puede cargar sale de otras vivas en orden de montaje.
- **D-540:** la lista de motivos de NC que quitan unidades (01, 02, 06, 07) y los que solo restan
  venta (03, 04, 05, 13). Una devolución sin reversa del despacho conserva el costo de lo devuelto.
- **D-542:**
  - los cobros siguen permitidos sobre una factura `VOID_PENDING` (rechazarlos sería una regla
    nueva);
  - un ERROR por timeout del PSE libera la marca aunque la baja pudo llegar (regla del brief; el
    mensaje lo avisa).
- **D-543:** el duplicado dentro del archivo es un aviso, no un error.

## CI: lo que se corrigió en el camino

- **#145.**
  - La 1.ª corrida falló por formato (Prettier después de `eslint --fix`).
  - La 2.ª y la 3.ª fallaron en `dashboards.db-spec` (24/25 y 23/25): se trajo la consulta
    marcadora del corte 4.
  - La 4.ª falló en dos E2E del importador: números del reloj que empezaban con 0 y D-538 les quitaba
    el cero. Se les antepuso un `9` en cinco specs.
- **`dashboards.db-spec`.** Falló en seis corridas de CI, siempre de menos y solo en CI.
  - En local no se reprodujo: ni con los datos de la CI, ni con 16 Paneles en paralelo, ni con
    eventos tardíos (0 de 30).
  - Causa más probable: el evento `query` de Prisma no tiene orden respecto del resultado. El Panel
    se mide último y perdía los eventos de sus últimas consultas.
  - Arreglo, sin relajar el test: cada medición termina con `SELECT 1 AS measure_fence_n` y la lista
    se corta cuando llega su evento. La igualdad exacta sigue y además se compara qué sentencias
    salieron (`statementDiff`).
  - Con la marcadora, la CI pasó tres veces seguidas (dos en el #145 y una en el #146). Si vuelve a
    fallar, el mensaje dice qué consulta sobra o falta.
- **Infra local (no producto):** `reportes-por-linea-cc24` redirige la URL con `next dev`, y
  `comprobante-manual` y `fase5b-bordes` necesitan el PSE encendido.

## P3 y notas fuera de alcance (para el dueño)

- **Fuera de la pieza:**
  - la pantalla de planta todavía estima el despunte con la cuenta global (va con el rediseño de
    «Producir una OP»);
  - el aviso del detalle del comprobante dice «La baja está comunicada…» también mientras la marca
    es previa a la llamada al PSE;
  - el estado de cuenta del proveedor calcula la antigüedad con el día UTC: entre las 19:00 y las
    24:00 de Lima va un día adelantada;
  - las líneas del motor (Coberturas Aluzinc) no aplican N6; la especificación habla solo de la
    línea de pedido;
  - `costPerUnit` del neto sigue con su cálculo previo (no lo tocó N6).
- **P3 sin cambio:**
  - en el mostrador, `VOID_PENDING` cuenta como «ya deshecho»: con una baja manual en vuelo, una
    anulación de mostrador salta su paso 2 (ventana muy angosta);
  - crear una NC sobre `VOID_PENDING` da 400 y registrarla o emitirla, 409;
  - el mensaje de tope por lo montado con varias bobinas es el de siempre;
  - `reportsOutKg` queda solo para su spec y `mounted-kg.spec.ts`;
  - el E2E no cubre el total escrito con dos bobinas: lo cubren los unitarios.
- **B3:** intencional (D-146/D-089/D-246). **Fuera de alcance:** reparar las OP 62 y 64 y la
  entrada de consumo por bobina en la pantalla de planta.

## Estado al cierre

- `main` = cierre de docs sobre `7b26c262`. API 00106-xp4, label `git-sha=1ca756e5`, sin diff de
  runtime contra `main`.
- Worktree `../ayr-steel-erp-cc34`, sus ramas locales y la base `ayr_local_e2e_cc34` se borran
  después de copiar `local-data/cc34/` al checkout principal.
- Ramas remotas `cc34-despunte-rentabilidad`, `cc34-c2`, `cc34-c3`, `cc34-c4` y `docs/cierre-cc34`:
  las borra el dueño.
