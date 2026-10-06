# Ventana cc27 — UX de la inspección de cc26

## Resumen

- **PR #113**, rama `cc27-ux`, abierta desde `main` `aa36d935`.
- **Sin migración.** Toca la API (una ruta de lectura nueva, cuatro vistas previas que no escriben
  y un campo opcional en la venta de mostrador) y la web.
- **Sesión desatendida:** rigen D-445 y el brief de cc27 (ambigüedad → D-nnn provisional, UAT
  aprobado por defecto, directo a producción, ventana 20:00–07:00 de Lima).
- **Hitos:** M1, M2, M3 y M4 hechos; nada sacrificado.
- **Estado final:** (se completa en la ventana).

## Hitos

- **M1 — precio del mostrador (UX26-01, D-452)** (`51603f8c`, `39adf321`).
  - **Diagnóstico: solo presentación.** El importe cobrado y el del comprobante ya coincidían: la
    ficha mostraba el valor sin IGV (S/ 50.00) y se cobraban S/ 59.00. No es P0 y **no hay
    documentos afectados**; no hubo que leer producción.
  - La ficha muestra el precio con IGV rotulado; el carrito pide «Precio unitario (con IGV)»
    (sembrado al céntimo) y muestra «Importe (con IGV)»; el pie, «Subtotal (sin IGV)», «IGV (18 %)»
    y «Total». Lo guardado sigue sin IGV: el precio de lista viaja por su valor (D-377), uno
    tipeado como `unitPriceWithIgvPen` (D-255), que la venta de mostrador ahora acepta.
  - Función de presentación `apps/web/src/lib/pos-pricing.ts` con su unitario; E2E
    `mostrador-precio-cc27` (mismo precio en catálogo y mostrador; total del mostrador = total del
    comprobante, con precio de lista y con precio tipeado).
  - **Barrido de pantallas con precio de venta:**

| Pantalla                                          | Qué muestra                   | Con o sin IGV                      | Rótulo                                                                                   | Cambio en cc27                   |
| ------------------------------------------------- | ----------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------- |
| Catálogo (`/catalogo`)                            | precio de lista               | con IGV                            | «Precio de lista (con IGV)»                                                              | —                                |
| Catálogo, historial de precios                    | antes / después               | con IGV                            | «Antes (con IGV)», «Después (con IGV)»                                                   | rotulado                         |
| Catálogo, alta/edición de producto                | valor de lista                | sin IGV                            | «Valor de lista (S/, sin IGV)»                                                           | antes «Precio de lista…» (D-162) |
| Catálogo, aviso del piso; Panel «lista bajo piso» | mínimo                        | con IGV                            | «mínimo … con IGV»                                                                       | rotulado                         |
| Cotización y pedido (formulario)                  | precio unitario               | con IGV                            | «Precio (con IGV)»                                                                       | —                                |
| Cotización y pedido (formulario)                  | valor por plancha             | sin IGV                            | «valor … por plancha (sin IGV)»                                                          | rotulado                         |
| Cotización y pedido (formulario)                  | por metro (convertir)         | con IGV                            | «… por metro con IGV»                                                                    | rotulado                         |
| Cotización y pedido (formulario)                  | mínimo                        | con IGV                            | «Mínimo con IGV»                                                                         | rotulado                         |
| Cotización y pedido (formulario)                  | totales                       | sin / con IGV                      | «Valor de venta», «IGV (18%)», «Precio de venta»; barra fija «Precio de venta (con IGV)» | barra nueva (D-454)              |
| Cotización (detalle)                              | subtotal / total              | sin / con IGV                      | «Subtotal (sin IGV)», «Total (con IGV)»                                                  | rotulado                         |
| Pedido (detalle)                                  | subtotal / IGV / total        | sin / — / con IGV                  | «Subtotal (sin IGV)», «IGV», «Total (con IGV)»                                           | rotulado                         |
| Pedido, cambiar precio                            | vista previa                  | sin / con IGV                      | «valor de venta … total con IGV … valor unitario»                                        | rotulado                         |
| Mostrador (`/pos`)                                | ficha, unitario, importe, pie | con IGV (pie: sin IGV, IGV, total) | ver M1                                                                                   | **corregido (UX26-01)**          |
| Comprobante (detalle)                             | total y pie                   | sin / con IGV                      | «Subtotal (sin IGV)», «Total (con IGV)»                                                  | rotulado                         |
| Comprobante nuevo                                 | valor unitario, totales       | sin IGV / con IGV                  | «Valor unitario (sin IGV)», «Precio de venta»                                            | —                                |

    Quedan sin tocar (rotulan bien o no se contradicen): las columnas «Valor de venta», «Valor
    unitario» y «Valor cotizado» (D-162: «valor» es sin IGV), «Gravada» del diálogo de reactivar y
    las listas con «Total».

- **M2 — confirmar antes de cerrar (UX26-03, D-453)** (`75929297`).
  - **Acciones con el patrón:** «Ejecutar y cerrar» (borrador de coberturas), «Reportar y cerrar»
    (accesorio), «Cerrar … sin reportar más» (coberturas y accesorio) y el cierre de drywall. No
    confirman: «Ejecutar borrador» (sin cierre), agregar o editar filas del borrador, montar y
    bajar bobinas.
  - El resumen sale de `POST …/preview`, que corre la misma acción y la deshace
    (`apps/api/src/production/close-preview.ts`). La API y el kardex de las acciones reales no
    cambian; la idempotencia queda igual.
  - De paso: «Reportar y cerrar» de un accesorio, la primera vez, reportaba sin cerrar (leía el
    modo del render anterior); ahora va por `ref`.
  - E2E `planta-confirmar-cierre-cc27`: «Volver» deja kardex, bobina, borrador y orden intactos;
    las cifras del diálogo son las que registra el kardex; un doble clic ejecuta una sola vez. Los
    E2E de planta existentes confirman el diálogo con `confirmPlantClose`.
- **M3 — resto del informe** (`dbe0e7d0`, `39adf321`).
  - a. Despacho nuevo y «Registrar cobro» con nombres accesibles (UX26-02); los specs los buscan
    por `getByLabel`/`getByRole`.
  - b. 1366: menú que recuerda su colapso, modal de bobinas que entra entero, tablas que muestran
    que esconden columnas (D-456).
  - c. `StickyActionBar` en cotización, pedido, agregar ítems, comprobante nuevo, compra y despacho
    (D-454).
  - d. `useUnsavedChanges` en cotización, pedido, compra, despacho y producto (D-455).
  - e. E2E `ux-1366-cc27`: sin scroll horizontal y con la acción principal a la vista en los cuatro
    formularios largos, y el aviso de cambios sin guardar (enlace, atrás, recargar; sin cambios no
    pregunta; escribir y borrar no deja «atrás» trabado).
- **M4 — Panel del vendedor (D-457)** (`39a34a2b`). `GET /reports/seller-dashboard`, solo VENDEDOR;
  E2E `panel-vendedor-cc27` con un usuario VENDEDOR (solo lo suyo; admin y supervisor, 403) y el
  test del menú por rol actualizado.

## Decisiones (todas provisionales, pendientes del dueño)

- **D-452:** el mostrador con IGV; el precio tipeado viaja con IGV; barrido de rótulos.
- **D-453:** confirmación con resumen del API por transacción que se deshace, en las cuatro acciones
  de cierre.
- **D-454:** barra de acciones fija en los formularios largos.
- **D-455:** aviso de cambios sin guardar; qué cuenta como cambio en cada formulario.
- **D-456:** 1366: el menú recuerda, **no** colapsa por defecto; modal de bobinas; señal de columnas
  escondidas; sin reordenar columnas.
- **D-457:** Panel del vendedor: ventas sin IGV de sus comprobantes vivos (NC restan) y conversión
  de sus cotizaciones del mes a pedido.

## Revisiones

- **Autorrevisión** (`docs/revision/cc27-autorrevision.md`; subagente nuevo, lista de riesgos, no
  aprobación): 0 P0, 1 P1, 3 P2, 10 P3.
- **Segundo modelo** (Sonnet, contexto limpio; `docs/revision/cc27-segundo-modelo.md`): 0 P0, 0 P1,
  3 P2, 5 P3.
- **Corregidos (`39adf321`):** A-1/SM-2 (P1: la centinela del historial dejaba «atrás» trabado), A-3
  (leer la cookie en el servidor volvía dinámicas 45 rutas), A-4 (unitario de la vista previa),
  SM-1 (spec con el rótulo viejo), SM-3 (región repetida), A-8 y SM-5.
- **Quedan en PROGRESO:** A-2 (versión cruzada del mostrador: API primero), A-5..A-7, A-9..A-12,
  A-14, SM-4, SM-6..SM-8.

## Tests y UAT

- **Unitarios:** API 2729 (2 omitidos); web 19 archivos, 115 tests.
- **E2E locales con build de producción**, base `ayr_local_e2e_cc27`, API en 3010:
  - M1/M2: 27 passed, 2 skipped (`@pse`), con los de planta, tolerancia, catálogo y mostrador;
  - M3: 53 passed, con despacho, totales al céntimo, scroll D-179, formularios, flujo comercial,
    reactivar y traer comprobante;
  - M4: 11 passed, con el Panel de cc26, el menú de D-326 y los Excel;
  - tras las correcciones: 22 passed.
- **UAT:** aprobado por defecto (brief). Guion para el dueño en `docs/uat/cc27.md`.
- **CI del PR:** (se completa).

## Resumen de D-232 (antes de la ventana)

- **Qué entra:** el mostrador con IGV, la confirmación de cierres de planta, formularios largos
  (barra fija, aviso de cambios sin guardar, nombres accesibles), 1366 y el Panel del vendedor.
- **Qué no entra:** migraciones (0), cambios de permisos (la ruta nueva es solo del vendedor y las
  vistas previas heredan los roles de sus acciones), cambios en el kardex.
- **Riesgo principal:** el refactor mecánico de `commitInTx` y del `closeInTx` de drywall (diff sin
  espacios: solo movimiento de código), y la vista previa que toma los mismos candados que el
  cierre real mientras dura.
- **Convivencia:**
  - **API nueva + web vieja:** sin cambios visibles (las rutas nuevas no se llaman).
  - **Web nueva + API vieja:** el diálogo de cierre y el Panel del vendedor darían 404, y un precio
    tipeado en el mostrador se vendería al de lista. **La API va primero.**
- **Vuelta atrás:** API a `ayr-steel-erp-api-00091-k2m` y revert del merge en `main`.

## Ventana

(Se completa.)

## Para el dueño

(Se completa.)
