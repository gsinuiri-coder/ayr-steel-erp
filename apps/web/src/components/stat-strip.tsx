import { cn } from '@/lib/utils';

/**
 * La tira de cifras de cabecera de una pantalla de detalle (emisión, subtotal, IGV, total…).
 *
 * S11/B1: antes cada cifra era una `Card` propia dentro de un `grid md:grid-cols-4`, el
 * mismo bloque copiado en seis vistas. Cuatro tarjetas de 76 px de alto para cuatro datos
 * de una línea es la parte de la pantalla que menos información daba por píxel, y encima
 * cada vista lo escribía a mano, así que ninguna se veía exactamente igual que la otra.
 *
 * Un solo recuadro con separadores dice lo mismo en ~50 px y se lee como un tablero: la
 * cifra manda y el rótulo la acompaña, no al revés.
 */
export function StatStrip({ className, ...props }: React.ComponentProps<'dl'>) {
  return (
    <dl
      data-slot="stat-strip"
      className={cn(
        'grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-lg bg-card ring-1 ring-foreground/10 sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-4',
        className,
      )}
      {...props}
    />
  );
}

export function Stat({
  label,
  children,
  className,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 px-3 py-2', className)}>
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      {/* Sin `truncate`: hay tiras donde una celda lleva dos líneas (el conductor de una
          guía, el número de comprobante con su estado) y cortarlas escondería el dato. */}
      <dd className="text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}
