-- RF-S2/M3 (D-220, hallazgo de auditor-seguridad): el visor filtra a menudo por tipo de
-- entidad SIN entityId (solo "Pedidos", sin un pedido puntual). El índice compuesto
-- (entity, entity_id, at) de la migración D-218 no sirve para ese caso: ordena primero por
-- entity_id, así que Postgres no puede devolver ya ordenado por at DESC para ese entity y
-- termina ordenando en memoria toda la tabla de esa entidad en el rango pedido (hasta 12
-- meses). Additive pura: un índice nuevo, nada se toca ni se borra.

CREATE INDEX "audit_log_entity_at_idx" ON "audit_log"("entity", "at");
