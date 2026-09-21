# UAT: RF-S3C - Panel y Alcance del Vendedor

## Objetivo
Verificar que un usuario con rol `VENDEDOR` está confinado a su propio universo comercial (solo puede ver y operar sobre las cotizaciones, reservas, despachos y comprobantes en los que figure como dueño). Además, validar el correcto funcionamiento de las 4 tarjetas (Dashboard cards) que muestran sus métricas y alertas.

## Entorno
- Rama: `rf-s3c`
- Datos: Entorno local / CI.
- Actores necesarios: 
  - Vendedor A (`vendedorA@test.com`)
  - Vendedor B (`vendedorB@test.com`)
  - Administrador (`admin@test.com`)

## 1. Confinamiento de Alcance (M0/M1)
1. Iniciar sesión como Vendedor A.
2. Ingresar a `Ventas > Cotizaciones`. Verificar que **solamente** se listan cotizaciones del Vendedor A.
3. Intentar acceder directamente por URL a una cotización que pertenece al Vendedor B (`/ventas/cotizaciones/{id}`). El sistema debe bloquear el acceso o mostrar error de permisos (404/403).
4. Duplicar una cotización del Vendedor A. La nueva cotización debe crearse asignada al Vendedor A, nunca a B.
5. Iniciar sesión como Administrador y verificar que el listado de cotizaciones sí muestra todos los registros de todos los vendedores.
6. Probar las exportaciones (Excel/PDF) y confirmar que la información descargada respeta las mismas políticas de visibilidad.

## 2. Dashboard - Panel del Vendedor (M3)
1. Iniciar sesión como Vendedor A y permanecer en la vista de inicio (`/`).
2. Verificar que se renderizan **exclusivamente** las 4 tarjetas del vendedor (o al menos verificar que el API `/sales/dashboard` responde con los datos correctos):
   - Cotizaciones por vencer (en estado DRAFT, a vencer en los próximos 3 días hábiles).
   - Reservas temporales por expirar (en estado ACTIVE, a expirar en los próximos 3 días).
   - Pedidos en producción (que cuenten con al menos una orden de producción de cobertura en estado IN_PROGRESS).
   - Pedidos listos para despacho (órdenes de producción asociadas están terminadas).
3. Asegurarse de que el Vendedor A NO ve las tarjetas exclusivas de Administrador (como falta de stock general).
4. Validar que los valores de cada tarjeta corresponden exactamente a las entidades cuyo `sellerId` es del Vendedor A.

## 3. Reasignación de Cotizaciones (M4)
1. Iniciar sesión como Administrador.
2. Enviar una petición (vía API o UI si se adaptó) para reasignar una cotización del Vendedor A al Vendedor B, adjuntando un motivo.
3. Comprobar que:
   - La cotización ahora pertenece al Vendedor B.
   - Cualquier pedido derivado (`sales_orders`) también ha cambiado su `sellerId` al del Vendedor B.
   - Revisar la base de datos (o la UI de auditoría si está expuesta) y confirmar que se registró el evento `sales.quotation.reassign` en `audit_log` con el motivo indicado.
