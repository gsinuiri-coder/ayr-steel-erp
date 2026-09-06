'use client';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

interface PaginationBarProps {
  page: number;
  pageSize: number;
  /** Total real de filas que cumplen el filtro, no solo las de esta página. */
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** Se apaga mientras la página siguiente todavía está en vuelo (evita doble clic). */
  disabled?: boolean;
}

/**
 * Barra de paginación server-side (Fase 7d, D-113), igual en las diez tablas que la usan:
 * "Mostrando X–Y de Z", tamaño de página y anterior/siguiente. No se sabe si hay página
 * siguiente contando filas devueltas —una página llena y la última página llena se ven
 * igual—, así que todo sale de comparar contra `total`.
 */
export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  disabled = false,
}: PaginationBarProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-1 py-3 text-sm text-muted-foreground">
      <span>{total === 0 ? 'Sin filas que mostrar' : `Mostrando ${from}–${to} de ${total}`}</span>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span>Filas por página</span>
          <Select
            value={String(pageSize)}
            onValueChange={(v) => {
              onPageSizeChange(Number(v));
            }}
          >
            <SelectTrigger className="w-20" aria-label="Filas por página">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || page <= 1}
            onClick={() => {
              onPageChange(page - 1);
            }}
          >
            Anterior
          </Button>
          <span className="px-2 tabular-nums">
            Página {page} de {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || page >= totalPages}
            onClick={() => {
              onPageChange(page + 1);
            }}
          >
            Siguiente
          </Button>
        </div>
      </div>
    </div>
  );
}
