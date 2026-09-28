# Handoff — Correcciones 05: ventas por material y cuatro ajustes (D-354 a D-358)

**Estado al cierre: desplegado.** PR #48 mergeado (`9a7208a`). API `ayr-steel-erp-api-00063-qwp` (git-sha
`63134cc`), sin migración y sin respaldo, web en Vercel, smoke en verde en los dos, verificación de solo
lectura hecha (detalle en `docs/PROGRESO.md`, «Ventana de Correcciones 05»). Docs de cierre en la rama
`docs/cierre-correcciones-05`.

Texto del cliente: `docs/cliente/correcciones-05.md` (las capturas, en `local-data/corr05/` del checkout
principal). Guion UAT: `docs/uat/correcciones-05.md`. Guía del cliente: `docs/cliente/revision-2026-09-25.md`
§1.22. Revisiones: `docs/revision/correcciones-05-autorrevision.md` y
`docs/revision/correcciones-05-segundo-modelo.md` (con la respuesta de la sesión al final de cada una).

## 1. Qué entró

| Milestone | Decisión | Resumen                                                                                                                                                                                                                                                                                                          |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1        | D-354    | Reportes → «Ventas por material» (solo ADMINISTRADOR): tipo × espesor × color del producto vendido; universo de «Ventas y margen»; peso real y costo del kardex de las bobinas de la producción de cada línea, prorrateados por facturado ÷ producido; «No trazable» con motivo; modal Sumado/Desglosado; Excel. |
| M2        | D-355    | Reporte mensual de bobinas: solo vigentes al fin de mes; terminadas/agotadas y anuladas con saldo al inicio resumidas debajo; la anulada en el mismo mes de su alta no figura; totales y D-340 intactos; cuadre; Excel y PDF nuevos.                                                                             |
| M3        | D-356    | ML teórico del peso inicial en Bobinas (lista y PDF); del disponible en Inventario → «Bobinas por tipo», sumado bobina por bobina, con Excel. Misma `equivalentMeters`.                                                                                                                                          |
| M4        | D-357    | Pedidos: comprobantes vivos en la lista (primero + «+N») y en el detalle. `OverflowLinks`/`OverflowPopover` extraídos de `CoilOverflow`.                                                                                                                                                                         |
| M5        | D-358    | Comprobantes: despacho declarado (`Dispatch.invoiceId`); si no hay, «Del pedido: DES-…» en gris y en un campo aparte (D-205). La guía muestra su propio despacho.                                                                                                                                                |

**Decisiones del dueño en la sesión** (todas en §0.2): universo de M1 = comprobantes por fecha de emisión (no
el `SALE`), cuadre en dos partes por D-247, prorrateo por facturado neto ÷ producido de la línea (no existe la
OP con varias líneas), «sin producción aún» y la leyenda de la utilidad; M2 por saldo y con Excel (PDF
sacrificable: entró); M3 con Excel de «Bobinas por tipo»; M4/M5 con el «+N» compartido.

## 2. Lo que la sesión siguiente tiene que saber

- **Agosto ya no cierra en 291 636 kg sino en 283 602.** No es de esta entrega: dos ventas de bobina entera
  (`SALDO-…-4194-7`, `SALDO-…-3840-12`, 8 034 kg) se registraron el 2026-09-26 a la noche con fecha de agosto
  (D-278), después de la verificación de D-340. Septiembre bajó lo mismo (171 650.418).
- **Producción no tiene comprobantes de septiembre** (los 33 vivos son de agosto): «Ventas por material» y
  «Ventas y margen» de septiembre dan 0 hasta que se carguen.
- **El cuadre de M1 es por comprobante.** «Ventas y margen» deja fuera de sus totales los pedidos no
  comparables o no rastreables; «Ventas por material» los cuenta (trazable o no trazable). En agosto no hay
  ninguno, así que las dos cifras coinciden exacto. La leyenda de la pantalla lo explica.
- **El ML de M1 sale de la unidad de venta** (regla dura 13): una plancha vendida en kilos o una en piezas sin
  largo va a «No trazable» con `SIN_METRO`. Hoy no hay ninguna en agosto.
- **`LIVE_STATUSES` local de `sales-margin.service.ts`** sigue duplicado con `LIVE_DOCUMENT_STATUSES` de
  `@ayr/shared` (hoy iguales). El reporte nuevo usa el compartido.
- **`reports-xlsx.ts` exporta `build`, `num` y `Sheet`**: los Excel nuevos (M1, M2, M3) los reusan.
- **Drywall queda fuera de M1** (lo pidió el dueño; «se hará después»).

## 3. Pendientes (P2 anotados de las revisiones)

- M1: con geometría faltante el teórico queda en 0 y el rendimiento negativo (el catálogo exige la geometría
  en Coberturas Aluzinc, así que hoy no pasa).
- M1: un mes cerrado cambia si después se factura de más una línea (se lee el facturado de toda la vida).
- M1: una plancha de una corrida a stock, facturada y aún no despachada, sale «Sin producción aún».
- M1: una venta de bobina entera sin línea de pedido que apunte a la bobina no entra en el cuadre de bobinas.
- M1: sin E2E de reversas, notas de crédito ni facturación de más (cubiertos por unitarios).
- M5: una nota de crédito sin despacho declarado muestra «Del pedido: DES-…».
- M2: «consumidos» de la madre de un partido o de un corte es lo que pasó a sus hijas.
