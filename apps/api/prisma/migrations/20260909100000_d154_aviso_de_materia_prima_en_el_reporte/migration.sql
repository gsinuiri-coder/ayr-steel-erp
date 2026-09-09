-- D-154: el aviso del agregado de materia prima —y la desviación del kilo declarado— quedan
-- anotados en la fila del reporte, no solo en `audit_log`. Aditiva y nullable: todo reporte
-- anterior a esta decisión no tenía nada que avisar y queda en NULL, que es la verdad.
ALTER TABLE "production_reports" ADD COLUMN "raw_material_warning" TEXT;
