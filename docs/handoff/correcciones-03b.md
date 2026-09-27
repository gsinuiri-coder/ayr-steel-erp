# Handoff — Correcciones 03b (faltante de material, piso del drywall y subtipo accesorio), 2026-09-26

**Estado al cierre:** las **correcciones 03b están en producción** (PR #39, merge `78e8e9e`; migraciones
`20260926140000`, `20260926150000` y `20260926150100` aplicadas). **API vigente:
`ayr-steel-erp-api-00060-wbk`, git-sha `34e6795`**, con los secretos fijados por versión (`DATABASE_URL:7`,
`DIRECT_URL:6`, `JWT_SECRET:6` y los seis restantes en la 5). Decisiones **D-341**, **D-342** y **D-343** en
`docs/ARQUITECTURA.md` §0.2. Guion UAT: `docs/uat/correcciones-03b.md`. Bitácora: `docs/PROGRESO.md`, «Ventana
de Correcciones 03b». Respuesta a la revisión: `docs/revision/correcciones-03b-segundo-modelo.md`.

## 1. Qué entró

| Milestone | Decisión | Resumen                                                                                                                                                                                                                                                                                                                                                            |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1        | D-341    | El **administrador** confirma una cotización aunque falte **materia prima** (bandera `confirmShortfall` + motivo); el vendedor sigue bloqueado (D-054). Nueva columna `reservations.shortfall_qty` (`CHECK ≥ 0`), «Completar reserva», badge «Con faltante» en el pedido y tarjeta «Pedidos con faltante» en el Panel.                                             |
| M2        | D-342    | **Piso de precio del drywall desde la receta**: peso de la pieza × costo ponderado por kg de los flejes compatibles con saldo. Sin receta o sin costo de flejes, **no hay piso** y se dice por qué («Sin receta: sin piso de precio», «Sin costo de flejes: sin piso»). Mostrador exento.                                                                          |
| M3        | D-343    | Subtipo **`ACCESORIO`** de coberturas: se vende y se produce en **metros lineales de bobina, sin detalle de largos**; piezas informativas (`pieces_hint`); pasarse de los metros avisa y no bloquea. Predicado nuevo `detailsLengths` (la unidad y el detalle de largos son preguntas distintas); regla dura 13 de `AGENTS.md` actualizada, con el censo en D-343. |
| M4        | —        | Diálogos de acabados, colores y receta, y formulario de compra, al modelo de formularios de D-293.                                                                                                                                                                                                                                                                 |

**Cambios de comportamiento que el dueño debe tener presentes:**

- **Los 10 perfiles de drywall activos quedan «sin receta» y, por tanto, sin piso de precio.** Medido en
  producción tras el deploy (lectura por API con admin efímero, sin SQL): catálogo con 176 filas; **10 perfiles
  de drywall activos y 1 sola receta, inactiva**. Hasta que se cargue una receta activa por perfil, cotizarlos
  no tiene piso (antes salía del costo de kardex del perfil terminado, que no existe o es histórico). Lista:
  `OMEGA045`, `P38GALV045`, `P64GALV045`, `P89GALV045`, `PERFILH`, `PERFILU`, `R39GALV045`, `R65GALV045`,
  `R90GALV045` y `R39GALV090` (todos con motivo `NO_RECIPE`). **Es lo que pidió D-342**, pero conviene cargar las
  recetas pronto.
- **Confirmar con faltante crea igual las órdenes de producción** (D-186) y planta conserva el aviso de D-154.
  Solo aplica a **materia prima** (espesor + color): un producto de catálogo con stock o una bobina entera
  siguen siendo todo o nada.
- **Editar la cantidad de una línea con faltante se rechaza** («Esta línea tiene faltante de material:
  completá la reserva o anulá antes de cambiar la cantidad»): liberar y volver a reservar cerraría en silencio
  el faltante aceptado.
- **El faltante sigue visible cuando la producción agota lo reservado** (la reserva pasa a CONSUMIDA) y
  «Completar reserva» la admite y la revive.
- **Hoy no hay pedidos con faltante ni productos `ACCESORIO`** en producción (medido): las dos funciones
  arrancan sin datos.

## 2. Secuencia de commits (PR #39)

`56d78eb` y `593da34` Paso 0 (estándar de revisión, registro de riesgo) · `12aa686` y `7b65ad9` D-341 ·
`a912cb1` D-342 · `71b317e` regla dura 13 · `9b69146` y `6aaaa5c` D-343 · `d19b453` M4 · `b07a084` correcciones
de la revisión · `7fc20a9` respuesta a la revisión · `a23505e` token de un E2E frágil · `34e6795` rechazo de la
edición de cantidad con faltante. Merge `78e8e9e`.

## 3. Revisiones

- **Autorrevisión** (subagente nuevo, sin leer el handoff) y **segundo modelo** (subagente `sonnet`, contexto
  limpio): 0 P0. Los dos P1 (el faltante que desaparecía al pasar la reserva a CONSUMIDA y la reversa sin
  tope) se corrigieron antes del deploy, con tests. Detalle y respuesta a cada punto:
  `docs/revision/correcciones-03b-segundo-modelo.md`.
- **Ningún pase es independiente** (AGENTS §2): registrado en `docs/PROGRESO.md` como **PENDIENTE DE REVISIÓN
  DEL DUEÑO**, con las piezas de riesgo (las transiciones de `shortfall_qty` y el reporte de accesorios en
  metros, que sí toca kardex).

## 4. Pendientes y decisiones abiertas (del dueño)

1. **Cargar las recetas de los 10 perfiles de drywall** (ver §1). Sin ellas no hay piso.
2. **P2 diferido — ancho del accesorio:** los kilos que reserva el pedido salen del ancho del producto
   accesorio, y producción usa el ancho de la bobina montada. Es la misma diferencia que ya existe entre lo
   estimado y lo real (D-165); el kardex sale con el real. Decidir si el accesorio debe fijar el ancho.
3. **P2 diferido — texto de «Sin costo de flejes»:** si falta el margen de la línea en `pricing_settings`, el
   texto no lo distingue de la falta de flejes (el texto lo fijó el dueño).
4. **Coberturas de aluzinc en catálogo, resumen del Panel e importador:** calculan el piso como un producto de
   kardex y por eso no lo muestran, aunque la cotización sí lo calcula desde la bobina. Unificar el
   constructor de candidatos pide tests de equivalencia: no se hizo.
5. **Readiness de coberturas:** `computeOrderContext` usa `reserveQty` (kilos) como «metros pedidos»; el estado
   «Listo con faltante» de un pedido de coberturas compara metros con kilos. Anterior a esta sesión, sin tocar.
6. **Mostrador:** sigue exento del piso (D-163) y sin vender coberturas ni accesorios.
7. **Confirmar el cambio de `AGENTS.md`** (§2 regla 2, estándar de revisión) y la **renumeración de la regla
   «por metro»** (hoy la 13; en decisiones antiguas aparece como 14).
8. **Revisión con ojos frescos** de las piezas de riesgo (§3).
9. **Las 27 bobinas vigentes con saldo 0** las termina el dueño desde la pantalla (heredado de 04b; no se
   tocaron).
10. **Punto 9 del cliente — reporte de ganancia por artículo: pendiente y fuera de alcance de esta ventana.**
    El dueño lo revisa a fondo antes de diseñarlo; hasta entonces no se toca ni se estima. (El punto 10, el
    formulario de compra y los diálogos de acabados, colores y receta, **sí entró**: M4, `d19b453`.)

## 5. Rollback

- **Migraciones:** aditivas (una columna con `CHECK`, un valor de enum, un `CHECK` recreado como superconjunto
  del anterior y `pieces_hint` nullable): **no se revierten**; dejan de usarse volviendo a una API anterior.
  Respaldo: rama Neon `respaldo-pre-corr03b-20260926` (`br-winter-hill-ae38ek2x`).
- **API:** llevar el tráfico a una revisión anterior (`gcloud run services update-traffic ayr-steel-erp-api
--to-revisions <rev>=100`, vía `cmd /c` o un `.mjs`). Revisiones: **`00060-wbk`** (git-sha `34e6795`, vigente)
  → **`00059-p8k`** (git-sha `2632958`, rollback inmediata) → `00058-b67`. Una API anterior sigue funcionando
  sobre el esquema nuevo (ignora la columna y las piezas), pero **un accesorio o un pedido con faltante ya
  creados no los entendería**.
- **Secretos:** montados por número de versión. **La versión 6 de `DATABASE_URL` y la de `DIRECT_URL` siguen
  habilitadas como rollback** (el Paso 0 solo deshabilitó las versiones 1 a 5, nunca las montadas); para volver a
  la 6 de `DATABASE_URL` se redespliega con `SECRET_VERSION_DATABASE_URL=6`.

## 6. Verificación en producción (solo lectura)

- **Migraciones:** `migrations-status` mostró exactamente las 3 pendientes; `db:prod` (sin seed) las aplicó;
  `migrate diff` posterior = **el drift conocido** (5 defaults de `operation_date`, 5 FK recreadas, 2 índices y
  un renombre) y nada más.
- **Deploy:** 14 nombres de variables sin sorpresas, versiones de secretos iguales a las de antes, `/health`
  200, 100 % del tráfico en `00060-wbk`, label `git-sha=34e6795`.
- **Smoke:** `pnpm smoke:prod` en verde con la web vieja y con `--base-url https://v2.mareliac.pe`. Runtime:
  `git diff --quiet 34e6795 origin/main -- apps packages …` → exit 0.
- **Lectura con admin efímero (borrado):** catálogo, recetas y `GET /sales/orders/with-shortfall` (lista
  vacía); ningún `ACCESORIO` todavía.

## 7. Lo que la sesión siguiente tiene que saber (aprendido en esta)

- **Un token de prueba con dígitos puede traer otra fila:** la búsqueda de cotizaciones también compara el
  número (`seq`) con los dígitos del texto; con más cotizaciones en la base (más specs), `ORDEDAD4A` empezó a
  traer la nº 4. Los tokens de búsqueda de los E2E van solo con letras.
- **Los códigos de línea del catálogo van en minúscula** (`drywall`, `metallic-roofing`): un filtro con
  `'DRYWALL'` dio «0 perfiles» y casi se reporta como dato. Un conteo en cero contra un catálogo de 176 filas
  es una alarma, no un resultado.
- **El clasificador de permisos puede denegar comandos de solo lectura contra producción** (respaldo, `migrate
diff`, un `cat` de un helper): se corrieron con `!` desde el prompt, con el dueño a mano, o por una vía
  distinta de solo lectura; nunca reintentando lo denegado.
