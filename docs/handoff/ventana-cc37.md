# Ventana cc37 — Limpieza pendiente y líneas de la cotización

## Resumen

- Sesión del 9 de octubre de 2026, desatendida. cc35 corrió en paralelo (PR #151 y #153); no se
  tocaron su worktree, sus ramas ni sus procesos. Decisiones desde D-570 (rango propio).
- Corte 0 (limpieza) con autorización del dueño. Corte 1 (líneas) en un PR: **#154**, merge
  `6e2a9052`. Solo `apps/web`; sin API ni migraciones.
- Vuelta atrás del corte 1: promover en Vercel `ayr-steel-erp-ogsrwujwt` (`main` `30469936`) o
  revertir el merge de #154.

## Corte 0 — limpieza

1. **Borrado automático de ramas de PR:** `delete_branch_on_merge = true`, comprobado por la API y
   en la práctica: la rama `cc37-lineas-cotizacion` se borró sola al hacer merge de #154.
2. **Ramas remotas borradas** (26, todas mergeadas en `main` y sin PR abierto, con
   `gh api -X DELETE …/git/refs/heads/<rama>`): `cc31-c1`…`cc31-c6`, `cc32-c0`…`cc32-c3`,
   `cc33-c2`, `cc33-c3`, `cc33-c4`, `cc33-correcciones`, `cc34-c2`, `cc34-c3`, `cc34-c4`,
   `cc34-despunte-rentabilidad`, `cc36-cotizacion-menu`, `docs/cc31-corte6`, `docs/cierre-cc31`,
   `docs/cierre-cc32`, `docs/cierre-cc33`, `docs/cierre-cc34`, `docs/cierre-cc36`,
   `docs/d533-ventana`. No se tocaron las de cc35 (en curso).
3. **Carpeta `..\ayr-steel-erp-cc36` borrada.** Estaba vacía pero «ocupada»: la retenían dos `bash`
   de un bucle de espera de cc36 que quedó colgado (esperaba un log ya borrado) y había nacido con
   el directorio de trabajo ahí. Se cerraron y la carpeta se borró. Quedan los worktrees de cc35
   (`ayr-c35d`, `ayr-steel-erp-cc35`), que no se tocaron.
4. **Regla nueva (D-572, en AGENTS.md §3 y §4):** toda la limpieza de una pieza la hace el agente;
   la prohibición de ramas queda en el push forzado y en borrar `main`; el `deny` de
   `.claude/settings.json` no cambia.

## Corte 1 — líneas de la cotización (D-570, D-571)

- Una tarjeta por línea (tablero LineasB): borde redondeado, espacio entre líneas, número en un
  círculo y el panel dentro de la tarjeta; encabezado arriba sin caja; «Agregar línea» al final.
  `div` con roles de tabla (`table` «Líneas», `rowgroup` «Línea N», `row`, `cell`; el panel es su
  propia fila con `aria-colspan`).
- Todo arriba: medido en el DOM, producto, cantidad, precio y acciones en el mismo píxel (local, cinco
  líneas; producción, una línea).
- Unidades: «hay 1,120 und», «falta 10 und», «150 und de 415»; campos «10 und» y «/und» (solo en
  este formulario; el resto de la app sigue con «u»).
- Diferencias que quedan, con su motivo: `local-data/cc37/diferencias.md`. Capturas lado a lado:
  `local-data/cc37/lado-a-lado.png`.

## Verificación

- JSON enviado al API antes y después en seis casos de los cuatro usos (18 líneas: a medida con dos
  largos, plancha, accesorio con piezas, bobina, reventa y UPVC; pedido directo; editar sin tocar y
  con un precio; agregar ítems): **idéntico**, también tras las correcciones de revisión.
- Lint, typecheck, formato y unitarios en verde (API 2939, web 42 archivos).
- E2E local (modo dev, base `ayr_local_e2e_cc37`) de los 19 specs del formulario: 63 en verde y 4
  rojos de entorno (login y compilación lenta) que pasaron al repetirse (9/9).
- CI de #154: E2E 597 passed / 3 skipped; smoke de Neon `ci` 38 / 2; lint, unit y SonarCloud.
- Producción: smoke de solo lectura en verde en los dos dominios; pasada visual en `v2.mareliac.pe`
  con admin efímero (borrado), 0 documentos guardados.
- Revisión: autorrevisión y segundo modelo (Sonnet), sin P0 ni P1; dos P2 corregidos (fila propia
  para el panel en ARIA; anillo de foco de «Agregar línea»). Informes en `docs/revision/cc37-*.md`.

## Deuda

- «und» solo en el formulario de venta; el selector de producto, las listas y los detalles siguen con
  «u». Decidir si se unifica.

## Estado para la próxima sesión

- `main` con #154 en Vercel; API sin cambios. D-570, D-571 provisionales; D-572 regla del dueño.
- Limpieza hecha por el agente: worktree `ayr-steel-erp-cc37` y su carpeta, ramas locales, bases
  `ayr_local_cc37` y `ayr_local_e2e_cc37`, procesos. `local-data/cc37/` copiada al checkout
  principal.
