# Diagnóstico: des-anular bobina de compra — 2026-09-29

## Alcance y método

Diagnóstico de solo lectura sobre `demo` (clon de producción). No se ejecutó ninguna
corrección, `undo` ni escritura de datos. La consulta se expone como CLI de dominio mediante
`runApiCli`; abre una transacción `READ ONLY` y usa Prisma ORM.

## 1. Ciclo de vida y significado de «anulada»

Los estados de una bobina son `OPEN` (Vigente), `CLOSED` (Terminada), `CANCELLED` (Anulada) e
`IN_THIRD_PARTY` (En corte tercerizado), definidos en
`apps/api/prisma/schema.prisma:211-221` y rotulados en
`packages/shared/src/enums.ts:396-415`.

Las transiciones vigentes son:

| Acción                                    | Transición                                                             | Evidencia                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Terminar / cerrar                         | `OPEN → CLOSED`; registra o liquida el remanente                       | `apps/api/src/coils/coil-operations.service.ts:539-610`                 |
| Reabrir terminada                         | `CLOSED → OPEN`; revierte solo el ajuste de cierre                     | `apps/api/src/coils/coil-operations.service.ts:617-661`                 |
| Anular bobina                             | `OPEN/CLOSED → CANCELLED`, si no hay movimientos vivos posteriores     | `apps/api/src/coils/coil-operations.service.ts:1071-1105`, `1112-1142`  |
| Enviar/recibir/cancelar corte tercerizado | `OPEN → IN_THIRD_PARTY → OPEN`                                         | `apps/api/src/cutting/cutting.service.ts:189-192`, `326-330`, `612-620` |
| Anular compra recibida                    | revierte sus ingresos y marca sus bobinas no anuladas como `CANCELLED` | `apps/api/src/purchases/purchases.service.ts:613-645`                   |

Por tanto, **sí existe “anular bobina” como acción distinta** de terminar y de reabrir una
terminada. La acción real que produce el estado que el dueño llama “anulada” es
`CoilOperationsService.cancel` (`coils.cancel`); alternativamente puede ser la anulación de la
compra, que cancela el conjunto de sus bobinas.

## 2. Efecto en datos y kardex

El kardex es append-only: una anulación emite un asiento inverso con `reversalOfId`; no actualiza
ni borra el asiento original (`apps/api/prisma/schema.prisma:871-904`). La anulación individual
obtiene el único ingreso inicial vivo, lo revierte con `InventoryService.reverse`, actualiza el
estado de la bobina a `CANCELLED` y registra auditoría (`apps/api/src/coils/coil-operations.service.ts:1092-1103`).

La bobina conserva `purchaseId` y `purchaseItemId`, que son vínculos del modelo y no se modifican
en esa acción (`apps/api/prisma/schema.prisma:1083-1088`). La compra queda intacta cuando se anula
una bobina individual. Si la acción fue **anular compra**, la compra sí pasa a `CANCELLED` y se
revierten los ingresos vivos de toda la compra antes de cancelar sus bobinas
(`apps/api/src/purchases/purchases.service.ts:580-645`).

## 3. Restauración existente

No hay una acción para restaurar `CANCELLED`. La reapertura vigente exige exactamente
`CLOSED` y rechaza cualquier otro estado (`apps/api/src/coils/coil-operations.service.ts:634-646`).
Además, revierte un `CLOSE_ADJUSTMENT`, que es un mecanismo diferente de la reversa de un
ingreso `PURCHASE` (`apps/api/src/coils/coil-operations.service.ts:620-625`).

La reapertura automática D-360 también opera solo sobre `CLOSED` y solo cuando la misma causa
dejó la bobina en cero (`apps/api/src/coils/coil-auto-terminate.ts:355-409`). Por tanto, D-360
no cubre una bobina anulada.

## 4. Implicancia fiscal

No hay documento SUNAT en el flujo de anular/revertir bobina: el método de anulación solo llama
al kardex, actualiza `coils` y escribe auditoría (`apps/api/src/coils/coil-operations.service.ts:1071-1105`).
La bobina es un insumo de compra; su cancelación o futura restauración no emite ni depende de un
documento fiscal de venta. El comprobante de compra y su XML son metadatos del ingreso, no un
flujo SUNAT de esta operación.

## 5 y 6. Inventario demo y clasificación de restauración

Foto: `2026-09-29T20:00:39.223Z`, rama `demo`, transacción `READ ONLY`.

El clasificador reutiliza el criterio conservador del tool de fechas recibidas: si existe cualquier
movimiento ajeno al ingreso `PURCHASE` y a su reversa, la restauración queda excluida porque el
reingreso podría recostearlo. La implementación está en
`apps/api/src/coils/cancelled-purchase-coils-inspection.ts:38-75`; la fuente del criterio es
`apps/api/src/purchases/purchase-received-date-fix.ts:111-118`.

| SKU                            | Compra origen |        Kg | Fecha compra | Entrada revertida | Costo/kg | Movimientos posteriores | Veredicto          |
| ------------------------------ | ------------- | --------: | ------------ | ----------------- | -------: | ----------------------- | ------------------ |
| IMPO-ALZ-ROJO-3020-0.28-4240-1 | PRRG1-0001    | 4,240.000 | 2026-07-13   | 2026-09-21        |   3.4328 | Ninguno                 | RESTAURABLE-SEGURO |
| XSY-ALZ-ROJO-3020-0.38-4544-9  | E001RG-262    | 4,544.000 | 2026-08-18   | 2026-09-22        |   2.7131 | Ninguno                 | RESTAURABLE-SEGURO |

Resultado: 2 de 2 restaurables de forma segura bajo esta foto. No hay excluidas en demo. La
clasificación se debe recalcular dentro de la transacción de una futura ejecución antes de cada
escritura, porque una salida posterior cambia el resultado.

## CLI read-only

El subcomando es `inspect:cancelled-purchase-coils`. Rechaza argumentos de negocio
(`apps/api/src/coils/cancelled-purchase-coils-inspection.ts:33-35`), se ejecuta mediante
`runApiCli` (`scripts/inspect-cancelled-purchase-coils.mjs`) y fija `SET TRANSACTION READ ONLY`
antes de consultar (`apps/api/prisma/inspect-cancelled-purchase-coils-cli.ts:20-23`).

Se ejecutó en demo con:

```powershell
$env:AYR_ENV_SETUP='C:\Users\User\Documents\workspace\ayr\ayr-steel-erp\.env.setup'
pnpm inspect:cancelled-purchase-coils --branch demo
```

Comando exacto para que el dueño obtenga la foto viva de producción en su propia terminal:

```powershell
$env:AYR_ENV_SETUP='C:\Users\User\Documents\workspace\ayr\ayr-steel-erp\.env.setup'
pnpm inspect:cancelled-purchase-coils --branch production --confirm-production
```

No ejecutar `--execute`: este subcomando no lo admite ni tiene ruta de escritura.

## Recomendación de diseño para «des-anular» seguro

Implementar una acción administrativa separada, sin reutilizar “Reabrir terminada”. Debe:

1. reclasificar dentro de una única transacción y bloquear la bobina;
2. exigir `CANCELLED`, vínculo a compra, un único `IN/PURCHASE` original y su reversa;
3. rechazar cualquier movimiento ajeno posterior, reserva, producción o corte tercerizado;
4. regrabar el ingreso original mediante `InventoryService.record` con misma fecha, cantidad,
   unidad, costo, referencia `PURCHASE` y nota de corrección; luego actualizar el estado a
   `OPEN`, nunca editar ni borrar kardex;
5. pedir confirmación explícita, limitarlo a ADMIN, escribir auditoría con IDs de ambos asientos
   y registrar un identificador de lote reversible mientras no existan movimientos posteriores.

Comparte con M2b el motor de corrección de asientos de compra: preflight conservador, reversa y
re-registro append-only, auditoría y bloqueo si una salida posterior puede recostear. Debe entrar
en una pista propia con pruebas de seguro/excluido, dry-run en demo, respaldo y ventana de deploy;
este diagnóstico no implementa esa mutación.

## Foto de producción y decisión (cc08, 2026-10-01)

Hay tres fotos `READ ONLY` del 2026-10-01, tomadas con el OK del dueño:

- 14:21 UTC, la CLI del #60;
- 14:22 UTC, el detalle por bobina, en `local-data/cc08/insp-production.json`, fuera de git;
- 14:37 UTC, con el clasificador de D-375.

Son **9** bobinas anuladas de compra. En todas el film está sellado (anular no lo toca) y la
moneda es PEN.

| Bobina                          | Compra (estado)        |   Kg | Costo/kg | Entrada original | Plan D-375 (fecha de la anulación) | Gemela activa con el mismo peso y especificación |
| ------------------------------- | ---------------------- | ---: | -------: | ---------------- | ---------------------------------- | ------------------------------------------------ |
| IMPO-ALZ-AZUL-5002-0.28-4150-23 | 118-315630 (RECEIVED)  | 4150 |   2,6938 | 14/08            | EN_SU_FECHA 28/09                  | ninguna                                          |
| IMPO-…-0.28-4240-1              | PRRG1-0001 (CANCELLED) | 4240 |   3,4328 | 21/09            | EN_SU_FECHA 21/09                  | 4240-47 (también anulada)                        |
| IMPO-…-0.28-3711-45             | PRRG1-0002 (CANCELLED) | 3711 |     3,43 | 01/08            | EN_SU_FECHA 28/09                  | SALDO-…-3711-3 (terminada)                       |
| IMPO-…-0.28-4240-47             | PRRG1-0002 (CANCELLED) | 4240 |     3,43 | 01/08            | EN_SU_FECHA 28/09                  | 4240-1                                           |
| IMPO-…-0.28-4786-46             | PRRG1-0002 (CANCELLED) | 4786 |     3,43 | 01/08            | EN_SU_FECHA 28/09                  | SALDO-…-4786-1 (vigente)                         |
| IMPO-…-0.38-3842-43             | PRRG1-0002 (CANCELLED) | 3842 |     3,43 | 01/08            | EN_SU_FECHA 28/09                  | IMPO-…-3842-36 (vigente, 118-315630)             |
| IMPO-…-0.38-3866-42             | PRRG1-0002 (CANCELLED) | 3866 |     3,43 | 01/08            | EN_SU_FECHA 28/09                  | SALDO-…-3866-11 (vigente)                        |
| IMPO-…-0.38-4242-44             | PRRG1-0002 (CANCELLED) | 4242 |     3,43 | 01/08            | EN_SU_FECHA 28/09                  | IMPO-…-4242-40 (vigente, 118-315630)             |
| XSY-ALZ-ROJO-3020-0.38-4544-9   | E001RG-262 (CANCELLED) | 4544 |   2,7131 | 22/09            | EN_SU_FECHA 22/09                  | XSY-…-4544-4 (vigente, E001-262)                 |

- **El clasificador del #60 se reemplazó.** Contaba como «ajenos» los pares que se anulan entre
  sí (ventas revertidas, reingresos por corrección de costo) y marcaba 7 EXCLUIDA. El de D-375
  bloquea solo por salidas **vivas**, por decisión del dueño.
- **Decisión del dueño:** restaurar por ahora solo la AZUL (`IMPO-ALZ-AZUL-5002-0.28-4150-23`).
  Las otras ocho pueden ser la **misma bobina física** que su gemela activa; se deciden aparte.
- **Compras anuladas:** se restaura igual, y la compra no se toca.

**Fecha de la restauración (revisión cc08, decisión del dueño).** La anulación no borra el
ingreso: lo revierte con una salida fechada el día de la anulación. La restauración se fecha en
**esa salida**, no en el ingreso original. Por ejemplo, la AZUL entró el 14/08 y se anuló el
28/09, y se restaura el 28/09: el kardex queda con 4150 kg continuos desde el 14/08, como si nunca
se hubiera anulado. Restaurarla el 14/08 habría dejado 8300 kg del 14/08 al 27/09.
