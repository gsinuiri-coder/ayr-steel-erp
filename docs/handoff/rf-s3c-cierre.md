# Cierre de sesión rf-s3c

## Resumen de la sesión

Se abordaron y solucionaron las fallas remanentes del pull request #7 (RF-S3c), relacionadas con
el enmascaramiento de entidades comerciales (alcance de vendedor) y el acceso a lectura.

## Logros e implementaciones

- **Alcance comercial de vendedor**: se corrigió `assertSellerAccess` para que aplique
  **únicamente** cuando el actor sea `VENDEDOR`. De esta forma, los roles operativos (como
  `SUPERVISOR_PLANTA`) pueden volver a leer y gestionar OPs sobre pedidos que no crearon,
  reparando la regresión y el fallo crítico en `planta-acceso-super-f8s3c.spec.ts`.
- **Restauración de visibilidad de vendedor**: se revirtió la inyección de `assertSellerAccess`
  en los métodos de lectura `findOne` de `QuotationsService`, `SalesOrdersService` y
  `DispatchesService` que no estaban contemplados en el alcance S3c, permitiendo que el vendedor
  siga teniendo la vista de detalle cuando conoce el ID directo, que es lo que exige el test «un
  vendedor lee la cotización de otro pero no la edita».
- **Kardex y visibilidad de costos**: se restauró `CoilsController` a `origin/main`
  (`@Roles(Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA)`), retirando el acceso de `VENDEDOR`.
  Esto corrige el test de la regla §3.4 que afirma que «el detalle de la bobina, que lleva el
  costo de compra por kilo, le está cerrado por completo» al vendedor
  (`fase2b.spec.ts:1369`).
- **Dashboard del vendedor**: se corrigió un crash (500) en `DashboardService` provocado por
  pasar un string crudo (p. ej. `"2026-09-24"`) a un campo `DateTime?` (`validUntil`) en la
  consulta a Prisma. Se construyó el objeto `Date` ISO-8601 válido, solucionando la falla
  indirecta en `alcance-vendedor-ui.spec.ts`.
- **Tests E2E**: se actualizaron y limpiaron los asserts de `fase5a-bordes.spec.ts` y otros tests
  para alinear las expectativas de 404 (ocultamiento por `assertSellerAccess`) en operaciones de
  escritura, y 200/400 donde correspondía.
- **RF-S3b, explicación del fallo (kardex ascendente)**: se corrige la explicación previa — el
  proyecto **no usa SQLite**. El fallo original ocurrió porque las pruebas corrían contra
  **PostgreSQL** y los movimientos se generaban con el mismo `operationDate`, por lo que el orden
  por defecto era inestable; se reparó introduciendo el orden determinista
  (`operationDate ASC, createdAt ASC, id ASC`).

## Decisiones registradas

- **D-238**: cambio de roles de agentes por saldo (Antigravity principal, Claude Code revisor).
- **D-239**: el Panel del vendedor expone sus métricas mediante `$queryRaw` parametrizado.
- El alcance del rol VENDEDOR es estrictamente cerrado en las vistas de lista y en las métricas
  de negocio. No se bloqueó la vista de detalle (`findOne`) si se conoce el identificador. Las
  operaciones mutables sobre entidades ajenas devuelven 404 (`NotFoundException`) en lugar de 403.

## Correcciones aplicadas en el pre-vuelo de la ventana (2026-09-22)

Este handoff afirmaba dos cosas que no coincidían con el repositorio. Quedan corregidas arriba y
se anotan acá para que el error no se propague:

1. **La columna `seller_id` va en `quotations` y `sales_orders`, no en `fiscal_documents`.** La
   migración real es `20260920120000_rf_s3c_seller_scope` y no toca la tabla de comprobantes: el
   alcance se resuelve por la cotización o el pedido. El checklist de `docs/ENTORNOS.md` repetía
   el mismo error y también quedó corregido.
2. **La numeración de las decisiones estaba cruzada.** Lo que este documento llamaba D-238 y
   D-239 (política de alcance y columna redundante) no son las decisiones que lleva esos números
   en `docs/ARQUITECTURA.md` §0.2. Además, D-238 y D-239 estaban pegadas al final de
   `ARQUITECTURA.md` como filas sueltas, fuera de la tabla de §0.2 y sin encabezado, así que no
   renderizaban; se movieron a la tabla.

Adicionalmente, el pre-vuelo encontró un defecto en el backfill que se corrigió antes de
desplegar: escribía `sales_orders.seller_id = created_by_id`, una regla distinta de la que aplica
el API al confirmar. Ver **D-240** y **D-241** en `docs/ARQUITECTURA.md` §0.2 y el checklist de
`docs/ENTORNOS.md`.

## Checklist de ventana S3c

Vive en `docs/ENTORNOS.md`, sección «Checklist de Ventana S3c», con los comandos exactos del
backfill y el orden de despliegue. En resumen: respaldo Neon → ensayo en el clon → aviso a
vendedores → migración → **backfill antes del deploy del API** → API → web → segunda pasada del
backfill en dry-run → `pnpm smoke:prod`.
