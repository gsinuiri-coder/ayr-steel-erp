# Handoff — Re-fechado de FFA1-00001386 / DES-000019 y D-288 (2026-09-25)

Agente: Claude Code, con un subagente de autorrevisión. Orden del dueño, de corrido; se paró
una vez (el flujo de reversa existente no servía) y el dueño eligió el camino.

## 1. Resumen

| Paso | Resultado                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------ |
| 1    | FFA1-00001386: DES-000019 re-fechado; la salida pasa del 19-09 al 19-08, par del 19-09 neto en cero    |
| 2    | D-288: corregir la fecha de emisión ofrece re-fechar el despacho «a la fecha del comprobante», atómico |
| 3    | Pendiente del dueño en PROGRESO: flete o desaduanaje en PRRG1-0002                                     |

Commits: `1c374e1` (D-288), `9b9ec70` (autorrevisión + CLI), `24b79f7` (fila D-288); PR #26, merge
`377df70`; y el commit de docs de esta rama.

## 2. Por qué no se usó el flujo existente

`DispatchesService.reverse` no revierte un despacho que un comprobante declarado todavía
factura. Dar de baja o acreditar FFA1-00001386 no corresponde a un error de fecha. D-288 agrega
la reversa en modo re-fechado: a la fecha de la salida que anula, y exceptuando solo al
comprobante que se corrige. Las reversas reales siguen con D-124.

## 3. Autorrevisión (subagente nuevo, mismo modelo)

0 P0. **P1 corregidos antes del merge:** (1) PEPS: la reversa de una salida sin capas dejaba el
faltante para siempre (saldo PEPS negativo en el re-fechado hacia atrás con stock justo); (2) el
re-fechado despachaba todo lo pendiente del comprobante: ahora exige que sea exactamente lo
revertido. P2 corregidos: `dropSameDayReversals` acotado al re-fechado, lock de los despachos en
orden, error de la lista en la web, tests. P2 abierto: el negativo de paso intradía en el saldo
corrido (costo promedio). **Todo queda PENDIENTE DE REVISIÓN INDEPENDIENTE.**

## 4. Production

Respaldo `respaldo-pre-refechar-des19-20260925`. API `00053-fgk` (`24b79f7`). Verificación
completa en PROGRESO («Re-fechado de FFA1-00001386»): kardex sin negativos, PEPS con la salida en
agosto, totales de agosto idénticos, 0 líneas a revisión, smoke verde.

## 5. Pendientes

- Dueño: flete o desaduanaje en PRRG1-0002 (PED-000018).
- Dueño: descargar un PEPS y confirmar la cabecera (RUC y razón social), pendiente del cierre
  anterior.
- Guion UAT `docs/uat/refechar-despacho-d288.md` (se prueba en demo).
