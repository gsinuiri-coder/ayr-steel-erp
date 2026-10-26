'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { SalesMarginCreditNoteDto, SalesMarginDto } from '@ayr/shared';
import { ToolbarSearch } from '@/components/table-toolbar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatAmount, formatDate } from '@/lib/format';
import {
  creditNoteReasonText,
  creditNotesLinkLabel,
  filterCreditNotes,
} from '@/lib/sales-margin-credit-notes';
import { LINK_CLASSNAME, WIDE_DIALOG_CLASSNAME, cn, customerSearchHref } from '@/lib/utils';

/**
 * cc67 (D-720): debajo de la franja, los totales separados en comprobantes del periodo («brutas»),
 * notas de crédito y netas (las cifras de la franja), y el enlace al detalle. Sin NC en el periodo
 * no se muestra: la franja queda como siempre. En Servicios (sin costo registrado), solo la venta.
 */
export function CreditNotesSummary({
  data,
  noCost,
  onOpen,
}: {
  data: SalesMarginDto;
  noCost: boolean;
  onOpen: () => void;
}) {
  if (data.creditNotes.length === 0) return null;
  const c = data.creditTotals;
  const rows = [
    {
      key: 'brutas',
      label: 'Ventas brutas',
      hint: 'comprobantes del periodo',
      values: [c.grossSalesPen, c.grossCostPen, c.grossMarginPen],
    },
    {
      key: 'nc',
      label: 'Notas de crédito',
      hint: 'una devolución resta costo; un descuento, no',
      values: [c.creditSalesPen, c.creditCostPen, c.creditMarginPen],
    },
    {
      key: 'netas',
      label: 'Ventas netas',
      hint: 'las cifras de arriba',
      values: [c.netSalesPen, c.netCostPen, c.netMarginPen],
    },
  ];
  const headers = noCost ? ['Venta (S/)'] : ['Venta (S/)', 'Costo (S/)', 'Margen (S/)'];
  return (
    <div
      data-testid="nc-ventas-margen"
      className="flex flex-wrap items-end justify-between gap-3 rounded-lg px-3 py-2 ring-1 ring-foreground/10"
    >
      <div
        role="table"
        aria-label="Ventas brutas, notas de crédito y ventas netas"
        className={cn(
          'grid min-w-0 gap-x-6 gap-y-0.5 text-sm',
          noCost ? 'grid-cols-[auto_auto]' : 'grid-cols-[auto_repeat(3,auto)]',
        )}
      >
        <div role="row" className="contents text-xs text-muted-foreground">
          <span role="columnheader" />
          {headers.map((h) => (
            <span key={h} role="columnheader" className="text-right">
              {h}
            </span>
          ))}
        </div>
        {rows.map((r) => (
          <div
            key={r.key}
            role="row"
            data-testid={`nc-fila-${r.key}`}
            className={cn('contents', r.key === 'netas' && 'font-medium')}
          >
            <span role="rowheader" title={r.hint}>
              {r.label}
            </span>
            {r.values.slice(0, headers.length).map((v, i) => (
              <span key={headers[i]} role="cell" className="text-right tabular-nums">
                {formatAmount(v)}
              </span>
            ))}
          </div>
        ))}
      </div>
      <Button type="button" variant="link" size="sm" className="px-0" onClick={onOpen}>
        {creditNotesLinkLabel(data.creditNotes.length)}
      </Button>
    </div>
  );
}

/**
 * cc67 (D-720): el detalle de las NC del periodo (de la pestaña que se ve), por fecha de la NC, de
 * la más antigua a la más reciente. El buscar va primero (D-615); la búsqueda es del modal y no
 * toca la tabla del reporte. La NC y el comprobante afectado enlazan a su detalle.
 */
export function CreditNotesDialog({
  notes,
  noCost,
  open,
  onOpenChange,
}: {
  notes: readonly SalesMarginCreditNoteDto[];
  noCost: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const shown = filterCreditNotes(notes, search);
  const earlier = notes.filter((n) => n.affectedEarlierMonth).length;
  const outside = notes.filter((n) => !n.inTotals).length;
  const columns = noCost ? 6 : 8;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSearch('');
        onOpenChange(next);
      }}
    >
      <DialogContent className={WIDE_DIALOG_CLASSNAME} data-testid="modal-notas-credito">
        <DialogHeader>
          <DialogTitle>Notas de crédito del periodo</DialogTitle>
          <DialogDescription>
            Cada NC resta en el mes de su fecha, aunque su comprobante sea de otro mes: ese mes no
            cambia.
            {earlier > 0 &&
              ` ${earlier === 1 ? '1 afecta' : `${String(earlier)} afectan`} a un comprobante de un mes anterior.`}
            {outside > 0 &&
              ' Las marcadas «fuera de los totales» son de pedidos con facturación parcial o costo no rastreable: se listan sin costo y no suman.'}
          </DialogDescription>
        </DialogHeader>
        <ToolbarSearch
          className="w-80"
          label="Buscar notas de crédito"
          placeholder="Buscar NC, comprobante, cliente o motivo"
          value={search}
          onChange={setSearch}
        />
        <div className="max-h-[65vh] overflow-auto rounded-md border">
          <Table data-testid="tabla-notas-credito">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Nota de crédito</TableHead>
                <TableHead>Comprobante afectado</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Motivo SUNAT</TableHead>
                <TableHead className="text-right">Venta (S/)</TableHead>
                {!noCost && (
                  <>
                    <TableHead className="text-right">Costo (S/)</TableHead>
                    {/* Dos líneas: sin scroll horizontal en el modal a 1280 px. */}
                    <TableHead className="text-right whitespace-normal">
                      Efecto en el margen (S/)
                    </TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={columns} className="text-muted-foreground">
                    Ninguna nota de crédito coincide con «{search.trim()}».
                  </TableCell>
                </TableRow>
              )}
              {shown.map((n) => (
                <TableRow key={n.id} data-testid="fila-nota-credito">
                  <TableCell className="whitespace-nowrap">{formatDate(n.issueDate)}</TableCell>
                  <TableCell>
                    <DocLink id={n.id} number={n.number} />
                    {!n.inTotals && (
                      <Badge variant="outline" className="ml-2">
                        fuera de los totales
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {n.affectedDocumentId === null ? (
                      '—'
                    ) : (
                      <>
                        <DocLink id={n.affectedDocumentId} number={n.affectedNumber} />
                        <div className="text-xs text-muted-foreground">
                          {n.affectedIssueDate === null ? '' : monthLabel(n.affectedIssueDate)}
                          {n.affectedEarlierMonth && (
                            <Badge
                              variant="secondary"
                              className="ml-2"
                              data-testid="nc-mes-anterior"
                            >
                              mes anterior
                            </Badge>
                          )}
                        </div>
                      </>
                    )}
                  </TableCell>
                  <TableCell className="min-w-40 whitespace-normal">
                    <Link href={customerSearchHref(n.customerDocNumber)} className={LINK_CLASSNAME}>
                      {n.customerName}
                    </Link>
                  </TableCell>
                  <TableCell className="min-w-40 whitespace-normal">
                    {creditNoteReasonText(n.reason)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatAmount(n.salesPen)}
                  </TableCell>
                  {!noCost && (
                    <>
                      <TableCell className="text-right tabular-nums">
                        {n.costPen === null ? '—' : formatAmount(n.costPen)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {n.marginPen === null ? '—' : formatAmount(n.marginPen)}
                      </TableCell>
                    </>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DocLink({ id, number }: { id: string; number: string | null }) {
  return (
    <Link href={`/comprobantes/${id}`} className={cn('font-mono', LINK_CLASSNAME)}>
      {number ?? '—'}
    </Link>
  );
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'setiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** `2026-09-20` → «setiembre 2026». */
function monthLabel(isoDate: string): string {
  const [year, month] = isoDate.split('-');
  return `${MONTHS[Number(month) - 1] ?? ''} ${year ?? ''}`;
}
