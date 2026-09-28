# Revisión de segundo modelo — diagnóstico de LOG-2 y LOG-3 (2026-09-28)

Revisor: Sonnet, contexto limpio, solo lectura. Objeto: `docs/analisis/log-2-log-3-diagnostico.md`.
No es revisión independiente (AGENTS.md §2.2): la cierra el dueño.

**Veredicto del revisor:** técnicamente sólido; citas y aritmética verifican; un P1 omitido.

## P0

Ninguno. Las causas raíz de LOG-3 y LOG-2, la cadena 98 ÷ 3 → 38.5467 → 32.6667 → 98.0001, el
total 3,325.0020 → IGV 598.5004 → 3,923.5024 y la ausencia de `number` verifican exactas.

## P1 — el diálogo de cobro compara contra el saldo crudo

`apps/web/src/app/(app)/comprobantes/[id]/comprobante-detalle-view.tsx:1483-1490` deshabilita
«Registrar cobro» si el monto supera `d.balancePen` (4 decimales), no `payableBalance` (D-169). Para
un comprobante con cola `50`–`99`, teclear el importe del papel (redondeado hacia arriba) deja el
botón gris: el documento decía que ese caso «cierra». Además, la propuesta A omitía ese punto.

**Resolución:** corregido en el diagnóstico (guion de la reunión, §Por qué queda saldo, §Conteos y
propuesta A con el quinto punto). Verificado por la sesión en el código antes de corregir.

## P2 — citas de línea corridas

`sales-document-form.tsx:649-653` → 649-654, `:664` → 665, `:382-385` → 383-386;
`roofing-production.service.ts:1418-1419` → 1420-1421. **Resolución:** corregidas.

## Verificado sin discrepancias (según el revisor)

Todas las demás citas de LOG-3 y LOG-2, el hallazgo lateral de `readiness` (no se lee en el web), el
uso de `cents()` solo en compras, y la coherencia interna de los conteos (22 + 11 = 33; 18 + 11 = 29;
partición 14 / 15).
