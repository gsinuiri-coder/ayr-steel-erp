# Autorrevisión — cc08 / D-375

**Autorrevisión: lista de riesgos, no aprobación.** La hizo un subagente nuevo que no leyó el
handoff de implementación (AGENTS.md §2 regla 2.1).

- **Fecha:** 2026-10-01.
- **Rama:** `cc08/desanular-bobina`.

Resumen del informe. Cada hallazgo lleva lo que se hizo con él.

| Id   | Sev. | Hallazgo                                                                                                                                     | Qué se hizo                                                                                                                                                                                            |
| ---- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1-1 | P1   | `EN_SU_FECHA` duplica el saldo histórico entre el ingreso y la anulación. Coincide con el segundo modelo.                                    | **Corregido por decisión del dueño:** la entrada va en la fecha de la salida de anulación. Test de proyección por día.                                                                                 |
| P1-2 | P1   | El undo podía anular una bobina enviada a corte o montada en una OP: esas operaciones no mueven kardex.                                      | **Corregido:** el preflight exige `OPEN`, sin reservas y con `assertStripsNotAssigned`. Unitario con la bobina en corte tercerizado.                                                                   |
| P2-1 | P2   | El guard nuevo es global.                                                                                                                    | **Decisión del dueño:** queda global, con texto neutro. La suite E2E completa de la CI lo recorre en todos los caminos.                                                                                |
| P2-2 | P2   | Nada advierte de un posible duplicado físico.                                                                                                | Anotado. El dueño restaura solo la AZUL, que no tiene gemela. Las otras 8 se deciden aparte (análisis §«Foto de producción»).                                                                          |
| P2-3 | P2   | Se pierde el landed cost.                                                                                                                    | **Corregido:** bloquea con ajustes de costo.                                                                                                                                                           |
| P2-4 | P2   | Siempre vuelve `OPEN`.                                                                                                                       | Documentado en D-375. La AZUL estaba `OPEN` antes de anularse (auditoría `coils.cancel`).                                                                                                              |
| P2-5 | P2   | Huecos de test.                                                                                                                              | **Agregados:** proyección por día, undo con la bobina en corte, E2E con la compra anulada y 403 de un no administrador. La integración del guard con venta, partido y corte queda a la suite completa. |
| P3   | P3   | Hijas de partido o corte en el menú; la CLI no comparaba todo el plan; el plan del modal en caché; el análisis citaba el clasificador viejo. | **Corregido** lo de las hijas, la CLI y el modal; el análisis se actualizó. La fuente del piso histórico de la CLI de inspección (variable de entorno) queda anotada.                                  |
