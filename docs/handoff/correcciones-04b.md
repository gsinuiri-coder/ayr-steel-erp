# Handoff — Correcciones 04, tanda B (film de protección y pool de conexiones), 2026-09-26

**Estado al cierre:** la **tanda B está en producción** (PR #35, merge `f334f93`; migraciones
`20260926120000` y `20260926130000` aplicadas; backfill ejecutado: 43 eventos) y **D-340** (corrección del
reporte mensual, PR #37, merge `2fe7b19`) también. **API vigente: `ayr-steel-erp-api-00059-p8k`, git-sha
`2632958`**, con los secretos fijados por versión. Decisiones **D-328** (film), **D-329** (pool y secretos por
versión) y **D-340** (reporte mensual por primer movimiento) en `docs/ARQUITECTURA.md` §0.2. Guion UAT:
`docs/uat/correcciones-04b.md`. Bitácora: `docs/PROGRESO.md`, «Ventana de Correcciones 04, tanda B» y
«D-340».

## 1. Qué entró

| Milestone | Decisión | Resumen                                                                                                                                                                                                                                                                                                                         |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M6        | D-328    | Film de protección como **eje aparte** del estado: Sellada → Abierta (eventos append-only `coil_film_events`, columna `coils.film_sealed` por trigger) y **«cerrar» pasa a «terminar»** (`CLOSED` = «Terminada», solo rótulos). Abrir a mano y automático; volver a sellar con reglas; reporte mensual en dos tablas; backfill. |
| M7        | D-329    | Pool de Prisma explícito (`connection_limit=10`, `pool_timeout=20`, `connect_timeout=15`) en la versión 7 de `DATABASE_URL`; **secretos de Cloud Run fijados por número de versión** en `deploy-api.mjs`.                                                                                                                       |

**Cambios de comportamiento que el dueño debe tener presentes** (todos en D-328):

- **La compra ahora nace vigente y sellada** (antes «cerrada» por defecto, D-117). El formulario ya no ofrece
  «Estado al alta». Una línea con estado explícito (D-116) lo conserva. En producción no había compras de
  bobinas sin recibir con `CLOSED` heredado (medido: 0 borradores) y las 6 bobinas `CLOSED` están sin saldo.
- **Hijas de partido y flejes de corte nacen abiertos** y no se pueden volver a sellar.
- **La confirmación «al continuar se abre» vive en la pantalla, no en el API.** El API abre sin bandera
  (los flujos programáticos y la suite E2E no la llevan); el evento queda con su fuente y actor.
- **Volver a sellar** solo sin **ninguna** salida viva de uso (producción, merma, partido, corte) y sin OP viva
  que la monte; el error nombra el movimiento (con su fecha) o la OP. Bajar de la OP sin reportes y cancelar el
  envío a corte resellan solos **solo si la apertura fue de esa causa**; `revertSplit` no resella; **anular una
  OP no resella** (se hace a mano con «Volver a sellar»).
- **La fecha de un evento manual no puede ser anterior a la del último del film** (400); la de una operación
  automática retrofechada se ajusta a esa fecha.
- **El reporte mensual no tiene PDF ni export propios hoy**: el «igual en PDF y export» del brief quedó en el
  PDF de la lista de bobinas (columna de estado con el film). Si el cliente quiere un export del reporte, es
  trabajo nuevo.

## 2. Secuencia de commits (PR #35)

`e57c7e6` feat(bobinas) film · `bab305e` feat(web) · `755063f` test(e2e) · `4ccc644` D-328 · `8607008`
cobertura · `312fd1b` film por fecha (autorrevisión) · `9c11f5a` hallazgos del segundo modelo · `e68f38d` y
`67e50fd` ajustes de E2E · `f1c4cd9` dry-run con categorías excluyentes · `40cdf44` secretos por versión ·
`200e54c` `reduce` con valor inicial (Sonar). Merge `f334f93`.

## 3. Revisiones

- **Autorrevisión** (subagente nuevo): 0 P0; P1 de fechas retroactivas (corregido con la migración
  `20260926130000` y la regla de fechas) y de compras heredadas (descartado con datos).
- **Segundo modelo** (subagente `sonnet`, contexto limpio) sobre la tanda B y sobre el delta de la tanda A:
  `docs/revision/correcciones-04-segundo-modelo.md`, con la respuesta a cada hallazgo. 0 P0; 4 P1 resueltos
  antes del deploy (B-1 fechas, B-2 compras/`CLOSED` heredado —sin datos afectados—, B-3 resello sin filtro por
  instante, A-1 duplicar una cotización confirmada); 11 P2.
- **Ningún pase es independiente** (AGENTS §2): registrado en `docs/PROGRESO.md` como **PENDIENTE DE REVISIÓN
  INDEPENDIENTE**.
- **P2 diferidos** (ninguno bloquea): B-4 anular una OP no resella; B-6 las anuladas de 0 kg caen en
  «Selladas»; B-7 el rótulo «Estado» del reporte usa el estado de hoy; B-8 el Excel de inventario valorizado
  rotula «Vigente» sin film; A-3 el web reenvía `?sort=` sin validar; A-4 el orden por estado ordena por
  posición del enum; A-5 `RowActions` ignora `download`/`disabled` con `href`; A-6 la copia de D-322 nace
  emitida; B-9 Prisma no ve CHECK ni triggers (comprobar `\d coils` tras aplicar); además: el resello compara
  ahora todas las salidas vivas, pero la carrera entre instancias por `at` no se cerró (no aplica sin el
  filtro); el backfill no deja fila de auditoría; «Terminadas» (pestaña de `/bobinas`) filtra por saldo cero,
  no por `status = CLOSED`; una merma sobre una terminada sellada no abre el film.

## 4. Pendientes del dueño

1. **27 bobinas vigentes con saldo 0** (no se tocaron en la ventana; terminarlas desde la pantalla, **Terminar
   bobina**). Todas tienen su última salida el 2026-09-22, salvo la marcada:

   | Código                          | Saldo | Última salida  |
   | ------------------------------- | ----- | -------------- |
   | IMPO-ALZ-AZUL-5002-0.28-4014-30 | 0.000 | 2026-09-22     |
   | IMPO-ALZ-NATURAL-0.28-4010-11   | 0.000 | 2026-09-22     |
   | IMPO-ALZ-NATURAL-0.28-4020-7    | 0.000 | 2026-09-22     |
   | IMPO-ALZ-NATURAL-0.28-4040-5    | 0.000 | 2026-09-22     |
   | IMPO-ALZ-NATURAL-0.28-4045-4    | 0.000 | 2026-09-22     |
   | IMPO-ALZ-NATURAL-0.28-4060-2    | 0.000 | 2026-09-22     |
   | IMPO-ALZ-NATURAL-0.28-4170-10   | 0.000 | 2026-09-22     |
   | IMPO-ALZ-NATURAL-0.38-4155-21   | 0.000 | 2026-09-22     |
   | IMPO-ALZ-NATURAL-0.38-4200-15   | 0.000 | 2026-09-22     |
   | IMPO-ALZ-NATURAL-0.38-4205-18   | 0.000 | 2026-09-22     |
   | IMPO-ALZ-NATURAL-0.38-4210-12   | 0.000 | 2026-09-22     |
   | IMPO-ALZ-NATURAL-0.38-4220-13   | 0.000 | 2026-09-22     |
   | IMPO-ALZ-NATURAL-0.38-4385-20   | 0.000 | 2026-09-22     |
   | IMPO-ALZ-ROJO-3020-0.38-3842-36 | 0.000 | 2026-09-22     |
   | IMPO-ALZ-ROJO-3020-0.38-4112-35 | 0.000 | 2026-09-22     |
   | IMPO-ALZ-ROJO-3020-0.38-4258-41 | 0.000 | 2026-09-22     |
   | IMPO-ALZ-ROJO-3020-0.38-4430-37 | 0.000 | 2026-09-22     |
   | IMPO-ALZ-ROJO-3020-0.38-4626-33 | 0.000 | 2026-09-22     |
   | IMPO-ALZ-ROJO-3020-0.38-4666-34 | 0.000 | 2026-09-22     |
   | IMPO-ALZ-ROJO-3020-0.38-4686-39 | 0.000 | 2026-09-22     |
   | SALDO-ALZ-NATURAL-0.28-3723-4   | 0.000 | 2026-09-22     |
   | SALDO-ALZ-NATURAL-0.38-3614-10  | 0.000 | 2026-09-22     |
   | SALDO-ALZ-ROJO-3020-0.28-3711-3 | 0.000 | 2026-09-22     |
   | SALDO-ALZ-ROJO-3020-0.28-4549-2 | 0.000 | **2026-09-15** |
   | XSY-ALZ-AZUL-5002-0.38-4396-5   | 0.000 | 2026-09-22     |
   | XSY-ALZ-AZUL-5002-0.38-4464-7   | 0.000 | 2026-09-22     |
   | XSY-ALZ-ROJO-3002-0.38-4546-8   | 0.000 | 2026-09-22     |

   Mientras siguen vigentes figuran «Abiertas» con 0 kg en el reporte mensual (todas tienen su evento de
   backfill); al terminarlas pasan a «Terminada», también en «Abiertas».

2. **Versiones 1 a 5 de `DATABASE_URL`** (anteriores a la rotación del 2026-09-10) siguen **habilitadas**:
   deshabilitarlas, **con tu OK por comando y fuera de una ventana** (`gcloud secrets versions disable <n>
--secret DATABASE_URL`). La 6 es la de rollback y no se toca.
3. **Las imágenes del cliente** de la lista de correcciones 04 nunca llegaron a `local-data/corr04/`
   (`correciones 04.md` no existe): la tanda B se hizo con el texto del brief.
4. **Decidir si «Terminadas» debe filtrar por estado** (`CLOSED`) y no por saldo cero, y si el reporte mensual
   necesita export/PDF propios (ver §1).
5. **Revisión independiente** de la tanda B (y del delta de la tanda A): pendiente.

## 5. Hallazgo previo a la tanda B — corregido en D-340

Diferencia entre el saldo final de **agosto** (244 831 kg) y el inicial de **septiembre** (291 636 kg): **46
805 kg exactos = las 15 bobinas `SALDO-…` de la carga de V-4**. Su fecha de alta es de septiembre, pero D-285
fechó sus movimientos de entrada el **2026-08-01**; el reporte mensual incluía una bobina en el mes de su fecha
de alta (`c.operation_date`), así que agosto no las contaba y septiembre las traía con saldo inicial. **No
son las 28 bobinas con alta en septiembre:** las otras 13 son compras reales de septiembre y estaban bien. No
lo causó la tanda B (el filtro no se tocó).

**Corregido en D-340** (PR #37, sin tocar datos): una bobina entra al reporte del mes de su **primer
movimiento de kardex** con `operation_date` anterior al fin de ese mes (`coilInMonth`). Unitario del
invariante «saldo final de M = saldo inicial de M+1» con una bobina cuya alta es posterior a su primer
movimiento. **Las anuladas se trataban igual antes** (la consulta nunca filtró por estado: entran con sus
kilos de entonces y en 0 desde su reversa) **y no cambian.** Verificado en producción tras el redeploy
(`00059-p8k`): agosto **291 636.000 kg** = inicial de septiembre, con las 15 `SALDO-…` en «Selladas»
(46 805 kg); septiembre **igual que antes** (179 684.418 kg, S/ 487 584.47).

## 6. Rollback

- **Migraciones:** aditivas (tabla, dos enums, una columna con default y dos triggers): **no se revierten**;
  dejan de usarse volviendo a una API anterior. Respaldo: rama Neon `respaldo-pre-corr04b-20260926`
  (`br-shiny-moon-aefzj0gz`).
- **API:** llevar el tráfico a una revisión anterior (`gcloud run services update-traffic ayr-steel-erp-api
--to-revisions <rev>=100`, vía `cmd /c` o un `.mjs`). Revisiones: **`00059-p8k`** (git-sha `2632958`, vigente,
  con D-340) → **`00058-b67`** (git-sha `200e54c`, tanda B) es la de rollback inmediata → `00057-q49`
  (git-sha `40cdf44`, la primera con secretos fijados). Una API anterior al film sigue funcionando sobre el
  esquema nuevo (ignora la tabla y la columna). Volver a `00058` devuelve el reporte mensual a la regla por
  fecha de alta (con los 46 805 kg de diferencia).
- **Secretos:** `deploy-api.mjs` monta cada secreto **por número de versión**. Para cambiar uno, o volver a una
  versión anterior, se **redespliega** con `SECRET_VERSION_<NOMBRE>=<n>` (p. ej.
  `SECRET_VERSION_DATABASE_URL=6`). **Volver el tráfico a `00056` deja activa la versión 7 de `DATABASE_URL`**,
  porque `00056` monta `:latest`: es aceptable (solo agrega tres parámetros de consulta), pero para volver de
  verdad a la 6 hay que redesplegar fijándola o **deshabilitar la 7**
  (`gcloud secrets versions disable 7 --secret DATABASE_URL`).
- **Datos del backfill:** el historial de film es append-only; un evento mal deducido se corrige con un
  «Volver a sellar» manual solo si no hubo salida viva.

## 7. Lo que la sesión siguiente tiene que saber (aprendido en esta)

- **Sonar tumba por confiabilidad, no solo por cobertura:** un `reduce` sin valor inicial (S6959) bastó para
  «C Reliability Rating on New Code». El proyecto es privado: sin token no se ven los issues por API; hay que
  abrir el dashboard del PR.
- **`shared` en E2E local:** el API usa el `dist` de `@ayr/shared`; tras editar `packages/shared/src` hay que
  `pnpm --filter @ayr/shared build` antes de correr E2E en local (un mensaje renombrado seguía saliendo viejo).
- **La lista del selector de planta se refresca al abrir el modal** y puede traer un instante el film de la
  consulta anterior: los E2E no deben decidir «sellada o no» antes del clic (ver `mountFromModal`).
- **Comandos compuestos en el worktree:** el aislamiento rechaza `cd`, heredocs con `sed`/variables y varias
  órdenes encadenadas: escribir el script con `Write` y correrlo con `node`, un comando por llamada.
- **`gcloud` desde Node en Windows:** un filtro con espacios llega partido a `gcloud logging read`; usar
  filtros sin espacios (`textPayload:P2024`) o leer todo y filtrar en JS.
- **Un dry-run debe imprimir sus categorías excluyentes con la suma al lado del total**; el desglose
  redactado a mano fue lo que no cuadró.

## 8. Ramas y worktrees al cerrar

- **Remotas para que el dueño borre** (todas mergeadas o a punto de estarlo; no son protegidas):
  `feat/correcciones-04b` (PR #35), `docs/cierre-corr04b` (PR #36), `fix/reporte-bobinas-mes` (PR #37) y
  `docs/cierre-d340` (este cierre, tras su merge). `main` queda como única. Comando por rama, con OK por
  nombre: `git push origin --delete <rama>`.
- **Local:** el worktree `../ayr-steel-erp-corr04b` y sus ramas locales (`feat/correcciones-04b`,
  `docs/cierre-corr04b`, `fix/reporte-bobinas-mes`, `docs/cierre-d340`) se eliminan al terminar, después de
  copiar `local-data/` al checkout principal (`local-data/corr04b-2026-09-26/`) y verificar la copia (mismos
  archivos y tamaños). Contiene el dry-run de producción del backfill (`film-dry-run-production.txt`).
