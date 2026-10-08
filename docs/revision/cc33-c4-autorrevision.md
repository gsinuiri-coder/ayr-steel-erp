# Autorrevisión cc33 corte 4

> **Autorrevisión**: lista de riesgos, no aprobación. La hizo un subagente que no implementó el
> cambio ni leyó su handoff. Commit `10283096` (`origin/cc33-c4`). Sin P0 ni P1.

## Hallazgos

- **P2-1.** El Excel de la lista de comprobantes seguía diciendo «Contado» (N8 incompleto).
- **P2-2.** Buscar con el número del papel (`00012345`) no encontraba una compra nueva guardada sin
  ceros.
- **P3-1.** El importador no avisa en la vista previa si `F001-00012` y `F001-12` están en el mismo
  archivo; el segundo choca al confirmar.
- **P3-2.** `comparableDocument` (D-352) no usa la regla nueva. Es un caso raro.
- **P3-3.** Casos raros: `00A1` → `A1`; el patrón acepta solo separadores.
- **P3-4.** `assertNoLiveDocumentClash` trae las vivas de la serie. Rinde bien gracias al índice;
  la carrera con datos viejos es aceptable.
- **P3-5.** Fuera de lo pedido:
  - el `isoDateSchema` del tipo de cambio solo valida formato;
  - el estado de cuenta del proveedor rotula «Contado» una compra CREDITO sin días de crédito.
- **P3-6.** El E2E del pago no verifica el mensaje.

## Verificado sin hallazgos

- Las copias del formato están cubiertas. El web del importador no valida el número por su cuenta.
- La transformación del schema es segura, y el importador normaliza en el servicio.
- El XML sigue leyendo los ID de SUNAT.
- N8 queda bien en los cuatro lugares pedidos; `creditWithoutDueCount` es correcto.
- N5 no toca ventas ni comprobantes, y los importadores convierten el `null` en un error visible.
- Los tests nuevos prueban lo que dicen.

## Qué se hizo con cada hallazgo

| Hallazgo | Resolución                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-1     | Corregido (también lo marcó el segundo modelo).                                                                                             |
| P2-2     | Corregido: la búsqueda también compara el número normalizado; lo cubre el E2E.                                                              |
| P3-1     | Sin cambio: normalizar la clave del archivo cambiaría cómo se agrupan las filas en un mismo papel. El choque se rechaza igual al confirmar. |
| P3-2     | Sin cambio (caso raro, D-352).                                                                                                              |
| P3-3     | Corregido: el patrón exige letra o dígito, y los ceros se quitan solo en números de dígitos (D-538).                                        |
| P3-4     | Aceptado (D-538).                                                                                                                           |
| P3-5     | Fuera de la pieza: queda para el dueño.                                                                                                     |
| P3-6     | Corregido.                                                                                                                                  |
