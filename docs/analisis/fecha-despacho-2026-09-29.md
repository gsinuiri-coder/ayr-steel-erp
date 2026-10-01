# Diagnóstico: fecha editable del despacho rápido — 2026-09-29

## Alcance y método

Diagnóstico de solo lectura. Se revisó el flujo de dominio y se ejecutó la inspección existente en transacción `READ ONLY`: demo a las `2026-09-29T21:15:55.456Z` (sin comprobantes pendientes) y producción a las `2026-09-29T21:17:02.942Z`. No se creó, revirtió ni modificó ningún despacho, movimiento, comprobante o guía.

## 1. Cómo se fija hoy la fecha

El botón rápido no recibe ningún campo de fecha. Su `POST /dispatches/at-issue-date/:invoiceId` solo recibe el identificador del comprobante y está restringido a ADMINISTRADOR (`apps/api/src/invoicing/dispatches.controller.ts:61-92`).

No está hard-coded estrictamente a `fiscal_documents.issueDate` desde D-285. El plan toma esa fecha como base, pero asigna a cada línea `max(issueDate, último productionReport activo de la línea)`: `notBefore` se carga desde el último parte (`apps/api/src/invoicing/invoice-dispatch.service.ts:581-600`, `653-660`) y `planInvoiceDispatches` elige la mayor (`apps/api/src/invoicing/invoice-dispatch-plan.ts:150-159`). Al ejecutar, crea un despacho por fecha resultante (`apps/api/src/invoicing/invoice-dispatch.service.ts:312-353`).

La UI es por eso completamente automática: solo muestra la fecha calculada y confirma el POST; no existe `dispatchDate` editable en el DTO del endpoint rápido. El despacho normal sí tiene el campo `dispatchDate` (`packages/shared/src/schemas/invoicing.ts:738-757`).

## 2. Guardas vigentes

| Guarda               | Estado actual                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kardex negativo      | Vigente. `firstNegativeDate` recorre el kardex y agrega las salidas proyectadas al final de cada día; si el saldo se vuelve negativo, la línea queda `REVIEW` (`apps/api/src/invoicing/invoice-dispatch-plan.ts:95-121`, `214-228`).        |
| D-210 / ventana      | La fecha de despacho no usa la ventana de emisión D-210. Pasa por `OperationDateService.resolve`: no futura ni anterior a `HISTORICAL_LOAD_START`; si difiere de hoy es retrofecha (`apps/api/src/common/operation-date.service.ts:24-51`). |
| Rol                  | En despacho normal, fecha distinta de hoy exige ADMINISTRADOR por `OperationDateService.resolve`. El botón rápido entero ya es solo ADMINISTRADOR (`dispatches.controller.ts:61-92`).                                                       |
| Reserva y producción | Se conserva el destino de kardex, el cupo fabricado/reservado y la validación de cantidad antes de evaluar saldo (`invoice-dispatch.service.ts:515-571`; `invoice-dispatch-plan.ts:169-186`).                                               |

`DispatchesService.createInTx` usa `dispatchDate` tanto para `dispatches.dispatch_date` como para el `operationDate` de la salida `SALE` (`apps/api/src/invoicing/dispatches.service.ts:186-189`, `390-401`): no hay una segunda fecha oculta que el cambio tendría que sincronizar.

## 3. ¿Una fecha editable destraba los casos?

### a. Reingresar bobina hoy → producir hoy → despachar hoy

**Sí, condicionalmente.** Si el futuro flujo de restauración reingresa la bobina hoy, planta registra la producción hoy y el despacho elige hoy, el plan coloca las entradas existentes del día antes de la salida candidata del día (`firstNegativeDate` usa `rank 0` para kardex existente y `rank 1` para la salida nueva; `invoice-dispatch-plan.ts:104-115`). Con cantidad suficiente, el guard no encuentra negativo y permite `DISPATCH`.

No existe hoy una acción de reingreso de bobina anulada; este diagnóstico no la ejecutó ni la simuló. La condición sigue siendo material suficiente, reserva vigente y producción reportada: hacer editable la fecha no inventa stock ni salta esas validaciones.

### b. BBV1-341 y BBV1-347

La inspección read-only de producción mostró:

| Comprobante     | Fecha actual del plan | Líneas                                   | Bloqueo actual                             |
| --------------- | --------------------- | ---------------------------------------- | ------------------------------------------ |
| `BBV1-00000341` | 2026-08-03            | `AUTOPERF10X1` 100                       | Salida deja negativo el 2026-08-03         |
| `BBV1-00000347` | 2026-08-14            | `AUTOPERF10X1` 500; `AUTOPERF12X212` 500 | Ambas salidas dejan negativo el 2026-08-14 |

Las tres líneas alcanzan la etapa de `firstNegativeDate`: la inspección no informó “falta producir”, apertura ni otro motivo. Por ello una fecha candidata posterior **puede** destrabarlas si a esa fecha el saldo acumulado cubre 100, 500 y 500 respectivamente. No es correcto afirmar que hoy las destraba sin una simulación de esa fecha: el endpoint actual solo simula la fecha automática D-285. El cambio debe presentar la primera fecha sin negativo calculada por el mismo plan y exigir que el usuario la elija o confirme; si hoy no alcanza, permanece bloqueado.

Esto evita repetir la lección de `NF1-1`: una fecha más tardía no autoriza ignorar salidas ni recostear movimientos; solo deja pasar cuando el saldo cronológico real lo permite.

## 4. Acoplamiento fiscal

No existe una regla que exija igualdad entre fecha del comprobante y salida física. El modelo de despacho tiene su propio `dispatchDate` (`apps/api/prisma/schema.prisma:2253-2265`) y el enlace con el comprobante es una relación separada y opcional (`apps/api/prisma/schema.prisma:2307-2321`).

La guía ya modela ambas fechas de forma distinta: se emite con `issueDate = hoy` (`apps/api/src/invoicing/invoicing.service.ts:2638-2652`) y Nubefact recibe `transferDate = dispatch.dispatchDate` (`apps/api/src/invoicing/invoicing.service.ts:2752-2758`). Una salida física posterior a una factura de agosto es, por tanto, representable y más fiel al traslado.

El PLE/Kardex PEPS toma el movimiento por su fecha de operación; clasifica una salida `SALE` como venta y vincula el documento por el despacho, sin una validación de igualdad de fechas (`apps/api/src/reports/kardex-peps.service.ts:48-89`). Cambiar la fecha del despacho moverá la salida al período físico correcto del kardex/PLE, sin re-fechar la factura.

## 5. Cambio mínimo recomendado

1. En el diálogo de despacho rápido, agregar **Fecha de despacho** editable. Default: la fecha automática vigente de D-285 (`max(emisión, último parte)`), no solo emisión.
2. El preview recibe la fecha candidata, recalcula el mismo `planInvoiceDispatches` y muestra el primer día válido sugerido si la elegida deja negativo. El `POST` recibe y vuelve a calcular esa misma fecha dentro de su transacción bloqueada.
3. Conservar sin excepciones `firstNegativeDate`, la comprobación de producción/reservas, `OperationDateService.resolve`, auditoría y el rol ADMINISTRADOR del flujo de recuperación.
4. Persistir la fecha elegida en `Dispatch.dispatchDate`; la salida `SALE` seguirá heredándola por el camino existente. La guía, si corresponde, usará esa fecha como `transferDate`.

Este cambio resuelve entregas físicas posteriores cuando el stock ya existe. **No reemplaza** el motor de corrección/restauración en fecha vieja: si el hecho físico ocurrió antes y se necesita que el kardex/PLE histórico lo refleje en esa fecha, todavía se requiere el motor append-only con clasificación segura, dry-run y sus propios gates. Son dos operaciones distintas.

## Decisión registrada

Ver D-364 en `docs/ARQUITECTURA.md`: ajuste a D-285 propuesto en este diagnóstico, implementado en el PR #62 y desplegado.
