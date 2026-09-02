'use client';

import Link from 'next/link';
import { ImportEntity } from '@ayr/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ImportDialog } from '@/components/imports/import-dialog';
import { IMPORT_COLUMNS } from '@/components/imports/import-columns';

/** RF-12: alta masiva de bobinas desde planilla, con revisión fila por fila. */
export function ImportarBobinasView() {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Importar bobinas</h1>
          <p className="text-sm text-muted-foreground">
            Carga histórica desde planilla (RF-12). Cada fila crea una bobina con su código RF-13 y
            su entrada de kardex; no genera compra ni cuenta por pagar.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/bobinas">Volver a bobinas</Link>
        </Button>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">Columnas esperadas</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            {IMPORT_COLUMNS[ImportEntity.COILS].map((c) => (
              <li key={c.key}>{c.label}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            El proveedor se identifica por su código corto y el acabado por su código. El costo por
            kg va sin IGV (D-038). El tipo de cambio solo hace falta si la bobina está en dólares.
          </p>
          <div>
            <ImportDialog entity={ImportEntity.COILS} invalidateQueryKey={['coils']} />
          </div>
        </CardContent>
      </Card>
    </>
  );
}
