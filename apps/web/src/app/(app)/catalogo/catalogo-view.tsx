'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BusinessLine,
  BUSINESS_LINE_LABELS,
  ImportEntity,
  PRODUCT_SOURCE_LABELS,
  ProductSource,
  Role,
  Unit,
  type BusinessLineDto,
  type ProductDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ImportDialog } from '@/components/imports/import-dialog';
import { ColorSwatch } from '@/components/colors/color-swatch';
import { BomDialog } from './bom-dialog';
import { ColoresPanel } from './colores-panel';
import { ProductDialog } from './product-dialog';

/**
 * Qué productos llevan receta (D-059, D-087). Las mismas condiciones que valida
 * `BomsService.upsert`, para no ofrecer un diálogo que el API va a rechazar al guardarlo:
 *
 * - **Drywall**: perfil fabricado y activo, medido en piezas (`NIU`, D-055).
 * - **Coberturas** (Fase 6): fabricado y activo, en piezas si es plancha de catálogo o en
 *   metros (`MTR`) si es a medida (D-083).
 */
function hasBom(product: ProductDto): boolean {
  if (product.source !== ProductSource.MANUFACTURED || !product.isActive) return false;
  if (product.businessLineCode === BusinessLine.DRYWALL) return product.unit === Unit.NIU;
  if (product.businessLineCode === BusinessLine.METALLIC_ROOFING) {
    return product.unit === Unit.NIU || product.unit === Unit.MTR;
  }
  return false;
}

/** El color solo tiene sentido donde hay material prepintado: coberturas (D-085). */
function usesColor(lineCode: BusinessLine): boolean {
  return lineCode === BusinessLine.METALLIC_ROOFING;
}

const CATALOG_QUERY_KEY = ['catalog'] as const;

/** RF-50: catálogo por línea, en tabs. */
export function CatalogoView() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [dialog, setDialog] = useState<{
    open: boolean;
    product?: ProductDto;
    lineId: string;
    nonce: number;
  }>({ open: false, lineId: '', nonce: 0 });
  const [bomProduct, setBomProduct] = useState<ProductDto | null>(null);

  const lines = useQuery({
    queryKey: ['business-lines'],
    queryFn: () => api<BusinessLineDto[]>('/business-lines'),
  });
  const products = useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: () => api<ProductDto[]>('/catalog'),
  });

  const openDialog = (lineId: string, product?: ProductDto) => {
    setDialog((d) => ({ open: true, product, lineId, nonce: d.nonce + 1 }));
  };

  const toggleActive = useMutation({
    mutationFn: (p: ProductDto) =>
      api<ProductDto>(`/catalog/${p.id}`, { method: 'PATCH', body: { isActive: !p.isActive } }),
    onSuccess: (updated) => {
      toast.success(updated.isActive ? 'Producto activado' : 'Producto desactivado');
      void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo actualizar'),
  });

  if (lines.isPending || products.isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (lines.isError || products.isError || !lines.data) {
    return <p className="text-destructive">No se pudo cargar el catálogo.</p>;
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Catálogo</h1>
          <p className="text-sm text-muted-foreground">Productos por línea de negocio (RF-50).</p>
        </div>
        {isAdmin && (
          <ImportDialog entity={ImportEntity.PRODUCTS} invalidateQueryKey={CATALOG_QUERY_KEY} />
        )}
      </div>

      <Tabs defaultValue={lines.data[0]?.id}>
        <TabsList>
          {lines.data.map((l) => (
            <TabsTrigger key={l.id} value={l.id}>
              {BUSINESS_LINE_LABELS[l.code]}
            </TabsTrigger>
          ))}
          <TabsTrigger value="colores">Colores</TabsTrigger>
        </TabsList>
        <TabsContent value="colores">
          <ColoresPanel isAdmin={isAdmin} />
        </TabsContent>
        {lines.data.map((line) => {
          const lineProducts = products.data?.filter((p) => p.businessLineId === line.id) ?? [];
          return (
            <TabsContent key={line.id} value={line.id} className="grid gap-4">
              {isAdmin && (
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    onClick={() => {
                      openDialog(line.id);
                    }}
                  >
                    Nuevo producto
                  </Button>
                </div>
              )}
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Nombre</TableHead>
                      {usesColor(line.code) && <TableHead>Color</TableHead>}
                      <TableHead>Unidad</TableHead>
                      <TableHead>Origen</TableHead>
                      <TableHead>Estado</TableHead>
                      {isAdmin && <TableHead className="text-right">Acciones</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lineProducts.map((p) => (
                      <TableRow key={p.id} data-state={p.isActive ? undefined : 'inactive'}>
                        <TableCell className="font-medium">{p.sku}</TableCell>
                        <TableCell>{p.name}</TableCell>
                        {usesColor(line.code) && (
                          <TableCell>
                            <ColorSwatch
                              color={
                                p.colorId && p.colorName && p.colorHex
                                  ? { name: p.colorName, hexColor: p.colorHex }
                                  : null
                              }
                            />
                          </TableCell>
                        )}
                        <TableCell>{p.unit}</TableCell>
                        <TableCell>{PRODUCT_SOURCE_LABELS[p.source]}</TableCell>
                        <TableCell>
                          {p.isActive ? (
                            <Badge variant="secondary">Activo</Badge>
                          ) : (
                            <Badge variant="outline">Inactivo</Badge>
                          )}
                        </TableCell>
                        {isAdmin && (
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                openDialog(p.businessLineId, p);
                              }}
                            >
                              Editar
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={toggleActive.isPending}
                              onClick={() => {
                                toggleActive.mutate(p);
                              }}
                            >
                              {p.isActive ? 'Desactivar' : 'Activar'}
                            </Button>
                            {hasBom(p) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setBomProduct(p);
                                }}
                              >
                                Receta
                              </Button>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                    {lineProducts.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={(isAdmin ? 6 : 5) + (usesColor(line.code) ? 1 : 0)}
                          className="text-center text-muted-foreground"
                        >
                          Sin productos en esta línea.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          );
        })}
      </Tabs>

      {isAdmin && (
        <ProductDialog
          key={`${dialog.product?.id ?? 'nuevo'}-${dialog.nonce}`}
          open={dialog.open}
          businessLineId={dialog.lineId}
          usesColor={usesColor(
            lines.data.find((l) => l.id === dialog.lineId)?.code ?? BusinessLine.DRYWALL,
          )}
          product={dialog.product}
          onOpenChange={(open) => {
            setDialog((d) => ({ ...d, open }));
          }}
        />
      )}

      {isAdmin && bomProduct && (
        <BomDialog
          key={bomProduct.id}
          open
          product={bomProduct}
          onOpenChange={(open) => {
            if (!open) setBomProduct(null);
          }}
        />
      )}
    </>
  );
}
