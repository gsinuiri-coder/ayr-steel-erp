'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage, toast } from '@/lib/notify';
import {
  BUSINESS_LINE_LABELS,
  BusinessLine,
  NO_FLOOR_REASON_LABELS,
  PRODUCT_SOURCE_LABELS,
  Role,
  ROOFING_PRODUCT_KIND_LABELS,
  type BusinessLineDto,
  type ProductDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
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
import { ColoresPanel } from './colores-panel';
import { ProductDialog } from '@/components/catalog/product-dialog';
import { DeleteProductDialog } from '@/components/catalog/delete-product-dialog';
import { PriceListCell } from '@/components/catalog/price-list-cell';
import { PriceListHistoryDialog } from '@/components/catalog/price-list-history-dialog';
import { RowActions } from '@/components/row-actions';
import { FilterChip } from '@/components/filter-chip';
import { formatKg, unitSymbol } from '@/lib/format';

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
  const [historyProduct, setHistoryProduct] = useState<ProductDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProductDto | null>(null);
  // RF-S3/M4: el card «SKUs con lista bajo piso» del Panel enlaza acá con
  // `?bajoPiso=<productId>` — un id concreto resalta esa fila (y abre su línea), el valor
  // `1` (más de 8 en el card) solo llega a la vista sin resaltar nada en particular.
  const highlightProductId = useSearchParams().get('bajoPiso');
  // Punto 13 del cliente (D-290): la búsqueda por SKU o nombre filtra en el cliente sobre
  // el catálogo ya cargado —no pagina (D-113)— y vive en la URL (`?q=`), con debounce de 150 ms.
  // D-326: `?tab=colores` abre la pestaña de colores (el ítem «Colores» del menú); sin él, la línea.
  // D-349: los inactivos se ocultan por defecto; el chip «Inactivos» (`?inactivos=1`) los suma.
  const [url, setUrl] = useUrlState({ q: '', tab: '', inactivos: '' });
  const showInactive = url.inactivos === '1';
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

  // cc31: la pestaña activa sale de la URL (D-289): `?tab=colores` o `?tab=<código de línea>`.
  // Sin `tab`, la línea del producto resaltado (`?bajoPiso=`) o la primera.
  const firstLine = lines.data?.[0];
  const highlightedLineId =
    highlightProductId && highlightProductId !== CATALOG_BAJO_PISO_VER_TODOS
      ? products.data?.find((p) => p.id === highlightProductId)?.businessLineId
      : undefined;
  // La pestaña elegida se muestra al instante: la URL se actualiza un momento después y, mientras
  // tanto, un clic en «Nuevo producto» abría el de la pestaña anterior.
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    setPicked(null);
  }, [url.tab]);
  const activeLineId =
    picked ??
    (url.tab === 'colores'
      ? 'colores'
      : (lines.data?.find((l) => l.code === url.tab)?.id ?? highlightedLineId ?? firstLine?.id));
  const selectTab = (value: string) => {
    setPicked(value);
    if (value === 'colores') {
      setUrl({ tab: 'colores' });
      return;
    }
    const code = lines.data?.find((l) => l.id === value)?.code ?? '';
    // La primera línea es el default y no se escribe, salvo que un resaltado mande otra.
    setUrl({ tab: code === firstLine?.code && !highlightedLineId ? '' : code });
  };

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
    onError: (err) => toast.error(errorMessage(err, 'No se pudo actualizar')),
  });

  const deleteProduct = useMutation({
    mutationFn: (p: ProductDto) => api(`/catalog/${p.id}`, { method: 'DELETE' }),
    onSuccess: (_, p) => {
      toast.success(`${p.sku} borrado del catálogo`);
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
    },
    onError: (err) => {
      toast.error(errorMessage(err, 'No se pudo borrar el producto'));
      // Hallazgo de la autorrevisión: un 409 real (otra pestaña usó el producto justo antes)
      // dejaba el `canDelete` viejo en la fila hasta el próximo refetch — «Eliminar» seguía
      // pareciendo posible aunque el backend ya lo hubiera rechazado.
      void queryClient.invalidateQueries({ queryKey: CATALOG_QUERY_KEY });
    },
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
          <h1 className="text-xl font-semibold">Catálogo</h1>
          <p className="text-xs text-muted-foreground">Productos por línea de negocio.</p>
        </div>
        {isAdmin && (
          <Button variant="outline" size="sm" asChild>
            <Link href="/catalogo/precios/importar">Cargar precios de lista</Link>
          </Button>
        )}
      </div>

      <Tabs value={activeLineId} onValueChange={selectTab}>
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
          // D-349 (mismo criterio que D-289): buscar encuentra también los inactivos — quien
          // escribe el SKU lo quiere esté como esté —; sin búsqueda, solo los activos salvo que
          // el chip esté encendido.
          const searched = needle
            ? inLine.filter(
                (p) =>
                  p.sku.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle),
              )
            : showInactive
              ? inLine
              : inLine.filter((p) => p.isActive);
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
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Buscar productos por SKU o nombre"
                    placeholder="Buscar por SKU o nombre…"
                    className="max-w-xs"
                    value={searchText}
                    onChange={(e) => {
                      setSearchText(e.target.value);
                    }}
                  />
                  <FilterChip
                    active={showInactive}
                    onToggle={() => {
                      setUrl({ inactivos: showInactive ? '' : '1' });
                    }}
                  >
                    Inactivos
                  </FilterChip>
                </div>
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
                <Table list>
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
                          p.id === highlightProductId
                            ? 'bg-tone-warning outline-tone-warning-foreground/40'
                            : ''
                        }
                      >
                        <TableCell className="font-medium">{p.sku}</TableCell>
                        <TableCell>
                          {p.name}
                          {/* D-342/D-344: un perfil de drywall al que le falta espesor, ancho o peso no tiene piso de precio. */}
                          {p.isActive && p.noFloorReason && (
                            <span className="block text-xs text-tone-warning-foreground">
                              {NO_FLOOR_REASON_LABELS[p.noFloorReason]}
                            </span>
                          )}
                          {/* D-344: aviso (no bloqueo) de que el kg/pieza se aleja del teórico. */}
                          {p.isActive && p.pieceWeightCheck?.warn && (
                            <span className="block text-xs text-tone-warning-foreground">
                              Peso por pieza {p.pieceWeightCheck.deviationPct} % fuera del teórico (
                              {formatKg(p.pieceWeightCheck.theoreticalKg)}): revisa ancho, largo,
                              espesor y peso
                            </span>
                          )}
                        </TableCell>
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
                        <TableCell>{unitSymbol(p.unit) || p.unit}</TableCell>
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
                            <RowActions
                              label={p.sku}
                              primary="edit"
                              actions={[
                                {
                                  key: 'edit',
                                  label: 'Editar',
                                  onSelect: () => {
                                    openDialog(p.businessLineId, p);
                                  },
                                },
                                {
                                  key: 'toggle',
                                  label: p.isActive ? 'Desactivar' : 'Activar',
                                  disabled: toggleActive.isPending,
                                  pending:
                                    toggleActive.isPending && toggleActive.variables?.id === p.id,
                                  onSelect: () => {
                                    if (toggleActive.isPending) return;
                                    toggleActive.mutate(p);
                                  },
                                },
                                {
                                  key: 'delete',
                                  label: 'Eliminar',
                                  destructive: true,
                                  disabled: !p.canDelete,
                                  title: p.canDelete
                                    ? undefined
                                    : 'Ya se usó (kardex, un documento comercial o producción): desactívalo en vez de borrarlo',
                                  onSelect: () => {
                                    setDeleteTarget(p);
                                  },
                                },
                              ]}
                            />
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

      {deleteTarget && (
        <DeleteProductDialog
          sku={deleteTarget.sku}
          open
          pending={deleteProduct.isPending}
          onOpenChange={(open) => {
            if (!open && !deleteProduct.isPending) setDeleteTarget(null);
          }}
          onConfirm={() => {
            deleteProduct.mutate(deleteTarget);
          }}
        />
      )}
    </>
  );
}
