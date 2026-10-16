# cc56 corte C — revisión de segundo modelo

Modelo: Sonnet. Diff revisado: `origin/main...origin/cc56-c-cierre` (13 archivos, +684). Solo lectura, nada contra producción.

## Resumen

Sin P0. Dos P1 (selección de comprobantes y comprobantes anulados por NC), cuatro P2, cuatro P3. Permisos, DTO/Excel, E2E y ausencia de datos reales están bien.

## P1

### P1-1 Selección: solo entran comprobantes emitidos dentro del período

`apps/api/src/reports/undispatched-at-close.service.ts:25-37`. Los documentos salen de `salesMargin({from,to})`, que filtra `issue_date` en el rango. Una factura de agosto cuya mercadería salió el 07/10 estaba facturada y no despachada al cierre de septiembre, pero NO aparece en el reporte de septiembre (solo en el de agosto). El título es «al cierre», y el inventario al cierre sí la incluye, así que el contador no puede cuadrar inventario contra kardex. Arreglo: el universo debe ser comprobantes con `issue_date <= to` (sin `from`) y salida `> to` o ninguna; o declarar y rotular explícitamente que es «emitidos en el período» (el texto web/Excel hoy dice «Comprobantes del X al Y», que es honesto, pero el nombre y el uso en Inventario valorizado inducen al error). Sin `from`, ojo con SIN_SALIDA histórico (ver P1-2).

### P1-2 Comprobantes sin mercadería a despachar o anulados por NC quedan para siempre como SIN_SALIDA

`undispatched-at-close.ts:44-45`, `undispatched-at-close.service.ts:26-37`. `SIN_SALIDA` = no hay despacho ISSUED con `invoiceId`. Entran como falsos positivos: facturas solo de servicio/líneas NOOP (nunca tienen despacho), facturas anuladas con nota de crédito total (la factura sigue en estado vivo y la NC se filtra por docType), y boletas/facturas cuyo despacho se declaró con otro comprobante del mismo pedido. Cada una suma venta al total y ensucia la lectura. Arreglo: excluir comprobantes sin líneas con movimiento de inventario (estrategia NOOP) y descontar los acreditados por NC (o al menos marcarlos), y cubrirlo con prueba.

## P2

### P2-1 Costo nulo por «no comparable» se rotula como «sin salida»

`undispatched-at-close.ts:52,59-70`, `undispatched-at-close-xlsx.ts:43`, `undispatched-at-close.tsx` pie. `costPen` es `null` también cuando el pedido está NO_COMPARABLE o fuera de totales de Ventas y margen (`sales-margin.service.ts:~626-639`), con despacho existente. La fila queda DESPACHADO_DESPUES con costo «—» y el total dice «N sin salida (sin costo)»: es falso. `withoutCostCount` mezcla dos causas. Arreglo: separar `withoutCostCount` por causa (sin salida / no comparable) o rotular «sin costo».

### P2-2 PARCIAL muestra el costo completo del comprobante

`undispatched-at-close.ts:52`. Con parte despachada dentro del período, el costo estimado es el de todo el comprobante (incluida la parte ya fuera del inventario al cierre) y se suma al total que el texto presenta como «todavía figura en el inventario al cierre». Sobrestima. Arreglo: costo prorrateado por las salidas posteriores (hay `cost` por despacho en `costsByOrder`), o rotular en PARCIAL «costo del comprobante completo».

### P2-3 Doble costo de cómputo

`undispatched-at-close.service.ts:25`. Cada carga ejecuta íntegro `salesMargin` (10 consultas fijas, pesadas) además de la de la pantalla que ya lo mostró; en Inventario valorizado cada cambio de mes repite todo. Aceptable hoy, pero sin presupuesto de consultas verificado por test (AGENTS.md §6). Arreglo: test de presupuesto (11) y, si hace falta, caché de react-query `staleTime` o reutilizar `data` de la vista de margen.

### P2-4 Fecha de salida = `dispatchDate`, no la fecha del movimiento de kardex

`undispatched-at-close.service.ts:47`. La etiqueta dice «Salida real» y «sale del kardex», pero se lee de `dispatches.dispatch_date`. Si D-278/D-364 permiten que el movimiento tenga otra `operation_date` (cambio de fecha = reversa + movimiento nuevo), pueden diferir. Confirmar que es la misma fecha, o leer `inventory_movements.operation_date` vía `dispatch_items.movement_id`. Sin confirmarlo, el reporte puede errar justo en el borde del cierre.

## P3

- P3-1 `apps/web/src/components/reports/undispatched-at-close.tsx` (`valid`): `^\d{4}-\d{2}$` acepta `2026-13` o `0000-00`; `monthRange` genera fechas inválidas y el API responde 400 con el mensaje genérico «No se pudo cargar». Validar mes 01-12.
- P3-2 El filtro «A costo» y la pestaña de línea de Ventas y margen no se aplican a la sección (solo se muestra en «Todas»); coherente, pero conviene decirlo en la nota. `ventas-margen-view.tsx` pasa solo `period`.
- P3-3 `findMany` con `in: ids` sin tope: períodos de miles de comprobantes acercan el límite de parámetros bind de Postgres (32767). Con `documents` vacío conviene saltar la consulta.
- P3-4 Las NC se descartan sin avisar y la venta no se netea; las notas web/Excel dicen «venta sin IGV» del comprobante, no neta. Aclarar en la nota.

## Lo revisado sin hallazgos

- Permisos: `@Roles(ADMINISTRADOR)` en JSON y xlsx, probado en `reports.controller.spec.ts`; web bajo `RoleGate` ADMINISTRADOR en ambas vistas.
- Query validada con Zod y `from <= to`; fechas como cadenas ISO comparadas con `>` correctamente; `Decimal`/strings en dinero.
- Coherencia: venta y costo salen de `salesMargin`, mismas cifras que Ventas y margen; el día del cierre cuenta dentro (probado).
- Excel construye del mismo DTO; `filename` y nota correctos.
- E2E: fixtures sintéticos (`F999-…`, uuid de prueba, «Cliente E2E cc56»), skip contra producción (D-126), rutas `page.route` consistentes con la URL real; sin datos reales ni secretos en el diff.
- Pruebas unitarias: cubren orden, parcial, día del cierre, Excel y servicio; faltan los casos de P1-2, P2-1 y NC/NOOP.

## Resolución (cc56, antes del despliegue)

- **P1 de las dos (despachos no declarados y fechas en vez de cantidades):** el armado se rehízo **por cantidades** por línea
  de pedido: lo facturado hasta el cierre (factura y boleta vivas, también de meses anteriores) menos lo despachado hasta el
  cierre (despachos vivos, **declarados o no**, D-205). Lo pendiente se reparte desde la factura más reciente hacia atrás.
  Un comprobante del período entra si alguna línea queda pendiente; las líneas sin línea de pedido (servicios, ajustes) no
  cuentan, así que un comprobante solo de servicios no aparece.
- **PARCIAL sobrestimaba (P2):** el costo estimado es el de Ventas y margen en la proporción pendiente (por subtotal de las
  líneas); la venta sigue siendo la del comprobante completo y la nota lo dice.
- **Costo nulo mal rotulado (P2):** el pie dice «sin costo estimado» (incluye los no comparables).
- **Alcance de «del mes» (segundo modelo P1-1, autorrevisión P2-6):** el brief pide los comprobantes del mes; los de meses
  anteriores todavía pendientes cuentan para repartir lo despachado pero no se listan. Queda escrito en D-670.
- **Anotados sin cambio (P3):** un despacho del mes revertido después del cierre no cuenta como salida (el despacho no guarda
  la fecha de su reversa); una NC que acredita cantidad no se netea de lo facturado; `salesMargin` se calcula otra vez para
  la sección (sin presupuesto de consultas); la sección ignora «A costo» y la pestaña de línea (se muestra solo en «Todas»);
  el Excel va como botón propio de la sección, fuera de «Más opciones»; el mes inválido oculta la sección sin mensaje.
