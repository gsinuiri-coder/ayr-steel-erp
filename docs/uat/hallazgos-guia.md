# UAT — Hallazgos de la guía (D-310 a D-312)

Producción, solo lectura: **mirar y no guardar**. Las dos bobinas y el pedido son datos reales.

## D-310 — la bobina atada no se ofrece

1. **Cotizaciones → Nueva cotización** → **Línea de negocio: Bobina completa (venta directa)**.
2. En la ventana **Elegir bobina · venta directa**, debajo de las disponibles, la sección **No se
   ofrecen** trae:
   - `SALDO-ALZ-AZUL-5002-0.38-4194-7` — atada a **COT-000002**
   - `SALDO-ALZ-ROJO-3020-0.38-3840-12` — atada a **COT-000011**
3. Cerrar la ventana sin elegir. Esas dos bobinas **no** están entre las que tienen el botón **Elegir**.
4. (Demo) Con una cotización abierta que venda una bobina entera: crear otra con la misma bobina
   por la API o duplicar la primera → 400 «… no se puede vender: atada a COT-… (otra cotización
   abierta la vende entera)». Anular la primera la libera.

## D-311 — pedido entregado por un despacho

1. **Pedidos → Atendidos** → abrir **PED-000028**.
2. Arriba dice **«Entregada en DES-000009»** (con enlace al despacho). **No** dice que las reservas
   fueron consumidas por producción.
3. En **Reservas de material**, la columna **Orden o entrega** dice **«Entregada en DES-000009»** en
   las dos filas (UPVC36MT y UPVC6MT), no «—».

## D-312 — «Despachar» solo con algo pendiente

1. En **PED-000028** (Atendido) no hay botón **Despachar**.
2. En un pedido en curso con algo por despachar (por ejemplo, uno **Listo**, como PED-000004) el
   botón **Despachar** sí está.
