'use client';

import Link from 'next/link';
import { ImportEntity, Role } from '@ayr/shared';
import { Button } from '@/components/ui/button';
import { RoleGate } from '@/components/role-gate';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ImportDialog } from '@/components/imports/import-dialog';
import { IMPORT_COLUMNS } from '@/components/imports/import-columns';

/** RF-12: alta masiva de bobinas desde planilla, con revisión fila por fila. */
export function ImportarBobinasView() {
  return (
    <RoleGate allow={[Role.ADMINISTRADOR]}>
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

      {/*
        D-137: la carga con el Excel real del negocio. Va **primero** porque es la que el
        dueño usa: la planilla canónica de RF-12 queda debajo, para una carga puntual con el
        formato del sistema.
      */}
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">Desde el Excel del negocio</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            El archivo con el que llevás las bobinas, tal como está: acabado, RUC y nombre del
            proveedor, número de factura, fecha de compra, espesor, ancho, peso de compra, stock
            actual, costo por kg, valorización, moneda, tipo de cambio, estado y observaciones.
          </p>
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            <li>
              El proveedor que falte se crea solo con su RUC; si el padrón de SUNAT no responde, se
              crea con el nombre del archivo y queda marcado <strong>por completar</strong>.
            </li>
            <li>
              Un acabado que no esté en el maestro <strong>no se inventa</strong>: la fila queda
              marcada y lo elegís de la lista en la previsualización.
            </li>
            <li>
              El número de factura y la moneda original van a las observaciones de la bobina. La
              carga histórica no reconstruye compras: las nuevas sí se registran en Compras.
            </li>
          </ul>
          <div>
            <ImportDialog
              entity={ImportEntity.COILS_HISTORY}
              invalidateQueryKey={['coils', 'inventory']}
              label="Importar desde el Excel"
            />
          </div>
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">Planilla del sistema (RF-12)</CardTitle>
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
            <ImportDialog
              entity={ImportEntity.COILS}
              invalidateQueryKey={['coils', 'inventory']}
              label="Importar planilla"
            />
          </div>
        </CardContent>
      </Card>
    </RoleGate>
  );
}
