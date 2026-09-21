# Cierre de sesi�n rf-s3c

## Resumen de la sesi�n

Se abordaron y solucionaron las fallas remanentes del pull request #7 (RF-S3c), relacionadas con el enmascaramiento de entidades comerciales (alcance vendedor) y el acceso a lectura.

## Logros e implementaciones

- **Alcance Comercial Vendedor**: Se corrigi� `assertSellerAccess` para que aplique **�nicamente** cuando el actor sea `VENDEDOR`. De esta forma, roles operativos (como `SUPERVISOR_PLANTA`) pueden volver a leer y gestionar OPs sobre pedidos que no crearon, reparando la regresi�n y el fallo cr�tico en `planta-acceso-super-f8s3c.spec.ts`.
- **Restauraci�n de Visibilidad de Vendedor**: Se revirti� la inyecci�n de `assertSellerAccess` en los m�todos de lectura `findOne` de `QuotationsService`, `SalesOrdersService` y `DispatchesService` que no estaban contemplados en el alcance S3c, permitiendo que el vendedor siga teniendo la vista de detalle cuando conoce el ID directo, lo cual es requerido por el test "un vendedor lee la cotizaci�n de otro pero no la edita".
- **Kardex y Visibilidad de Costos**: Se restaur� `CoilsController` a `origin/main` (`@Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)`), retirando el acceso de `VENDEDOR`. Esto corrige el test de la regla �3.4 que afirma que "el detalle de la bobina, que lleva el costo de compra por kilo, le est� cerrado por completo" al vendedor (test `fase2b.spec.ts:1369`).
- **Dashboard Vendedor**: Se corrigi� un crash (500) en `DashboardService` provocado por pasar un string crudo (ej. `"2026-09-24"`) a un campo `DateTime?` (`validUntil`) en la consulta a Prisma. Se construy� el objeto Date v�lido ISO-8601, solucionando la falla indirecta en `alcance-vendedor-ui.spec.ts`.
- **E2E Tests**: Se actualizaron y limpiaron los asserts de `fase5a-bordes.spec.ts` y otros tests para alinear las expectativas de 404 (ocultamiento por `assertSellerAccess`) en operaciones de escritura, y 200/400 donde correspond�a.
- **RF-S3b Explicaci�n del fallo (Kardex Ascendente)**: Se corrige la explicaci�n previa � el proyecto **no usa SQLite**. El fallo original ocurri� porque las pruebas corr�an contra **PostgreSQL** y los movimientos se generaban con el mismo `operationDate`, por lo que el orden por defecto era inestable; esto se repar� introduciendo el orden determinista (`operationDate ASC, createdAt ASC, id ASC`).

## Decisiones registradas

- **D-238**: El alcance del rol VENDEDOR es estrictamente cerrado en las vistas de lista y m�tricas de negocio. Sin embargo, no se bloque� la vista de detalle (`findOne`) si se conoce el identificador. Las operaciones mutables sobre entidades ajenas devuelven 404 (NotFoundException) en lugar de 403.
- **D-239**: Las tablas `SalesOrder` y `FiscalDocument` ahora tienen una columna `seller_id` redundante para acelerar las consultas de alcance comercial.

## Checklist de Ventana S3c

- Respaldo Neon previo a la migraci�n (crear rama en DB pre-v4).
- Dry-run del backfill en `ensayo-s3c-20260920` (ya validado por el desarrollador).
- Orden estricto: Migrar (Aplica el `seller_id`) -> API (Habilita las reglas de validaci�n y ocultamiento 404) -> Web (Despliega Dashboard).
- Aviso a vendedores previo a la operaci�n.
