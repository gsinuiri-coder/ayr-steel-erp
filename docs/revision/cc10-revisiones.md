# Revisiones — cc10 (D-376: fecha de despacho igual a la del comprobante)

Dos pases sobre el commit `e567dea` y el de tests que le sigue:

- una **autorrevisión** de un subagente que no leyó el handoff (AGENTS.md §2 regla 2.1): es una lista
  de riesgos, no una aprobación;
- un **segundo modelo**, Sonnet 5.5 con contexto limpio (regla 2.2).

Ninguno sustituye la revisión del dueño.

## Resultado

- **P0 y P1:** ninguno en los dos pases.
- **Veredicto del segundo modelo:** aprobado.
- Las tres ramas (despacho con salida, despacho sin salida antes del inventario inicial, y motivo por
  línea de la auditoría) leen la misma `userChosenDate` y no pueden divergir.
- D-288 llama a `executeInTx` sin fecha: su comportamiento no cambia.
- Las dos fechas se comparan como `YYYY-MM-DD`, en el mismo formato.

## Hallazgos y qué se hizo

| Id                  | Hallazgo                                                                                         | Qué se hizo                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P2 (los dos)        | Los unitarios solo cubrían el primer despacho.                                                   | **Corregido.** Ahora comprueban la nota de **todos** los despachos creados (con y sin salida) y el motivo por línea de la auditoría.                                                                                                       |
| P2 (segundo modelo) | Falta el caso de una línea producida después de la emisión con la fecha del comprobante mandada. | Verificado por lectura: queda con la nota D-285, re-fechable. Test pendiente: el fixture de partes de producción no está en este spec.                                                                                                     |
| P2 (autorrevisión)  | Cambio de política sin D-nnn.                                                                    | **Registrado como D-376, propuesta pendiente de aprobación del dueño.** Interpretación por valor, no por intención.                                                                                                                        |
| P2 / P3 (los dos)   | Despachos ya grabados por el camino de D-373 con la nota «elegida» y fecha = emisión.            | **No hay ninguno en producción** (foto `READ ONLY` del 2026-10-01): en todo el sistema hay 2 despachos con la nota D-364, DES-000052 (18/08, emisión 03/08) y DES-000053 (27/09, emisión 14/08), los dos con fecha distinta de la emisión. |
| P3 (autorrevisión)  | El camino de D-373 falla con emisión anterior al piso histórico, o con un no administrador.      | Fuera de este cambio. Anotado como riesgo de la UAT de reactivar.                                                                                                                                                                          |
| P3 (autorrevisión)  | El motivo por línea de la auditoría se deriva aparte del motivo del despacho.                    | Anotado. Hoy los dos leen la misma variable.                                                                                                                                                                                               |

## Pruebas

- Unitarios de `invoice-dispatch.service.spec.ts`: **21/21**.
- E2E locales `despacho-fecha-comprobante-d278`, `refechar-despacho-d288`, `reactivar-comprobante-d373` y
  `fecha-emision-manual-f8s7`: **15 passed**.
