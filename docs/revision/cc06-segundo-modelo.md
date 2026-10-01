# Revisión de segundo modelo — cc06 (M0, M1, M2)

- **Fecha:** 2026-10-01
- **Rama:** `feat/cc06-ui` contra `origin/main` (`a1fa929`)
- **Commits revisados:** `5b4dbe5` (M0, D-368), `66f2728` (M1, D-369/D-370), `5ba4898` (M2, D-371)
- **Revisor:** segundo modelo (Sonnet), contexto limpio. **No vale como revisión independiente
  humana**: la que cierra es la del dueño (AGENTS §2, regla 2).
- **Alcance del revisor:** solo lectura (git, grep, código). No corrió tests, E2E ni nada contra
  bases; la SQL de `coilUsage` la analizó contra `schema.prisma` y los servicios de producción.

## Hallazgos

| #   | Sev. | Dónde                                                       | Hallazgo                                                                                                                                                                                                         | Resolución                                                                                                                                                                                 |
| --- | ---- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | P1   | `reports/sales-by-material.service.ts` (CTE `meters`)       | Los reportes de **accesorio** no crean `piecesDetail` (D-343): sus metros van en `production_reports.meters_m`. La SQL solo sumaba piezas → teórico 0, rendimiento = −real. Regresión frente al teórico del SKU. | **Corregido.** Metros por reporte = `COALESCE(meters_m, Σ qty × largo ÷ 1000)`, la precedencia de `reportMeters`. E2E nuevo: accesorio de 25 m → teórico 100.000 kg.                       |
| 2   | P1   | `purchases/purchases.service.ts` (`receive`)                | `receive` lee las líneas fuera de la transacción; una corrección D-371 confirmada entre esa lectura y el claim haría recibir bobinas/kardex con cantidades viejas.                                               | **Corregido.** Las líneas se releen dentro de la transacción después del claim condicionado a DRAFT. Test unitario: la foto vieja dice 1000 kg, la relectura 950 → la bobina nace con 950. |
| 3   | P2   | `purchases/purchase-draft-edit.ts` (`impliedIgvRatePct`)    | La tasa deducida `igv ÷ subtotal` redondeada a 2 decimales puede salir 17.99 o 33.33 con líneas chicas o importes del papel.                                                                                     | **Corregido.** Se ajusta a 18 o 0 si cae a ±0,1 puntos; si no, la edición se rechaza con mensaje (no se inventa una tasa).                                                                 |
| 4   | P2   | `imports/quotation-import.service.ts` (`duplicateInvoices`) | Contaba como duplicado un comprobante re-cotizado (una anulada y una viva).                                                                                                                                      | **Corregido.** Solo se listan grupos con dos o más cotizaciones no anuladas; las anuladas van como contexto.                                                                               |
| 5   | P2   | `imports/quotation-import.service.ts` (`confirm`)           | La revalidación en READ COMMITTED no frena dos confirmaciones simultáneas del mismo archivo.                                                                                                                     | **Corregido.** `pg_advisory_xact_lock(hashtext('quotation-import:' ‖ N°))` antes del `findFirst`.                                                                                          |
| 6   | P2   | `reports/sales-by-material.service.ts` (`avg_cost`)         | Con saldo 0 el promedio puede ser 0 y el modal mostraría «prom. 0,0000 /kg».                                                                                                                                     | **Corregido.** `NULLIF(avg_cost, 0)` → «sin costo promedio».                                                                                                                               |
| 7   | P2   | specs del reporte                                           | Los unitarios mockean la SQL; el E2E cubría un caso feliz. El fixture OP-26 tenía 96 kg reales para 237 kg teóricos.                                                                                             | **Parcial.** Fixture realista (240 kg) y E2E de accesorio. Siguen sin E2E: reporte revertido, plancha NIU y dos bobinas en una OP (anotado en el handoff).                                 |
| 8   | P2   | `compras/[id]/compra-detalle-view.tsx`                      | El diálogo de edición mostraba el error de validación un instante al abrir (estado inicializado en `useEffect`).                                                                                                 | **Corregido.** El diálogo se monta con `key` por línea y nace con los valores guardados.                                                                                                   |

## Verificado sin hallazgos (resumen del revisor)

- **M0:** igualdad exacta o `startsWith` con `\n` corrige el choque `F001-1`/`F001-12`; la anulada
  no cuenta como relacionada; preview y `confirm` usan la misma función; el endpoint de duplicados es
  solo lectura y hereda `@Roles(ADMINISTRADOR)`.
- **M1:** la fórmula `ml × ancho × espesor × densidad ÷ 1000` es dimensionalmente correcta, sin el
  +1 %, todo en `Decimal`; los reportes revertidos quedan fuera por `status = 'ACTIVE'` y sus kilos
  ya están netos por la reversa; `DISTINCT` y los joins de `inventory_balances` y `meters` no
  multiplican filas; el despunte cuenta como real y no como teórico; las notas de crédito restan
  en las tres capas; la bobina entera conserva teórico = kilos; rentabilidad por comprobante y Excel
  solo leen el acumulador; sin hooks después de returns tempranos.
- **M2:** `@Roles(ADMINISTRADOR)` en PATCH y DELETE; el lock `updateMany … DRAFT` serializa con
  `addPayment` (`FOR UPDATE`); la renumeración ascendente no choca con el único
  `(purchaseId, lineNumber)`; importes con `money()` como el alta; auditoría antes/después.
