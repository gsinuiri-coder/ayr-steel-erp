import { cn } from '@/lib/utils';

/** cc31: el sello AYR del menú, del ingreso y de las páginas de error, en un solo lugar. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground',
        className,
      )}
    >
      AYR
    </span>
  );
}
