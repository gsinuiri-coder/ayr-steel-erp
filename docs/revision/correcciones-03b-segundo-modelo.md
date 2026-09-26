# Revisión — correcciones 03b (faltante D-341, piso de drywall D-342, subtipo accesorio D-343, formularios M4)

Rango: `origin/main...feat/correcciones-03b` (commits `56d78eb` a `d19b453`; las correcciones de esta revisión van en
el commit posterior). Dos pases, **los dos por subagentes**:

- **Autorrevisión**: subagente nuevo del mismo modelo que escribió, sin leer el handoff. **No vale como pase
  independiente**; es una lista de riesgos para quien revise después.
- **Segundo modelo**: subagente con `model: sonnet` y contexto limpio, solo lectura. **Tampoco vale como pase
  independiente** (misma sesión, misma orquesta). Revisión del dueño: pendiente (ver `docs/PROGRESO.md`).

Ninguno de los dos encontró **P0** (ni corrupción de kardex, ni brecha de permisos, ni migración peligrosa). Los
dos verificaron leyendo código; ninguno ejecutó pruebas ni tocó bases.

## Resumen y respuesta

| Id                | Sev | Hallazgo                                                                                                                       | Respuesta                                                                                                                                                                                                                                                                                          |
| ----------------- | --- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SM P1-1 / AR P1-2 | P1  | El faltante desaparece de la vista, de la tarjeta y de «Completar reserva» cuando la reserva pasa a CONSUMED.                  | **Corregido.** `sumShortfalls` solo omite RELEASED; `completeReservation` admite filas ACTIVE y CONSUMED (la revive a ACTIVE); `findOrdersWithShortfall` y el DTO usan la misma regla. Los tests que fijaban lo contrario se reescribieron.                                                        |
| AR P1-1 / SM P2-1 | P1  | La reversa de un reporte o de un despacho restaura la reserva sin tope y, con faltante, deja `qty` por encima de lo prometido. | **Corregido.** `restoreReservationQty` topa lo restaurado en `reserveQty − shortfallQty` cuando hay faltante. Tests del tope y de que sin faltante el comportamiento no cambia.                                                                                                                    |
| AR P2-1           | P2  | Cambiar la cantidad de una línea con faltante pone el faltante en 0 sin rastro.                                                | **Corregido.** El `before` de la auditoría de la edición incluye `shortfallAudit(active)`.                                                                                                                                                                                                         |
| AR P2-2           | P2  | La reserva parcial también aplicaba a productos de catálogo con stock; el requisito era solo materia prima.                    | **Corregido.** La rama parcial es solo `RAW_MATERIAL`; en un producto con stock el faltante sigue siendo bloqueo. Test reescrito.                                                                                                                                                                  |
| AR P2-5           | P2  | El ancho del producto accesorio decide los kg reservados; producción usa el ancho de la bobina montada.                        | **Diferido, documentado.** Es la misma diferencia que ya existe entre el kg estimado de la reserva y el real de planta (D-165); el kardex sale con el ancho real. Va a la lista de decisiones abiertas para el dueño (handoff).                                                                    |
| AR P2-6 / P2-7    | P2  | (no verificados por el revisor)                                                                                                | El revisor los marcó «no verificados» y esta sesión no los reprodujo; el P2-7 (que no se identifica con el «P2-7» del segundo modelo) queda como riesgo abierto para el dueño.                                                                                                                     |
| SM P2-2           | P2  | `updatePlan` acepta un plan de largos en una OP de accesorio y el aviso se vuelve tope.                                        | **Corregido.** Guarda 400 en `updatePlan` para accesorios; test.                                                                                                                                                                                                                                   |
| SM P2-3           | P2  | `assertAccessorySku` prohibía cualquier SKU no-accesorio que empezara por `ACCES`, en cualquier línea.                         | **Corregido.** La regla es por línea (`lineCode`): solo coberturas reservan el prefijo; SKU de otras líneas no se tocan. Además 400 ante espesor inválido.                                                                                                                                         |
| SM P2-4           | P2  | «Sin costo de flejes» se mostraba también cuando falta el margen de la línea.                                                  | **Diferido, documentado.** `NO_STRIP_COST` sale cuando la receta es `STRIP_RECIPE` y no hay piso; si la causa fuera un margen sin configurar en `pricing_settings`, el texto («Sin costo de flejes: sin piso», fijado por el dueño) no la distingue. Va a la lista de puntos abiertos del handoff. |
| SM P2-5           | P2  | Editar la cantidad de una línea de un pedido con faltante exige todo el material.                                              | **Diferido, documentado.** Es coherente con D-054/D-186: la edición vuelve a reservar el 100 %; dar «edición con faltante» es alcance nuevo (decisión del dueño, handoff punto abierto).                                                                                                           |
| SM P2-6           | P2  | La lectura del `before` de auditoría al liberar no tiene lock.                                                                 | **Aceptado.** La escritura está serializada por el lock del pedido y el `before` es informativo; no cambia ningún saldo. Anotado como riesgo bajo.                                                                                                                                                 |
| SM P2-7           | P2  | `AccessoryReportCard` no usaba `Button` con `pending`/`pendingText`.                                                           | **Corregido.** Los tres botones usan la propiedad centralizada; se quitó un bloque `{ <div/> }` sobrante.                                                                                                                                                                                          |
| SM P2-8           | P2  | El mensaje de anular una OP dice «N planchas» para un accesorio.                                                               | **Corregido.** Mensaje propio para accesorios.                                                                                                                                                                                                                                                     |
| SM P2-9           | —   | El cambio a la regla 2 de `AGENTS.md` no estaba entre los cuatro pedidos.                                                      | **Estaba pedido** en el Paso 0 de la sesión (nuevo estándar de revisión y registro de riesgo). Se deja para confirmación del dueño en el handoff, junto con la renumeración de la regla «por metro» (ahora 13, que el dueño llamó 14).                                                             |

Puntos que ambos revisaron y **no** tienen defecto: bloqueo del VENDEDOR (403 en el servicio, antes de la base; sin la
bandera todos rechazan; `GET orders/with-shortfall` y `POST complete-reservation` solo ADMINISTRADOR; no hay otro
camino que llame `createReservations` con `allowShortfall`); auditoría en la misma transacción en confirmar,
completar, anular y liberar; concurrencia de `completeReservation` (orden pedido → reservas → bobinas, sin ciclo);
migraciones (`20260926140000` aditiva con CHECK ≥ 0; `20260926150000` enum aparte de su uso; `20260926150100` con un
CHECK superconjunto del anterior y `pieces_hint` nullable), coinciden con `schema.prisma`; y el **censo** de
`sellsByLength` / `unit === 'MTR'` en `apps/`, `packages/` y `e2e/`: ningún sitio quedó mal clasificado respecto de un
accesorio.

## Después de las correcciones

- API: `typecheck`, `lint` y jest completo (128 suites, 1535 tests) en verde; web: `typecheck`, `lint` y vitest
  (69 tests) en verde; `prettier --check .` en verde.
- E2E local de las specs afectadas y de las nuevas (D-341, D-342, D-343, formularios): 66 de 67 pasan a la primera;
  el rojo (`huecos-cobertura-f8s2b`, «el picker de producto…») falla en `chooseOption` al elegir el cliente y
  **pasa aislado** (6 de 6): infraestructura (servidor de desarrollo lento tras 30 min), no producto. La suite
  completa la corre el runner de CI.
- Esto **no** sustituye una revisión con ojos frescos: las piezas de riesgo van a `docs/PROGRESO.md` como
  **PENDIENTE DE REVISIÓN DEL DUEÑO**.
