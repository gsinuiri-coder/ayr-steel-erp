# Ventana cc41 — El borrador del accesorio vive en el servidor (D-591, reemplaza D-559)

2026-10-10, sesión atendida (el dueño presente). Ventana suspendida (D-533). Una migración
aditiva con OK del dueño por nombre (D-460); sin SQL contra producción; sin escrituras de datos.
D-586..D-590 ratificadas y UAT de cc40 dada por buena (registradas en `DECISIONES.md` y §0.2).

## Estado en producción

| Qué                 | Valor                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| PR #166 y CI        | CI completa en verde sobre `8e84d734` (E2E 35 min con `test:db`, smoke Neon `ci`, Sonar) |
| Respaldo Neon       | `respaldo-pre-cc41-20261010` (`br-old-mountain-aeno2yqp`, padre `production`)            |
| Migración           | `20261010140000_cc41_borrador_accesorio_metros` aplicada con `pnpm db:prod`              |
| API en Cloud Run    | `ayr-steel-erp-api-00113-d6r`, `git-sha=8e84d734`, 100 % del tráfico                     |
| Web en Vercel       | `main` `85519f41` (merge de #166), despliegue de producción en verde                     |
| Smoke de producción | Verde en los dos dominios, después del API y después de la web                           |
| Logs de `00113-d6r` | 39 respuestas, todas 200; ningún 5xx                                                     |

**Cortes:** (a) respaldo, `migrations-status` (1 pendiente, la de cc41), `pnpm db:prod` (solo
`migrate deploy`), `migrations-status` sin pendientes y `migrate diff` = el drift conocido sin
nada de `production_report_drafts`; (b) API y `smoke:prod`; (c) merge, Vercel y `smoke:prod`.

**Vuelta atrás:**

- API: `gcloud run services update-traffic ayr-steel-erp-api --to-revisions
ayr-steel-erp-api-00112-7jq=100` (`git-sha=c6f4d8e2`) **y** revertir el merge de #166, juntos:
  la web nueva guarda el borrador del accesorio con `meters`, que el zod del API viejo rechaza.
- La migración no se revierte: dos columnas nulas y dos CHECK que se cumplen con nulo. El API y la
  web anteriores funcionan con ella. Si hiciera falta volver al estado previo de la base, está el
  respaldo `respaldo-pre-cc41-20261010`.

## La migración

```sql
ALTER TABLE "production_report_drafts"
  ADD COLUMN "meters" DECIMAL(12,3),
  ADD COLUMN "pieces_count" INTEGER;
ALTER TABLE "production_report_drafts"
  ADD CONSTRAINT "production_report_drafts_meters_check"
    CHECK ("meters" IS NULL OR "meters" > 0),
  ADD CONSTRAINT "production_report_drafts_pieces_count_check"
    CHECK ("pieces_count" IS NULL OR ("meters" IS NOT NULL AND "pieces_count" >= 0));
```

Escrita a mano, porque Prisma no deja que un agente corra `migrate dev`. Probada en una base
descartable de Docker (`migrate deploy`, `migrate diff` y los CHECK con inserts) y en `test:db`
(`roofing-drafts-accessory.db-spec.ts`).

## Qué cambió

**API** (`roofing-drafts.ts`, `roofing-drafts.service.ts`, `batchOrders`):

- El borrador acepta filas de accesorio: bobina, `meters`, `piecesCount` informativo y kg
  opcionales, sin largos. Qué forma corresponde lo decide el producto, con los textos del parte.
- `checkDraftRows` sigue siendo la única validación. Los metros entran como un solo largo (igual
  que en `reportInTx`), y D-574 se mide contra los metros de la línea del pedido: lo registrado
  (`meters_m`) más el borrador.
- `commit`, `commit` con `close` y `previewCommit` usan el mismo `commitInTx`: todo o nada,
  «Fila N», D-573 en la misma transacción.
- Coberturas no cambia: sus pruebas pasan sin tocarlas. `RoofingReportDraftDto.piecesCount` es
  opcional en el tipo por eso.

**Web:**

- `produce-accessory.tsx` guarda lo escrito en el borrador con `useBlockDrafts`, que ahora recibe
  un adaptador por tipo de bloque (`lib/accessory-drafts.ts`).
- «Registrar producción» es el commit. «Registrar y cerrar» es el commit con `close`, con «Qué va
  a pasar».
- `use-draft-commit.tsx` reúne lo que repetían coberturas y accesorio: caché, commit, vista
  previa, errores, retro-fecha y el texto del guardado. Lo pidió Sonar por duplicación; las dos
  pantallas lo usan.
- D-575 y D-576 siguen igual. El pie dice «Todo lo escrito está guardado», como coberturas.

**La transición desde D-559** (`uploadLegacyAccessoryEdits`):

- Al abrir una orden con la clave `ayr:cc35:accesorio:<orden>` en el navegador, se lee el borrador
  recién del servidor. Si está vacío, se sube lo escrito en orden de montaje y la clave se borra.
  Si el servidor ya tiene borrador, gana el servidor y la clave se borra.
- Sin avisos, salvo error. Antes de subir, la clave queda marcada con lo que falta. Si un guardado
  se rechaza, avisa con la bobina y la vez siguiente reintenta solo las bobinas sin fila en el
  servidor.
- Un bloque ya registrado (`sent`) no se sube. Tampoco uno cuyo parte se mandó sin respuesta en
  una bobina con algo registrado (podría duplicar kardex): ese se avisa para revisarlo. Si el
  operario ya escribió en el bloque, gana lo que escribió.
- En producción no hay OP de coberturas ni de accesorio abiertas (lectura del 10/10), así que hoy
  no hay nada escrito pendiente que subir.

## Verificación

- **Unitarios:** API (los de producción, 265, más los nuevos de accesorio) y web 308. Lint,
  typecheck y Prettier en verde.
- **`test:db`:** `roofing-drafts-accessory.db-spec.ts` 9/9:
  - todo o nada, con la fila 2 que falla en la validación y con la fila 2 que falla **dentro** de
    `reportInTx` después de que la fila 1 movió kardex (`TOLERANCE_OVERRIDE_REQUIRED`);
  - cierre exacto, exceso, idempotencia de agregar y de ejecutar;
  - los dos CHECK.
- **E2E local** (servidores de desarrollo, API en 3010 porque otro proyecto del dueño ocupa el
  3000):
  - `accesorio-borrador-cc41.spec.ts` (3 bobinas, refresco, otro contexto de navegador, registrar
    y cerrar; y la transición);
  - los 9 specs de planta que registran desde la pantalla: 32/32;
  - un caso de `planta-espacio-produccion-ui` falló una vez por tiempo (el texto apareció después
    de los 10 s) y pasó solo: infraestructura.
- **CI:** suite completa en el runner, en verde.
- **Capturas antes/después:** `local-data/cc41/capturas/` con `DIFERENCIAS.md`. Solo cambia el
  texto del pie y «Qué va a pasar»: antes, «Registrar y cerrar» registraba las bobinas anteriores
  **antes** de la vista previa, y la pantalla las contaba dos veces. Ahora no registra nada hasta
  confirmar.
- **UAT en producción**, solo lectura y con admin efímero (borrado):
  - la lista de OP de coberturas trae 3 de accesorio;
  - OP-000069 (cerrada) carga;
  - su borrador responde 200 con 0 filas;
  - el lote de `/planta` responde 200 (0 OP en curso).

  Salida en `local-data/cc41/uat/`.

## Revisión

- **Autorrevisión** (subagente sin el handoff): ningún P0 ni P1. Corregidos: el reintento por
  bobina, los partes dudosos sin subir, lo escrito gana, la misma suma de metros que
  `reportInTx`.
- **Segundo modelo** (Sonnet, `docs/revision/cc41-segundo-modelo.md`): ningún P0 ni P1.
  - Corregido el P2-1: la transición lee el borrador fresco.
  - El P2-2 (filas viejas con largos en una OP de accesorio) se verificó en producción: no hay OP
    abiertas.
  - Los P3 quedan anotados en el informe.
- **Sonar:** el primer análisis falló por cobertura (78,2 %) y duplicación (4,7 %). Se resolvió
  con unitarios con mocks del servicio y con `use-draft-commit.tsx`.

## Para la siguiente sesión

- UAT del dueño en `docs/uat/cc41.md`, con la primera OP real de accesorio. Ratificar D-591.
- Neon: 8 ramas de 10. `respaldo-pre-cc41-20261010` es ahora el respaldo post-día-D más reciente;
  con él, el más viejo de los dos (`respaldo-pre-log3-20260930`) queda proponible para borrar con
  OK por nombre (`AGENTS.md` §3.3).
- Una pestaña con la web vieja (D-559) abierta después del despliegue sigue escribiendo en el
  navegador hasta que se recargue. Al recargar, si otro equipo ya escribió en el servidor, gana el
  servidor.

## Limpieza

- Rama del PR #166 borrada sola al hacer merge.
- Base local `ayr_local_e2e_cc41` y base descartable `ayr_migcheck_cc41` borradas.
- `local-data/cc41/` copiada al checkout principal.
- El worktree `../ayr-steel-erp-cc41` y su carpeta se borran al cerrar este PR de docs.
