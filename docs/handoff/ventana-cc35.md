# Ventana cc35 — Producir una OP con el modelo M y scroll único en las listas

## Resumen

- Sesión del jueves 8 al viernes 9 de octubre de 2026 (Lima), desatendida. Despliegues a cualquier
  hora (D-533). La sesión se reinició una vez a mitad del corte 2 y se retomó sin pérdida.
- Sin migraciones y sin SQL contra producción. El API cambió en dos cortes, de forma compatible
  (validación del ajuste del plan; un campo aditivo en la vista previa del cierre).
- Un PR por corte. Cada corte entró con:
  - test primero (rojo contra el código anterior) y después el cambio;
  - autorrevisión con un subagente nuevo y revisión de un segundo modelo (Sonnet), con P0/P1/P2
    corregidos o registrados (informes con su respuesta en `docs/revision/cc35-c{1,2,3,4}-*.md`);
  - la CI completa en verde, incluidos su smoke de Neon `ci` y SonarCloud;
  - capturas a 1366×768 lado a lado con su tablero y una lista de diferencias (fuera del repo).
- Después de cada corte con API: deploy, smoke contra el API nuevo, merge, smoke en los dos dominios
  web y logs de la revisión nueva (0 errores 5xx y 0 respuestas 409).
- D-539..D-544 quedaron ratificadas. D-545..D-549, D-558 y D-559 son provisionales. cc36 corrió en
  paralelo y usó D-550..D-557.

| Corte                              | PR   | `main`     | API (Cloud Run)        | Vuelta atrás                   |
| ---------------------------------- | ---- | ---------- | ---------------------- | ------------------------------ |
| 1 Scroll único en las listas       | #148 | `b947aecb` | sin cambio (00106-xp4) | revertir el merge              |
| 2 Ajustar el plan y Montar bobinas | #149 | `2d01e075` | 00107-sjv (`02f161bb`) | tráfico a 00106-xp4 y revertir |
| 3 Modelo M (a medida y plancha)    | #151 | `8dedff4a` | 00108-d8t (`609cd174`) | tráfico a 00107-sjv y revertir |
| 4 Modelo M del accesorio           | #153 | `30469936` | sin cambio (00108-d8t) | revertir el merge              |

## Qué entró

- **Listas (D-547).** `Table list` toma el alto que deja la ventana: una sola barra, cabecera, pie y
  paginación fijos. Pasaron al modo lista bobinas, flejes, corte, kardex, catálogo, líneas,
  acabados, usuarios, reservas temporales y auditoría. Con dos listas en una pantalla, crecen con la
  página. Una tabla ancha dentro de un detalle repite su barra horizontal fija al pie de la ventana.
- **Ajustar el plan (D-545, D-546).** Diálogo con una fila por largo, franja verde o roja y «Qué va a
  pasar». A medida, el plan nuevo suma los mismos metros del vigente, ni más ni menos, también en el
  API; ningún largo baja de las planchas reportadas. Plancha de catálogo: la cantidad sigue libre.
  **Consecuencia para el dueño:** una cobertura a medida ya no puede producir más metros que su
  plan.
- **Montar bobinas.** Búsqueda, casillas para varias, kg inicial, kg consumido, saldo y rinde,
  agrupado por acabado, aviso de selladas; el paso de abrir el film y el de reabrir no cambian.
- **Modelo M (D-548, D-549, D-558).** Un bloque por bobina en orden de montaje; el último se llena
  solo con lo que falta; guardado automático en el borrador de la orden; las terminadas se pliegan;
  «Registrar producción» (commit, todo o nada, el error «Fila N» en su bloque) y «Registrar y
  cerrar» con «Qué va a pasar» (despunte por bobina desde la vista previa del API, bobinas que se
  terminan, con cuánto vuelven, aviso de despunte alto). Los kg de cada bloque viajan como
  `consumedKg` de su fila y el cierre saca el despunte de cada bobina (cc34): el campo único de kg
  del cierre salió de la pantalla.
- **Accesorio (D-559).** Sin plan de corte: banda «Avance» y sin «Ajustar el plan». Metros de bobina
  por bloque, piezas opcionales. **Sin migración, lo escrito vive en el navegador** y se registra un
  parte por bloque (no es todo o nada entre bloques). Si el dueño lo quiere en el borrador del
  servidor, hace falta una migración.

## Comprobaciones previas (pedidas por el brief)

1. El cierre de cc34 ya calcula el despunte por bobina con el `consumedKg` de cada parte; M no
   necesita el total al cerrar. Solo faltaba el despunte por bobina en la vista previa (D-549).
2. «Ajustar el plan» no comparaba contra los metros del plan (solo un piso con borrador): exigir
   igualdad cambió lo que el API aceptaba (D-545).
3. Planchas de catálogo: mismo borrador con un solo largo. Accesorio: sin borrador, partes directos
   con metros (D-559).

## Decisiones provisionales que piden atención del dueño

- **D-545:** mismos metros solo a medida; producir de más queda solo en planchas de catálogo.
- **D-548:** el último bloque se vuelve a llenar cuando cambia otro bloque; «Registrar» manda
  también el último lleno solo (lo que se ve es lo que se registra).
- **D-558:** compromiso y avance del pedido en el subtítulo; las pestañas quedan como hoy; ya no hay
  «Cerrar sin reportar más» en coberturas (se cierra con «Registrar y cerrar»).
- **D-559:** el accesorio en el navegador y sin todo o nada entre bloques.

## P3 y notas

- El aviso de despunte alto de cc29 (D-469) está en «Qué va a pasar» del modelo M.
- La casilla de tolerancia del accesorio no se guarda en el navegador (un refresco la pide de nuevo).
- `key` por índice en las filas de un bloque; lo escrito en los últimos 0,7 s antes de recargar se
  pierde.
- Infraestructura local (no producto): con `next dev`, un login que pasa por
  `/cambiar-contrasena` y la ruta `/cotizaciones/:id/editar` tardan más de lo que esperan dos E2E.
  En la CI (build de producción) pasan.
- `test:db` local: 3 de 4 suites en verde. `lock-order.db-spec` falló por tiempos (transacciones
  de más de 5 s) con la máquina cargada por otras dos sesiones: 2 casos en la corrida completa (72 min)
  y otro distinto al repetirlo solo (32 de 33). Los caminos que fallaron (revertir un reporte, anular
  un pedido o una compra, cerrar) no cambiaron en esta pieza. Conviene repetirlo con la máquina libre.
- Tableros: las diferencias por tablero y por qué están en `local-data/cc35/capturas/c*/diferencias.md`
  (fuera del repo).

## Estado al cierre

- `main` = cierre de docs sobre `30469936`. API 00108-d8t, label `git-sha=609cd174`, sin diff de
  runtime del API contra `main` (los cortes 3→4 solo tocaron `apps/web` y `e2e`).
- Logs de 00108-d8t en las 3 h posteriores al último merge: 197 respuestas, 184×200 y 13×401
  (sesiones vencidas), 0 errores 5xx y 0 respuestas 409.
- Worktrees `../ayr-steel-erp-cc35` y `../ayr-c35d`, sus ramas locales y la base
  `ayr_local_e2e_cc35` se borran al cerrar, después de dejar `local-data/cc35/` en el checkout
  principal.
- Ramas remotas `cc35-producir`, `cc35-c2`, `cc35-c3`, `cc35-c4` y `docs/cierre-cc35`: las
  borra el dueño.
