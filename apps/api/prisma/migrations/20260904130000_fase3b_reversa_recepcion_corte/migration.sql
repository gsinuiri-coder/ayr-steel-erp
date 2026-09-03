-- Fase 3b: reversa de recepción de corte tercerizado (RF-41 a la inversa), simétrica a
-- RF-16 (revertir un partido). `cutting_order_coils` gana el rastro de la última reversa;
-- la fila vuelve a `SENT` y `CuttingService.receive` limpia estos campos si se recibe de
-- nuevo después.
--
-- Nota: escrita a mano (no via `prisma migrate dev`) porque el shadow database de Prisma
-- reproduce las migraciones en el orden alfabético de su carpeta, y la carpeta de Fase 3
-- (`20260903031603_fase3_corte_flejes`) quedó nombrada con una fecha anterior a las de
-- Fase 2a/2b (`20260903120000`/`20260904120000`) aunque depende de tipos que esas crean
-- (`CoilStatus`). El historial real de aplicación en cada rama de Neon es el correcto
-- (Fase 3 se aplicó ahí después de Fase 2a/2b); solo el reproceso desde cero en un shadow
-- db nuevo falla. Documentado en `docs/PROGRESO.md`.

-- AlterTable
ALTER TABLE "cutting_order_coils" ADD COLUMN "reverted_by_id" UUID,
ADD COLUMN "reverted_at" TIMESTAMPTZ(3);
