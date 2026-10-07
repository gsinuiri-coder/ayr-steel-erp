# Ventana cc31 — Mejoras de UX (seis cortes, solo `apps/web`)

## Resumen

- Sesión desatendida del 7 de octubre de 2026, de 02:20 a 07:00 de Lima. El dueño avisó que el
  cliente no usaba la app ese día, así que el merge y el despliegue quedaron abiertos hasta las
  07:00 del jueves 8. Sin API, sin migraciones y sin SQL. Las horas van en Lima, calculadas con
  Node porque Git Bash ignora `TZ`.
- Fuente de verdad:
  - `docs/handoff/ventanas/cc31-ux-especificacion.md`, copia de `local-data/cc31-ux/ESPEC.md`;
  - los tableros de `local-data/cc31-ux/tableros/`, que no se suben al repo.
- Un PR por corte, encadenados. La vuelta atrás es promover el despliegue anterior en Vercel y
  revertir el PR.

| Corte              | PR   | `main`     | Vercel (prod) | Vuelta atrás            | Verificación en producción                                                                     |
| ------------------ | ---- | ---------- | ------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| 1 Base             | #124 | `5fda071f` | 6907064391    | 6902941524 (`dbfd6d7c`) | ingreso, Panel, /pedidos, /clientes, /bobinas                                                  |
| 2 Marco            | #125 | `bc0d8b38` | 6907692122    | 6907064391              | ingreso, Panel, /pedidos, /comprobantes, tipo de cambio                                        |
| 3 Detalle y listas | #126 | `2c76fc25` | 6908516921    | 6907692122              | ingreso, Panel, /pedidos, /cotizaciones, /comprobantes                                         |
| 4 Panel            | #127 | `67ed4ad2` | 6908858577    | 6908516921              | ingreso, Panel, /cotizaciones                                                                  |
| 5 Formularios      | #128 | `08e3bbdb` | 6908933579    | 6908858577              | ingreso, Panel, /despachos/nuevo, /compras/nueva                                               |
| 6 Cotización       | #129 | `ebb0205b` | 6914510396    | 6912775303 (`7d890f9d`) | ingreso, Panel, nueva cotización, pedido directo, editar cotización (agregar ítems: ver abajo) |

En los cinco cortes desplegados la consola salió sin errores. La verificación usó un admin efímero
y Playwright contra `https://v2.mareliac.pe`, nunca `e2e:prod`.

## Cómo entró cada corte

- **Cortes 1 a 3:** CI completa en verde: lint, typecheck y unit; E2E en el Postgres del runner;
  smoke Neon ci.
- **Corte 4:** entró con lint, unit y E2E en verde, pero su smoke Neon ci repetido seguía corriendo
  (lo cancelaron dos veces los PR en paralelo, por el grupo `neon-ci-branch`). Lo cubría el smoke
  verde del #128, que contiene todo el código del #127. Se hizo así para entrar antes de las 07:00.
- **Corte 5:** CI completa en verde en `3ffc1dd9`. La integración con `main` tuvo un conflicto en el
  formulario de contraseña, resuelto en `02da3f80` con la versión del corte 5. El árbol quedó
  idéntico al probado (lo confirmó `git diff --quiet`).
- **SonarCloud:** «el análisis falló» del lado del servidor en varios PR. No es un check requerido.
  Lo anoté como infraestructura.

## Decisiones provisionales (D-480..D-501)

Están en `docs/ARQUITECTURA.md` §0.2. Todas son provisionales y esperan la revisión del dueño.
D-496..D-501 son del corte 6.

## Omisiones por falta de dato del API

- Campana: «bobinas por terminarse» y la antigüedad del comprobante más viejo sin aceptar.
- «Ir a» y la página 404: buscar documentos por código.
- Ambiente demo: el web lo lee de `AYR_ENVIRONMENT` en el servidor de Next.
- Corte 6:
  - «RUC activo · N cotizaciones vigentes»;
  - «Enter en el último largo agrega otro»;
  - «Material que compromete al confirmar» agrupado;
  - los filtros «Todas» y «Bobina completa» del selector;
  - que «Agregar línea» abra el buscador.

## P3

Lista completa de los informes de revisión de los seis cortes. Estado al 7 de octubre; los
cerrados en cc32 entraron en su corte 0 (`docs/handoff/ventana-cc32.md`).

| Corte | P3                                                                                                          | Estado                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1     | `lib/download.ts` decía «error 500» en una descarga fallida                                                 | Cerrado en cc32 (corte 0)                                       |
| 1     | El diálogo de confirmar mezcla precisiones (tabla «21.20 kg», nota del API «21.200»)                        | Abierto                                                         |
| 2     | La campana no se actualizaba al despachar o emitir (hasta 60 s de desfase)                                  | Cerrado en cc32 (corte 0)                                       |
| 2     | El 429 del ingreso pierde la cuenta regresiva al recargar                                                   | Abierto                                                         |
| 2     | «Sesión vencida» también sale tras una revocación                                                           | Abierto                                                         |
| 2     | El ARIA del combobox de «Ir a»                                                                              | Abierto                                                         |
| 2     | Plurales fijos en los contadores del menú                                                                   | Cerrado en cc32 (corte 0)                                       |
| 3     | El contador de la sección llevaba `aria-label` en un `<span>` sin rol                                       | Cerrado en cc31 (texto `sr-only`)                               |
| 3     | El contador del kardex de la bobina contaba todos los movimientos y la tabla muestra 10                     | Cerrado en cc31 (la sección ya no lleva contador)               |
| 3     | La fila de 34 px de las secciones también alcanza a tablas de producción                                    | Abierto (planta está fuera de cc32)                             |
| 3     | En el pedido, la fecha prometida salía dos veces para el administrador                                      | Cerrado en cc31 (solo queda el control)                         |
| 3     | Pedidos: una URL con varios estados activos se rotula «en curso»                                            | Abierto                                                         |
| 3     | Comentario de `header-actions.tsx` que nombraba el menú «⋯»                                                 | Cerrado en cc31                                                 |
| 4     | El comentario de la fecha del Panel decía «martes 6»                                                        | Cerrado en cc31                                                 |
| 4     | Conteos del Panel en «…» fijo si la consulta falla                                                          | Cerrado en cc32 (corte 0: «No se pudo calcular» y «Reintentar») |
| 4     | «… en cifras» toma el mes del inicio del rango: confirmar que el rango del Panel es siempre el mes en curso | Abierto                                                         |
| 5     | La unidad de los campos con unidad adentro no estaba en el nombre accesible                                 | Cerrado en cc32 (corte 0)                                       |
| 5     | El bloqueo del clic afuera de un diálogo no cuenta lo elegido en un Select                                  | Abierto                                                         |
| 5     | Diálogos de bobina y pedido con el ejemplo dentro del campo                                                 | Cerrado en cc32 (corte 0)                                       |
| 5     | Orden de corte: una merma esperada inválida no se marca (ya era así antes)                                  | Abierto                                                         |
| 6     | «Lista» se muestra a 2 decimales y el precio sembrado tiene 4                                               | Abierto                                                         |
| 6     | La suma de importes por línea puede diferir S/ 0.01 del total redondeado una vez (D-377)                    | Abierto                                                         |
| 6     | El nombre `listPriceWithIgv` está repetido en tres archivos                                                 | Abierto                                                         |
| 6     | ↑ en la primera fila del selector no vuelve al buscador                                                     | Abierto                                                         |
| 6     | La unidad dentro del campo estaba oculta para el lector de pantalla                                         | Cerrado en cc32 (corte 0)                                       |
| 6     | Posible solape de la cifra con unidades largas como «/und»                                                  | Abierto (no visto en pantalla)                                  |
| 6     | Con `noFloorReason` desaparece la lista                                                                     | Abierto                                                         |
| 6     | `focusLineQty` depende de que el foco esté en `body`, sin test que lo fije                                  | Abierto                                                         |

## Para la siguiente sesión

- **#129 (corte 6):** entró el mismo 7 de octubre a las 10:56 de Lima (el dueño aclaró que la
  autorización llegaba hasta las 07:00 del jueves 8, no del miércoles), con la CI completa en verde
  —SonarCloud incluido, tras sumar `lib/list-price.spec.ts` para la cobertura del código nuevo—.
  Verificado en producción sin errores de consola. «Agregar ítems» no se pudo abrir en producción:
  no hay ningún pedido en curso (los 100 visibles están atendidos) y no se crean documentos de
  prueba; ese uso queda cubierto por la E2E de la CI y la local.
- **Riesgo:** es el corte de mayor riesgo. Las revisiones confirmaron que no cambian el payload, los
  pisos, las validaciones ni el habilitado del botón. Sí agrega tres comportamientos:
  - elegir un producto de otra línea cambia la línea de la fila;
  - «Usar X» rellena el mínimo;
  - el foco pasa a la cantidad.
    Los tres tienen spec propio.
- **UAT de los seis cortes:** en `docs/uat/cc31.md`.
- **Primer ingreso:** «Guardar y entrar» ahora hace una carga completa del Panel. Antes, el cambio de
  marco se comía la navegación y el usuario nuevo quedaba en «Cambiar contraseña». Ese defecto
  estuvo en producción desde el corte 2 hasta el corte 5.
