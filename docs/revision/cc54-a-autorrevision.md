# cc54 corte A — autorrevisión

Revisor: subagente nuevo, sin el handoff de implementación (AGENTS.md §2.2.1). Es una lista de riesgos, no una aprobación. Revisó el diff staged antes del commit 7988e008.

Veredicto: sin P0 y sin P1.

Comprobó sin hallazgo:

- `firstNegativeDate` da lo mismo que el `fitsWithoutNegative` anterior cuando hay una sola salida.
- Plan y kardex en serie dan lo mismo.
- `qtyRowsOf` devuelve lo mismo que antes.
- Las cadenas de reversas no se cancelan de más.
- Los loaders del plan y de D-285 traen `reversalOfId`.
- El candado revierte dentro de la transacción.
- Ningún texto viejo quedó citado en código ni en E2E.
- Ningún camino depende del orden entre D-652 y el acuse.
- No quedan cifras reales.

| Sev | Hallazgo                                                                                                | Qué se hizo                                                                      |
| --- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| P2  | El candado comparaba valores finales, así que una venta entre el dry-run y la ejecución lo hacía fallar | Corregido: compara después − antes (`comparePreviews`), con prueba               |
| P3  | El sha no detecta un árbol sucio                                                                        | Corregido: `+cambios` y `--execute` se niega                                     |
| P3  | D-652 también corre en el primer intento sin confirmar (una consulta liviana más)                       | Aceptado: es costo, no un defecto                                                |
| P3  | Texto «registrarlo» en la anulación                                                                     | Corregido: «Puedes hacerlo con fecha…»                                           |
| P3  | El centinela no sigue métodos ni flechas                                                                | Flechas y `function` asignadas a `const`, corregido; los métodos quedan anotados |
| P3  | `inspect:cc53` y ADJUST                                                                                 | Sin efecto: la consulta filtra IN/OUT                                            |
| P3  | Fechas del caso real en los specs                                                                       | Corregido: pasan a marzo–mayo y se quita «como en el caso real»                  |
| P3  | El plan es más estricto si una salida previa del plan dejara un negativo                                | Hoy no ocurre (`acceptedOuts` filtra); queda anotado                             |
