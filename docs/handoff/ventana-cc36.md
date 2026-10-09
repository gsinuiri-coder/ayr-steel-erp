# Ventana cc36 — Formulario de cotización y menú al diseño aprobado

## Resumen

- Sesión del 9 de octubre de 2026, de madrugada en Lima, desatendida. cc35 corría en paralelo; sus
  cortes entraron a `main` antes del merge y se integraron en la rama (sin conflicto de código; uno
  de docs en §0.2, resuelto conservando las dos tandas de filas).
- Solo `apps/web`. Sin API, sin migraciones y sin cambiar cálculos, precios, pisos, reservas,
  validaciones ni lo que se envía al API.
- Un PR: **#150**, merge `7f145431` (03:34 de Lima). Vercel lo publicó; el API no cambió.
- Vuelta atrás: promover en Vercel `ayr-steel-erp-5ak8e2m0l` (`main` `2d01e075`) o revertir el
  merge de #150.

## Qué entró (las 10 del dueño y lo que se encontró de más)

1. Cabecera en una fila 5/2/2/3 bajo el título, sin la tarjeta (D-550, reemplaza a D-496).
   `formularios-grilla-d284` exige la disposición nueva sin perder orden, ancho del cliente ni
   observaciones hasta el borde. El comprobante sigue con la grilla de D-284.
2. Producto en un solo selector, con «línea de negocio · subtipo» debajo; la línea se elige con
   chips en el buscador («Todas», líneas, «Bobina completa») (D-551, reemplaza a D-497).
3. «Descripción para el cliente» en el panel de la línea, con cómo sale en el PDF (D-552).
4. Una sola línea de estado del material; el detalle en un popover (D-553).
5. Largos compactos en el panel, metros de cada fila al lado, «Agregar largo» y Enter en el último
   largo agrega otro, sin el total suelto (D-552).
6. Metros a 2 decimales en la cantidad, y precios sin ceros de más mientras no se editan (D-554).
7. «Material que compromete al confirmar» al pie (D-555).
8. «Stock disponible» arriba a la derecha (D-556).
9. Accesorio: «de bobina · N piezas (dato)»; las piezas se escriben en el panel.
10. Menú: activa en celeste con barra azul de 3 px y texto azul, con tokens de primary (D-557).

Además (lista completa en `local-data/cc36/diferencias.md`): «⋯» y papelera en vez de «Quitar»,
«Agregar línea» como última fila que abre el buscador, largos guardados «4.20» y no «4.200», kilos a
2 decimales, alineación arriba en la fila.

## Verificación

- **JSON enviado al API**: spec temporal que llena el formulario e intercepta la petición, corrido
  sobre la base de la rama y sobre el cambio, en seis casos (nueva con a medida, accesorio, plancha,
  stock y bobina; pedido directo; editar sin tocar; editar con un precio; agregar ítems): idéntico.
  Archivos en `local-data/cc36/payload-{antes,despues}.json` y el spec en `local-data/cc36/`.
- Lint, typecheck, formato y unitarios en verde (API 2939, web 39 archivos).
- E2E local (modo dev, base `ayr_local_e2e_cc36`) de los 19 specs que usan el formulario: 64 + 10 en
  verde. `alcance-vendedor-ui` falla en local dentro del helper de login (también su test del panel,
  que no toca el formulario): **infraestructura**; en la CI pasa.
- CI de #150: E2E 592 passed / 3 skipped; smoke de Neon `ci` 38 / 2; lint, unit y SonarCloud en verde.
- Producción: `pnpm smoke:prod` en verde en los dos dominios. Pasada visual en `v2.mareliac.pe`
  con admin efímero (borrado), 0 documentos guardados: cabecera sin título, sin desplegable de
  línea, buscador en «Todas» con chip de bobina, línea y estado bajo el producto, foco en la
  cantidad. El estilo del menú se midió en local (no se repitió la pasada en producción).
- Revisión: autorrevisión y segundo modelo (Sonnet), sin P0; P1 y P2 corregidos
  (`docs/revision/cc36-*.md`).
- Capturas: `local-data/cc36/lado-a-lado.png` (Main y MenuC contra la pantalla nueva),
  `antes-*.png` y `final-*.png`. De producción no hay captura: la pasada se cortó en la medida del
  menú antes de capturar, y la segunda corrida no se hizo.

## Deuda anotada

- Sin endpoint nuevo, «Todas» busca 20 en todas las líneas y descarta las que el documento no
  admite: en un pedido directo puede verse una lista corta (se avisa y se sugiere filtrar).
- El bloque de material y el estado parpadean al elegir producto (la consulta del panel cambia de
  clave), como la celda anterior.
- La regla D-065 en el buscador (pedido directo sin líneas que exigen cotización) no tiene E2E
  propio; la comparación del JSON enviado vive en un spec temporal, no en la suite.
- `aria-controls` en «⋯» y rótulos visibles distintos del nombre accesible en descripción y piezas.

## Estado para la próxima sesión

- `main` `7f145431` en Vercel; API sin cambios. D-550..D-557 provisionales, a ratificar por el dueño.
- Worktree `ayr-steel-erp-cc36` y ramas locales borrados; bases locales `ayr_local_cc36` y
  `ayr_local_e2e_cc36` borradas. `local-data/cc36/` copiada al checkout principal.
