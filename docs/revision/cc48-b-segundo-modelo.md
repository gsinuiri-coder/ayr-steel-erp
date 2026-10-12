# Revisión del segundo modelo — cc48 corte B

**Alcance revisado:** `cc48-a-restos...cc48-b-auditoria` (5d3a8228, 98fed705, 56bce112, c31d44c1; 16
archivos, +1706/−270). Solo por referencias de git; sin ejecutar nada.

## P0

Ninguno.

## P1

1. **Buscar un correlativo que no existe da 500 (`Prisma.join([])`).** `searchEntityIds` guardaba el tipo
   aunque no hubiera filas (`['sales_orders', []]`), y `searchAuditLog` armaba `entity_id IN (…)` con la
   lista vacía: `PED-999999` → 500 en la pantalla y en el Excel. La rama SQL del buscar no tenía prueba.

## P2

1. **Con `entityType` y buscar, los cambios de precio se escapaban del tipo filtrado** (filtro
   «Pedidos» + buscar `COT-5` traía cambios de la cotización).
2. **El Excel resolvía el buscar en cada página** (25 páginas × 7 consultas de «contiene»).
3. **Tope de 200 ids por tipo sin orden ni aviso.**

## P3

1. `before::text ILIKE` coincide con los nombres de las claves del JSON («status» encuentra casi todo).
2. `SEQ_CODE_RE` toma `op-1` o `cot12` como correlativo y no lo busca como código de bobina o SKU.
3. Un cursor con `id` no numérico en `audit_log` da 500 en vez de 400 (ya existía).
4. «Últimos 31 días» son 32 días calendario (`today − 31` hasta hoy).
5. El E2E no ejercitaba el texto del detalle, el correlativo inexistente ni el aviso de más de 31 días.

## Verificado sin defectos

Sin inyección SQL (todo por `Prisma.sql` parametrizado; `likePattern` escapa `% _ \`); la rama SQL y la
rama Prisma paginan igual; una consulta por tipo; permisos de clase cubren `/audit/xlsx`; D-635 da 12
meses exactos; pantalla y Excel comparten el esquema de filtros.

## Conclusión

No mergear hasta corregir P1-1 y agregar su test; P2-1 en el mismo cambio.

## Qué se hizo (sesión)

- P1-1: corregido. Un tipo sin coincidencias no entra al mapa, y `searchAuditLog` descarta listas vacías;
  pruebas del correlativo inexistente (`audit-entity-refs.spec.ts` y `audit-query.service.spec.ts`).
- P2-1: corregido. Con `entityType=sales_orders` solo cuentan pedidos; con `quotations`, solo cotizaciones.
- P2-2: corregido. `exportAll` resuelve el buscar una vez y lo pasa a cada página (prueba).
- P2-3: corregido. Orden fijo por id, tope + 1 para saberlo y aviso en la pantalla (`searchCapped`).
- P3-5: el E2E ahora cubre el Excel y el aviso de periodo largo; el correlativo inexistente, en unitarios.
- P3-1, P3-2, P3-3 y P3-4: anotados en el informe.
