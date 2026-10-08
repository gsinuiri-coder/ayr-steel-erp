# Ventana cc32 — Reportes y documentos (cuatro cortes, solo `apps/web`)

## Resumen

- Sesión del miércoles 7 de octubre de 2026, de 13:15 a 19:10 de Lima. El dueño autorizó merge y
  despliegue a cualquier hora hasta las 07:00 del jueves 8. Sin API, sin migraciones y sin SQL.
- Fuente de verdad: `docs/handoff/ventanas/cc32-especificacion.md` (copia de
  `local-data/cc32-ux/ESPEC.md`) y los tableros de `local-data/cc32-ux/tableros/` (no se suben).
- Un PR por corte, encadenados. Revisión de cada corte: autorrevisión con subagente nuevo y segundo
  modelo (Sonnet), informes en `docs/revision/cc32-c{0,1,2,3}-segundo-modelo.md`. P0/P1/P2
  corregidos antes del merge.

| Corte                         | PR   | `main`     | Vercel (prod) | Vuelta atrás            | Verificación en producción                                           |
| ----------------------------- | ---- | ---------- | ------------- | ----------------------- | -------------------------------------------------------------------- |
| 0 Cierre de cc31              | #132 | `40302513` | 6919096855    | 6915399562 (`aed67e9e`) | ingreso, Panel, /compras/nueva, /despachos/nuevo, /bobinas           |
| 1 Plantilla y Ventas y margen | #133 | `176cc21a` | 6921311739    | 6919096855              | ingreso, Panel, /reportes, Ventas y margen con datos reales          |
| 2 Los otros seis reportes     | #134 | `a61992bf` | 6923732035    | 6921311739              | ingreso, Panel y los seis reportes con datos reales                  |
| 3 Documentos                  | #135 | `8a072c58` | 6923787336    | 6923732035              | ingreso, Panel, despacho, comprobante, cotización, pedido, Mostrador |

Todo sin errores de consola, con admin efímero y Playwright contra `https://v2.mareliac.pe`, sin
`e2e:prod` y sin guardar documentos. Cada PR entró con la CI completa en verde, incluidos su smoke
propio y SonarCloud.

## Qué entró

- **Corte 0:** descargas fallidas con el motivo en español; la campana se pone al día con cada
  operación que termina bien (en lote, sin cancelar lo que está en curso; cerrar sesión no
  refresca); Panel con «No se pudo calcular» y «Reintentar»; plurales en contadores; ejemplos de los
  diálogos de bobina, pedido y comprobante debajo del campo; la unidad de los campos con unidad
  adentro en el nombre accesible. D-480..D-501 ratificadas.
- **Corte 1:** plantilla de reportes (`components/reports/*`, `lib/report-*.ts`): periodo único
  siempre en la URL que se mantiene entre reportes (se recuerda el atajo), cabecera con «Cómo se
  calcula», tabla ordenable con buscador, detalle con chevron y total al pie con Decimal; dato
  anterior marcado mientras carga y sin mezclar líneas. Página `/reportes`. Ventas y margen completo
  con «Ver por» Pedido / Vendedor / Cliente.
- **Corte 2:** Ventas por material, Cuentas por cobrar, Inventario valorizado, Reporte mensual de
  bobinas, Merma por bobina y Reporte de producción sobre la plantilla. Excel solo donde el API lo
  entrega.
- **Corte 3:** «Imprimir» abre el diálogo de impresión con el PDF del API sin descargarlo
  (`lib/print.ts`); despacho con el botón principal según la guía; Mostrador con «Imprimir
  comprobante» y Enter; «Imprimir» en comprobante, cotización y hoja de planta.

## Guía sin aceptar (ESPEC §2)

El PDF de un documento existe solo cuando SUNAT lo acepta: `storeFiles` corre únicamente con
`ACCEPTED` (`apps/api/src/invoicing/invoicing.service.ts:2061-2062, 2498, 2814, 2875`) y `file()`
responde 404 mientras no haya `pdfKey` (`:3291-3296`). Por eso «Imprimir guía» espera a «aceptada»:
mientras tanto el principal es «Ver la guía» con el texto «La guía se imprime cuando SUNAT la
acepte; ábrela para ver su estado» (D-519, D-528). En producción (PSE apagado, comprobantes
manuales) no se pierde nada: un manual queda `ACCEPTED` sin PDF y nunca tuvo descarga; una venta de
Mostrador queda `ISSUED` con su aviso de contingencia, y el «Descargar PDF» que daba 404 ya no sale.

## Decisiones provisionales (D-502..D-532)

En `docs/ARQUITECTURA.md` §0.2. D-508 quedó reemplazada por D-518.

## Excel que faltan (pieza de API)

- Merma por bobina: Coberturas Aluzinc y Drywall (no existe ninguno).
- Ventas por material: Drywall, Coberturas (UPVC) y Reventa (el xlsx descarta `businessLine`).
- Inventario valorizado: Drywall, Coberturas Aluzinc, Coberturas (UPVC) y Reventa (solo «Todas»).
- Ventas y margen: Drywall, Coberturas Aluzinc, Coberturas (UPVC), Servicios y Reventa (solo
  «Todas»).

## Omitido por falta de dato del API

- Enlace al cliente: no hay página `/clientes/[id]` y el DTO de Ventas y margen no trae su id.
- «Ver por» Cliente y Vendedor agrupan por nombre: el DTO no trae id (dos homónimos se funden).
- Pedido sin enlace en «No trazable» de Ventas por material: el DTO no trae su id.
- Nombre del acabado en Bobinas, Merma y el diálogo de Ventas por material: los DTO solo traen el
  código (`typeKey`).
- «Vuelto» en el cierre del Mostrador: la pantalla no pide el monto recibido.

## P3 abiertos

| Corte | P3                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | `InputWithUnit` sin unitario propio (cubierto por E2E).                                                                                                                   |
| 0     | Un 5xx de descarga dice «el servidor no respondió» aunque respondió con error.                                                                                            |
| 0     | Las consultas lentas de la campana (piso de precios, cotizaciones por vencer) siguen hasta 10 min tras emitir una cotización.                                             |
| 0     | Nombres accesibles redundantes: «Largo 1 de la línea 1 en metros (m)».                                                                                                    |
| 0     | `despacho-formulario-cc31` dejó de afirmar el nombre exacto con la unidad.                                                                                                |
| 0     | «Reintentar» de la campana no muestra espera mientras recarga.                                                                                                            |
| 1     | Los hooks de cada reporte corren antes del `RoleGate`: un no administrador que entra por URL pide el reporte y recibe 403 (ya pasaba antes).                              |
| 1     | `/reportes` dice «Se abren con el mes en curso» aunque haya un periodo recordado; un clic instantáneo, antes del efecto, lleva el mes en curso.                           |
| 1     | `sort`/`dir` se conservan al cambiar de pestaña y se ignoran si la columna no existe.                                                                                     |
| 1     | Sin test de una fila mixta (producto y servicio) en el margen del pie.                                                                                                    |
| 2     | Abreviaturas heredadas de la planilla del cliente en Ventas por material: «Costo prod.», «ML vendido», «Precio/ML venta», «Costo prom./unidad».                           |
| 2     | Producción: ordenar por «Cantidad» compara metros con piezas.                                                                                                             |
| 2     | Bobinas: un mes futuro en `?mes=` consulta igual (ya era así).                                                                                                            |
| 2     | Tablas más anchas que la pantalla a 1366 px (Ventas por material, Cuentas por cobrar, Inventario): se desplazan en horizontal.                                            |
| 2     | Búsqueda y orden se conservan de forma desigual al cambiar de pestaña.                                                                                                    |
| 2     | Con búsqueda parcial, un cociente del pie puede diferir en el cuarto decimal (sale de filas ya redondeadas).                                                              |
| 2     | `film-bobina-d328` ya no comprueba que la bobina abierta aparece en su tabla.                                                                                             |
| 2     | El saldo de Cuentas por cobrar (S/ 1,555,760.73 el 7/10) no coincide con la cifra del Panel; las dos vienen del API, que este corte no tocó. Revisar en una pieza de API. |
| 3     | El diálogo del Mostrador no se refresca si SUNAT acepta después.                                                                                                          |
| 3     | Una guía `VOID_PENDING` con PDF no se imprime desde el despacho (sí desde la guía).                                                                                       |
| 3     | El test del Mostrador se salta con `E2E_BASE_URL` sin `E2E_FISCAL_EMISSION`.                                                                                              |
| 3     | `print()` real no tiene prueba automática (el spec lo reemplaza): verificar en la UAT con el navegador de la oficina.                                                     |
| 3     | Con Chrome configurado para descargar los PDF, «Imprimir» los descarga y a los 4 s ofrece la pestaña.                                                                     |
| Infra | La E2E de la CI tardó 36 min en el #134 con un tope de 40: una corrida lenta se cancela. Una vez se canceló y se relanzó.                                                 |

## Para la siguiente sesión

- UAT de los cuatro cortes en `docs/uat/cc32.md`.
- Decisiones D-502..D-532 a ratificar.
- Pieza de API candidata: los Excel que faltan, ids de cliente y vendedor en Ventas y margen,
  `finishName` en Bobinas y Merma, `hasPdf` de la guía en el despacho y la diferencia de saldo de
  Cuentas por cobrar con el Panel.
