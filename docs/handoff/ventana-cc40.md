# Ventana cc40 — Ventas y margen sin suma doble, «Ver por» por id, acabado, búsqueda al Excel

2026-10-09/10 (sesión desatendida; ventana suspendida, D-533). Sin migraciones, sin SQL contra
producción, sin escrituras de datos. Ratificación del dueño de cc30 a cc39 registrada (D-477 sigue
provisional).

## Estado en producción

| Qué                 | Valor                                                                      |
| ------------------- | -------------------------------------------------------------------------- |
| PR #163 y CI        | CI completa en verde sobre `c6f4d8e2` (E2E 32 min, smoke Neon `ci`, Sonar) |
| API en Cloud Run    | `ayr-steel-erp-api-00112-7jq`, `git-sha=c6f4d8e2`, 100 % del tráfico       |
| Web en Vercel       | `main` `131eb13a` (merge de #163), despliegue de producción en verde       |
| Smoke de producción | Verde contra `v2.mareliac.pe` y `ayr-steel-erp-web.vercel.app`             |
| Logs de `00112-7jq` | 81 respuestas, todas 200; 0 respuestas ≥ 400                               |

**Vuelta atrás:** `gcloud run services update-traffic ayr-steel-erp-api --to-revisions
ayr-steel-erp-api-00111-hz7=100` (`git-sha=04472754`) y revertir el merge de #163. La API nueva
solo agrega campos: la web vieja sigue funcionando contra ella.

## El bug: suma doble en Ventas y margen (D-587)

- **Causa:** desde RF-S4a/M3 (2026-09-22, primer Excel de Ventas y margen) la hoja «Por pedido»
  ponía la fila de cada pedido y, debajo, la de cada comprobante, **con la venta en la misma
  columna** «Venta sin IGV». Quien sumaba la columna obtenía el doble de la venta (cada venta, una
  vez por el pedido y otra por su comprobante), y la hoja no tenía fila de total. En cc39 la hoja
  pasó a existir también en cada pestaña de línea, con el mismo defecto.
- **Alcance:** solo el Excel. La pantalla «Por pedido» ya sumaba una vez (su pie suma los
  pedidos), «Ver por» Vendedor y Cliente suman las mismas filas, y el Panel suma la venta por día
  desde los comprobantes, una vez. Las cifras de la hoja «Totales» (la franja) siempre fueron
  correctas.
- **Qué cifras mostró mal:** ninguna cifra escrita en el archivo era falsa; lo falso era la suma
  de la columna. Con los datos de producción de 2026 al 10/10: 109 pedidos, venta S/ 1 318 441,29;
  sumar la columna de la hoja vieja daba S/ 2 636 882,58.
- **Arreglo:** «Por pedido» lleva una fila por pedido y «Total · N pedidos» con el mismo cálculo
  que el pie de la pantalla (`summarizeSalesMargin`, ahora en `@ayr/shared`). Los comprobantes van
  a la hoja nueva «Comprobantes» (cada uno con su pedido y su hoja, total por hoja). «Facturación
  parcial» lleva un total por estado del costo y, en «Todas», la venta excluida que dice la
  pantalla.

## Qué cambió en cada pantalla

| Pantalla                                              | Cambio                                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ventas y margen                                       | «Ver por» Cliente y Vendedor agrupan por id (D-586); el nombre del cliente enlaza a `/clientes?search=<RUC/DNI>` (no hay ficha `/clientes/[id]`, D-172); el Excel lleva la búsqueda. |
| Ventas por material                                   | Columna «Acabado» en el diálogo por bobina (D-590); «No trazable» enlaza al pedido (D-589); el Excel lleva la búsqueda.                                                              |
| Reporte mensual de bobinas                            | Columna «Acabado» (D-590); la búsqueda mira también el acabado; el Excel lleva la búsqueda y una columna «Acabado» al final.                                                         |
| Merma por bobina                                      | «tipo · acabado · color · ancho» bajo el código (D-590); el Excel lleva la búsqueda.                                                                                                 |
| Inventario valorizado, Cuentas por cobrar, Producción | Sin cambio visible; el Excel lleva la búsqueda (Producción, también «Ver por» Pedido).                                                                                               |

La búsqueda (D-588): el Excel trae las mismas filas que la tabla filtrada, con el total del pie;
lo que la pantalla no busca (franjas, «Totales», resumen, no trazable) sale entero y la hoja lo
avisa. Sin búsqueda, el Excel es el de siempre.

## CxC frente al Panel

Es solo redondeo. Los dos leen `ReceivablesAgingService.report({})`: el API da la misma cifra en
los dos (S/ 1 555 760,73 el 10/10) y el Panel la muestra sin céntimos (S/ 1 555 761). Lo fija una
prueba de base (`report-xlsx-totals.db-spec.ts`, «Cuentas por cobrar frente al Panel») y la UAT.

## Verificación

- Unitarios: API 3010 (2 omitidos de siempre), web 294. Lint, typecheck y Prettier en verde.
- `test:db` local completo: 80/80, con los casos nuevos de `report-xlsx-totals.db-spec.ts` («Por
  pedido» = pie = Vendedor = Cliente = comprobantes en las seis pestañas; búsqueda en cuatro
  reportes; CxC frente al Panel).
- E2E: los specs de reportes afectados con builds de producción en local, 31/31. Con `next dev`
  cinco se habían caído por tiempos de redirección de URL (infraestructura, no producto). La suite
  completa, en la CI.
- **UAT en producción (solo lectura, admin efímero borrado):** 18 comprobaciones, todas iguales:
  «Por pedido» = Vendedor = Cliente = Excel en las seis pestañas; Excel con búsqueda = filas de la
  pantalla en los siete reportes; el enlace al cliente lo encuentra y abre; CxC = Panel en el API.
  No hay filas «No trazable» en 2026, así que el enlace al pedido no tuvo un caso real (lo cubren
  el código y los fixtures). Salida en `local-data/cc40/` del checkout principal.
- Capturas antes y después de las 12 vistas en `local-data/cc40/capturas/` con `DIFERENCIAS.md`
  (base local sintética; el diálogo de Ventas por material no salió por falta de filas trazables).

## Revisión

- Autorrevisión (subagente sin el handoff) y segundo modelo (Sonnet,
  `docs/revision/cc40-segundo-modelo.md`): ningún P0 ni P1.
- Corregido: con una búsqueda que deja todas las filas, el Excel usa el total del API (como el
  pie); notas de búsqueda por hoja en Bobinas e Inventario y aviso en «Totales»/«Resumen»;
  «Facturación parcial» por estado del costo; acabado en el Excel de Bobinas; `finishName` en los
  fixtures E2E; búsqueda recortada a 200 caracteres en el enlace.
- Queda anotado (P2/P3): la hoja «Totales» de Ventas y margen sigue con filas por línea y el total
  en la misma columna (era así); una fila de total dentro de la columna hace que «seleccionar toda
  la columna» la cuente (convención de las demás hojas); el enlace al cliente busca por RUC con
  `contains` y un cliente genérico puede traer varios; el PDF de Bobinas no recibe la búsqueda; el
  Excel de Producción por «Pedido» con «Ver por» se elige en la URL; `salesByDay` del Panel incluye
  comprobantes de pedidos fuera de los totales (era así). La tabla de Bobinas ya era más ancha que
  1440 px y ahora tiene una columna más.

## Lo que quedó afuera

- Una ficha propia de cliente (`/clientes/[id]`): el enlace sigue el patrón D-172.
- El cliente del Panel de planta (cola) sigue sin id (fuera del pedido).
- Los subtotales por pedido de la hoja «Por OP» de Producción siguen dentro de la misma columna
  (están rotulados «Subtotal …»; no es el defecto de Ventas y margen, pero suma igual si se
  selecciona la columna entera).

## Para la siguiente sesión

- UAT del dueño en `docs/uat/cc40.md`; ratificar D-586..D-590.
- Neon: 9 ramas, dentro del máximo de 10 (`respaldo-pre-cc16-20261003` tenía fecha de borrado
  propuesta 2026-10-11: requiere OK del dueño por nombre).

## Limpieza

- Rama de PR borrada sola al hacer merge; rama local borrada al cerrar.
- Worktree auxiliar `../ayr-c40a` (capturas «antes») borrado.
- Base local `ayr_local_e2e_cc40` borrada al cerrar; procesos de API y web en 3010/3001 detenidos.
- `local-data/cc40/` copiada al checkout principal; el worktree `../ayr-steel-erp-cc40` y su
  carpeta se borran al cerrar este PR de docs.
