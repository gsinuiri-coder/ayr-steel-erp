import { cn } from '@/lib/utils';

/**
 * La tira de cifras de cabecera de una pantalla de detalle (emisión, subtotal, IGV, total…).
 *
 * S11/D-179: antes cada cifra era una `Card` propia dentro de un `grid md:grid-cols-4`, el
 * mismo bloque copiado en seis vistas. Cuatro tarjetas de 76 px de alto para cuatro datos
 * de una línea es la parte de la pantalla que menos información daba por píxel, y encima
 * cada vista lo escribía a mano, así que ninguna se veía exactamente igual que la otra.
 *
 * Un solo recuadro con separadores dice lo mismo en ~50 px y se lee como un tablero: la
 * cifra manda y el rótulo la acompaña, no al revés.
 *
 * Las líneas divisorias son `gap-px` sobre el color del borde y no `divide-*`: con `divide`
 * la celda que envuelve a una fila nueva queda sin su línea de arriba, y la tira se ve rota
 * en cuanto hay más celdas que columnas. Es además el mismo recurso que ya usa la tira de
 * `/planta` (`MiniStat`), así que las dos se ven igual.
 *
 * El precio de ese recurso: el fondo de la tira **es** el color del borde, así que una
 * columna sin celda se ve como un bloque gris. Quien pase un `grid-cols-*` propio tiene que
 * hacerlo coincidir con cuántas celdas hay de verdad, incluidas las condicionales.
 */
export function StatStrip({ className, ...props }: React.ComponentProps<'dl'>) {
  return (
    <dl
      data-slot="stat-strip"
      className={cn(
        'grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-border ring-1 ring-foreground/10 sm:grid-cols-3 lg:grid-cols-4',
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
  /** Clase para **la cifra**, no para la celda: es lo único que cada vista quiere retocar. */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 bg-card px-3 py-2">
      <dt
        className="truncate text-xs text-muted-foreground"
        title={typeof label === 'string' ? label : undefined}
      >
        {label}
      </dt>
      {/* Sin `truncate`: hay tiras donde una celda lleva dos líneas (el conductor de una
          guía, el número de comprobante con su estado) y cortarlas escondería el dato. */}
      <dd className={cn('text-sm font-medium tabular-nums', className)}>{children}</dd>
    </div>
  );
}
