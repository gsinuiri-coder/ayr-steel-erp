'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BUSINESS_LINE_LABELS,
  BusinessLine,
  PRODUCT_SOURCE_LABELS,
  ProductSource,
  Role,
  ROOFING_PRODUCT_KIND_LABELS,
  Unit,
  type BusinessLineDto,
  type ProductDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { CATALOG_BAJO_PISO_VER_TODOS } from '@/lib/catalog-links';
import { useSession } from '@/lib/session';
import { sortRows } from '@/lib/sort-rows';
import { useSort } from '@/lib/use-sort';
import { useUrlSearchInput, useUrlState } from '@/lib/use-url-state';
import { SortableTableHead } from '@/components/sortable-table-head';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { ColorSwatch } from '@/components/colors/color-swatch';
import { BomDialog } from './bom-dialog';
import { ColoresPanel } from './colores-panel';
import { ProductDialog } from '@/components/catalog/product-dialog';
import { PriceListCell } from '@/components/catalog/price-list-cell';
import { PriceListHistoryDialog } from '@/components/catalog/price-list-history-dialog';

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
  const [historyProduct, setHistoryProduct] = useState<ProductDto | null>(null);
  // RF-S3/M4: el card «SKUs con lista bajo piso» del Panel enlaza acá con
  // `?bajoPiso=<productId>` — un id concreto resalta esa fila (y abre su línea), el valor
  // `1` (más de 8 en el card) solo llega a la vista sin resaltar nada en particular.
  const highlightProductId = useSearchParams().get('bajoPiso');
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  // Punto 13 del cliente (D-290): la búsqueda por SKU o nombre filtra en el cliente sobre
  // el catálogo ya cargado —no pagina (D-113)— y vive en la URL (`?q=`), con debounce de 150 ms.
  const [url, setUrl] = useUrlState({ q: '' });
  const [searchText, setSearchText, search] = useUrlSearchInput(
    url.q,
    (v) => {
      setUrl({ q: v });
    },
    150,
  );
  const needle = search.toLowerCase();
  // D-323: el catálogo no pagina; el orden por columna se hace sobre todo lo cargado.
  const [sort, toggleSort] = useSort<'sku' | 'name' | 'unit' | 'status' | 'price'>();

  const lines = useQuery({
    queryKey: ['business-lines'],
    queryFn: () => api<BusinessLineDto[]>('/business-lines'),
  });
  const products = useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: () => api<ProductDto[]>('/catalog'),
  });

  useEffect(() => {
    if (activeLineId !== null || !lines.data) return;
    const highlighted =
      highlightProductId && highlightProductId !== CATALOG_BAJO_PISO_VER_TODOS
        ? products.data?.find((p) => p.id === highlightProductId)
        : undefined;
    setActiveLineId(highlighted?.businessLineId ?? lines.data[0]?.id ?? null);
  }, [activeLineId, highlightProductId, lines.data, products.data]);

  useEffect(() => {
    if (!highlightProductId || highlightProductId === CATALOG_BAJO_PISO_VER_TODOS) return;
    document
      .getElementById(`catalog-row-${highlightProductId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightProductId, activeLineId]);

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
          <h1 className="text-lg font-semibold">Catálogo</h1>
          <p className="text-xs text-muted-foreground">Productos por línea de negocio (RF-50).</p>
        </div>
        {isAdmin && (
          <Button variant="outline" size="sm" asChild>
            <Link href="/catalogo/precios/importar">Cargar precios de lista</Link>
          </Button>
        )}
      </div>

      <Tabs value={activeLineId ?? lines.data[0]?.id} onValueChange={setActiveLineId}>
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
          const inLine = products.data?.filter((p) => p.businessLineId === line.id) ?? [];
          const searched = needle
            ? inLine.filter(
                (p) =>
                  p.sku.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle),
              )
            : inLine;
          const lineProducts = sortRows(searched, sort, {
            sku: { text: (p) => p.sku },
            name: { text: (p) => p.name },
            unit: { text: (p) => p.unit },
            status: { text: (p) => (p.isActive ? 'Activo' : 'Inactivo') },
            price: { decimal: (p) => p.listPricePen ?? '' },
          });
          return (
            <TabsContent key={line.id} value={line.id} className="grid gap-4">
              <div className="flex items-center justify-between gap-3">
                <Input
                  aria-label="Buscar productos por SKU o nombre"
                  placeholder="Buscar por SKU o nombre…"
                  className="max-w-xs"
                  value={searchText}
                  onChange={(e) => {
                    setSearchText(e.target.value);
                  }}
                />
                {isAdmin && (
                  <Button
                    size="sm"
                    onClick={() => {
                      openDialog(line.id);
                    }}
                  >
                    Nuevo producto
                  </Button>
                )}
              </div>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-background">
                    <TableRow>
                      <SortableTableHead
                        active={sort.key === 'sku'}
                        dir={sort.dir}
                        onClick={() => {
                          toggleSort('sku');
                        }}
                      >
                        SKU
                      </SortableTableHead>
                      <SortableTableHead
                        active={sort.key === 'name'}
                        dir={sort.dir}
                        onClick={() => {
                          toggleSort('name');
                        }}
                      >
                        Nombre
                      </SortableTableHead>
                      {usesColor(line.code) && <TableHead>Color</TableHead>}
                      {/* D-127: el subtipo decide qué hace la confirmación con esta línea,
                          así que se ve en la lista y no solo dentro del diálogo. */}
                      {line.code === BusinessLine.METALLIC_ROOFING && (
                        <TableHead>Subtipo</TableHead>
                      )}
                      <SortableTableHead
                        active={sort.key === 'unit'}
                        dir={sort.dir}
                        onClick={() => {
                          toggleSort('unit');
                        }}
                      >
                        Unidad
                      </SortableTableHead>
                      <TableHead>Origen</TableHead>
                      <SortableTableHead
                        active={sort.key === 'status'}
                        dir={sort.dir}
                        onClick={() => {
                          toggleSort('status');
                        }}
                      >
                        Estado
                      </SortableTableHead>
                      <SortableTableHead
                        active={sort.key === 'price'}
                        dir={sort.dir}
                        align="right"
                        className="text-right"
                        onClick={() => {
                          toggleSort('price');
                        }}
                      >
                        Precio de lista (con IGV)
                      </SortableTableHead>
                      {isAdmin && <TableHead className="text-right">Acciones</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lineProducts.map((p) => (
                      <TableRow
                        key={p.id}
                        id={`catalog-row-${p.id}`}
                        data-state={p.isActive ? undefined : 'inactive'}
                        className={
                          p.id === highlightProductId ? 'bg-amber-500/10 outline-amber-500/50' : ''
                        }
                      >
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
                        {line.code === BusinessLine.METALLIC_ROOFING && (
                          <TableCell>
                            {p.roofingKind === null
                              ? '—'
                              : ROOFING_PRODUCT_KIND_LABELS[p.roofingKind]}
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
                        <TableCell className="text-right">
                          <PriceListCell
                            product={p}
                            isAdmin={isAdmin}
                            onOpenHistory={setHistoryProduct}
                          />
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
                              pending={
                                toggleActive.isPending && toggleActive.variables?.id === p.id
                              }
                              onClick={() => {
                                if (toggleActive.isPending) return;
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
                          colSpan={(isAdmin ? 7 : 6) + (usesColor(line.code) ? 1 : 0)}
                          className="text-center text-muted-foreground"
                        >
                          {needle
                            ? `Ningún producto de esta línea coincide con «${search}».`
                            : 'Sin productos en esta línea.'}
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
          businessLineCode={
            lines.data.find((l) => l.id === dialog.lineId)?.code ?? BusinessLine.DRYWALL
          }
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

      {historyProduct && (
        <PriceListHistoryDialog
          productId={historyProduct.id}
          productSku={historyProduct.sku}
          open
          onOpenChange={(open) => {
            if (!open) setHistoryProduct(null);
          }}
        />
      )}
    </>
  );
}
