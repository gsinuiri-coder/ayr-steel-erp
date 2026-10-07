'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorMessage, toast } from '@/lib/notify';
import {
  Role,
  STANDING_DOCUMENT_STATUSES,
  TRANSFER_MODE_LABELS,
  type DispatchDto,
  type FiscalDocumentDto,
  type FiscalDocumentStatus,
  type InvoicingSettingsDto,
} from '@ayr/shared';
import { api } from '@/lib/api';
import type { ReverseArgs } from '@/lib/reverse-args';
import { useSession } from '@/lib/session';
import { formatDate, formatQty, formatTimestampDate, unitSymbol } from '@/lib/format';
import { invalidateInvoicing } from '@/lib/invoicing-queries';
import { CrumbLabel } from '@/components/breadcrumb';
import {
  DispatchStatusBadge,
  FiscalDocumentStatusBadge,
} from '@/components/invoicing/status-badges';
import { ReasonDialog } from '@/components/reason-dialog';
import { ANNUL_REASONS } from '@/lib/reasons';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { HeaderActions } from '@/components/header-actions';
import { AuditHistoryLink } from '@/components/audit-history-link';
import { Section } from '@/components/section';
import { Skeleton } from '@/components/ui/skeleton';
import { customerSearchHref, LINK_CLASSNAME } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DetailSummary } from '@/components/detail-summary';

const DISPATCH_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR, Role.SUPERVISOR_PLANTA] as const;

/**
 * cc32: los estados de una guía vigente que SUNAT todavía no aceptó. La guía se ofrece para
 * imprimir, pero el PDF no existe hasta la aceptación: el botón queda en espera y lo dice.
 */
const NOTE_ON_THE_WAY: readonly FiscalDocumentStatus[] = ['DRAFT', 'ISSUED', 'SEND_ERROR'];

/** RF-77..RF-79: detalle del despacho, su guía y su reversa. */
export function DespachoDetalleView({ id }: { id: string }) {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [reverseOpen, setReverseOpen] = useState(false);

  const dispatch = useQuery({
    queryKey: ['dispatch', id],
    queryFn: () => api<DispatchDto>(`/dispatches/${id}`),
  });
  const d = dispatch.data;
  // Misma clave de caché que `contingency-card`/`comprobante-detalle-view` (D-216).
  const settings = useQuery({
    queryKey: ['invoicing-settings'],
    queryFn: () => api<InvoicingSettingsDto>('/invoicing/settings'),
  });
  const pseOff = settings.data !== undefined && !settings.data.pseEnabled;

  function onError(err: unknown): void {
    toast.error(errorMessage(err, 'La operación no se pudo completar'));
  }
  function refresh(): void {
    invalidateInvoicing(queryClient, { dispatchId: id, orderId: d?.salesOrderId });
  }

  const issueNote = useMutation({
    mutationFn: () => api<FiscalDocumentDto>(`/dispatches/${id}/dispatch-note`, { method: 'POST' }),
    onSuccess: (note) => {
      // El mensaje dice el desenlace real: con el PSE caído la guía sale igual (D-073) y
      // el camión puede partir, pero SUNAT todavía no la vio.
      if (note.status === 'ACCEPTED') toast.success(`Guía ${note.number} aceptada por SUNAT`);
      else if (note.status === 'REJECTED') toast.error(`SUNAT rechazó la guía ${note.number}`);
      else toast.warning(`Guía ${note.number} emitida y pendiente de envío al PSE`);
      refresh();
    },
    onError,
  });

  const reverse = useMutation({
    mutationFn: ({ reason, operationDate }: ReverseArgs) =>
      api<DispatchDto>(`/dispatches/${id}/reverse`, {
        method: 'POST',
        body: { reason, operationDate },
      }),
    onSuccess: () => {
      toast.success('Despacho revertido: el stock volvió al almacén');
      setReverseOpen(false);
      refresh();
    },
    onError,
  });

  if (dispatch.isPending) {
    return (
      <RoleGate allow={DISPATCH_ROLES}>
        <Skeleton className="h-64 w-full" />
      </RoleGate>
    );
  }
  if (dispatch.isError || !d) {
    return (
      <RoleGate allow={DISPATCH_ROLES}>
        <Alert variant="destructive">
          <AlertDescription>No se pudo cargar el despacho.</AlertDescription>
        </Alert>
      </RoleGate>
    );
  }

  const isLive = d.status === 'ISSUED';
  // Lista blanca por el mismo motivo que en el API (D-110): con "todas menos rechazada y
  // dada de baja", cada estado terminal nuevo entraba solo y en silencio como "la guía
  // vigente", y nada en el diff lo habría delatado. El borrador cuenta: una guía a medio
  // emitir sigue siendo la del despacho, y el API la bloquea igual.
  const noteBlocks =
    d.dispatchNoteStatus !== null && STANDING_DOCUMENT_STATUSES.includes(d.dispatchNoteStatus);
  const reverseBlockedBy = noteBlocks
    ? `la guía ${d.dispatchNoteNumber ?? ''} está vigente: dala de baja primero`
    : d.blockingDocumentNumbers.length > 0
      ? `el comprobante ${d.blockingDocumentNumbers.join(', ')} factura líneas de este despacho`
      : null;
  const canReverse = isAdmin && isLive && reverseBlockedBy === null;
  // Una guía rechazada o dada de baja no impide emitir otra: la que bloquea es la vigente.
  // D-103: un recojo en mostrador no tiene guía — el traslado es del comprador—, así que el
  // botón no aparece en vez de ofrecer una operación que el API rechaza.
  const canIssueNote = isLive && d.transferMode !== 'PICKUP' && !noteBlocks;
  const busy = issueNote.isPending || reverse.isPending;
  // cc32: el PDF de la guía lo guarda el API recién cuando SUNAT la acepta (`storeFiles` solo
  // corre con `ACCEPTED`, y `file()` responde 404 «se guarda cuando SUNAT lo acepta» mientras
  // tanto). Una guía todavía en camino se ofrece para imprimir, pero el botón espera y lo dice.
  const noteStatus = d.dispatchNoteId !== null ? d.dispatchNoteStatus : null;
  const notePrintable = noteStatus === 'ACCEPTED';
  const noteOnTheWay = noteStatus !== null && NOTE_ON_THE_WAY.includes(noteStatus);
  const notePdfHref = `/api/invoicing/documents/${d.dispatchNoteId ?? ''}/pdf`;

  return (
    <RoleGate allow={DISPATCH_ROLES}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <CrumbLabel label={d.code} />
            <h1 className="text-xl font-semibold">{d.code}</h1>
            <DispatchStatusBadge status={d.status} />
          </div>
        </div>
        {/*
          F8-S3b/M3: principal + «⋯». cc32: la principal sigue el estado de la guía —sin guía,
          emitirla; con guía, imprimirla—. Descargar y ver la guía van al menú, y revertir, que
          es destructivo, al final.
        */}
        {/* cc31: Historial, «Más opciones» y la principal, como en todo detalle. */}
        <div className="flex items-center gap-2">
          <AuditHistoryLink entityType="dispatches" entityId={d.id} />
          <HeaderActions
            primary={['issue-note', 'print-note']}
            primaryFooter={
              noteOnTheWay ? (
                <span className="text-xs text-muted-foreground">
                  Se imprime cuando SUNAT la acepte
                </span>
              ) : undefined
            }
            actions={[
              {
                key: 'issue-note',
                label: d.dispatchNoteStatus === 'REJECTED' ? 'Reemitir guía' : 'Emitir guía',
                show: canIssueNote,
                disabled: busy || pseOff,
                title: pseOff ? 'Emisión electrónica no habilitada en este entorno' : undefined,
                pending: issueNote.isPending,
                pendingText: 'Emitiendo…',
                onSelect: () => {
                  if (busy) return;
                  issueNote.mutate();
                },
              },
              {
                key: 'print-note',
                label: 'Imprimir guía',
                show: notePrintable || noteOnTheWay,
                disabled: !notePrintable,
                title: notePrintable ? undefined : 'Se imprime cuando SUNAT la acepte',
                print: notePdfHref,
              },
              {
                key: 'note-pdf',
                label: 'Descargar PDF de la guía',
                show: notePrintable,
                download: notePdfHref,
              },
              {
                key: 'view-note',
                label: 'Ver la guía',
                show: d.dispatchNoteId !== null,
                href: `/comprobantes/${d.dispatchNoteId ?? ''}`,
              },
              {
                key: 'reverse',
                label: 'Revertir despacho',
                show: canReverse,
                destructive: true,
                disabled: busy,
                onSelect: () => {
                  if (busy) return;
                  setReverseOpen(true);
                },
              },
            ]}
          />
        </div>
      </div>

      {/* cc31: resumen bajo la cabecera; el peso, que es la cifra del despacho, a la derecha. */}
      <DetailSummary
        items={[
          {
            label: 'Cliente',
            value: (
              <Link href={customerSearchHref(d.customerDocNumber)} className={LINK_CLASSNAME}>
                {d.customerName}
              </Link>
            ),
            detail: d.customerDocNumber,
          },
          {
            label: 'Pedido',
            value: (
              <Link href={`/pedidos/${d.salesOrderId}`} className={LINK_CLASSNAME}>
                {d.salesOrderCode}
              </Link>
            ),
          },
          { label: 'Fecha', value: formatDate(d.dispatchDate) },
          {
            label: TRANSFER_MODE_LABELS[d.transferMode],
            value:
              d.transferMode === 'PRIVATE'
                ? d.vehiclePlate
                : d.transferMode === 'PICKUP'
                  ? 'El cliente recoge'
                  : d.carrierName,
            detail:
              d.transferMode === 'PRIVATE'
                ? `${d.driverGivenNames ?? ''} ${d.driverFamilyNames ?? ''} · ${d.driverDocType ?? ''} ${d.driverDocNumber ?? ''} · Lic. ${d.driverLicense ?? ''}`
                : d.transferMode === 'PICKUP'
                  ? undefined
                  : `RUC ${d.carrierDocNumber ?? ''}`,
          },
          {
            label: 'Guía',
            value: d.dispatchNoteStatus ? (
              <span className="flex flex-wrap items-center gap-2">
                <span>{d.dispatchNoteNumber ?? 'Borrador'}</span>
                <FiscalDocumentStatusBadge status={d.dispatchNoteStatus} />
              </span>
            ) : (
              <span className="font-normal text-muted-foreground">Sin emitir</span>
            ),
          },
        ]}
        total={{
          label: 'Peso bruto',
          value: formatQty(d.totalWeightKg, 'kg'),
          detail: d.packageCount !== null ? `${String(d.packageCount)} bultos` : undefined,
        }}
      />

      {/*
        El guardrail de D-074, dicho antes de que alguien escriba un motivo: deshacer una
        salida que un documento vigente ya declaró dejaría al kardex y a SUNAT contando
        cosas distintas.
      */}
      {isLive && reverseBlockedBy !== null && (
        <Alert>
          <AlertDescription>
            Este despacho no se puede revertir porque {reverseBlockedBy}. Resuelve el documento
            primero y vuelve.
          </AlertDescription>
        </Alert>
      )}
      {d.status === 'REVERSED' && (
        <Alert>
          <AlertDescription>
            Revertido por {d.reversedByName ?? '—'} el{' '}
            {d.reversedAt ? formatTimestampDate(d.reversedAt) : '—'}. El stock volvió al almacén y
            las reservas del pedido se restauraron.
          </AlertDescription>
        </Alert>
      )}

      <Section title="Partida y llegada" bodyClassName="grid gap-2 px-2.5 py-1 md:grid-cols-2">
        <div>
          <div className="text-muted-foreground">Partida</div>
          <div>
            {d.originAddress} <span className="text-muted-foreground">({d.originUbigeo})</span>
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Llegada</div>
          <div>
            {d.destinationAddress}{' '}
            <span className="text-muted-foreground">({d.destinationUbigeo})</span>
          </div>
        </div>
      </Section>

      <Section title="Qué salió" count={d.items.length} empty="El despacho no tiene líneas.">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Producto</TableHead>
              <TableHead>Material</TableHead>
              <TableHead className="text-right">Cantidad</TableHead>
              <TableHead className="text-right">Salió del kardex</TableHead>
              <TableHead className="text-right">Peso</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>{item.lineNumber}</TableCell>
                <TableCell>
                  <div className="font-medium">{item.productSku}</div>
                  <div className="text-xs text-muted-foreground">{item.description}</div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {item.itemType === 'COIL' ? 'Bobina' : 'Producto'}
                </TableCell>
                <TableCell className="text-right">
                  {formatQty(item.qty, unitSymbol(item.unit))}
                </TableCell>
                {/* Lo que realmente salió del kardex, que no siempre es la cantidad de venta. */}
                <TableCell className="text-right">{formatQty(item.reserveQty)}</TableCell>
                <TableCell className="text-right">{formatQty(item.weightKg, 'kg')}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      {d.notes && (
        <Section title="Observaciones" bodyClassName="px-2.5 py-1 text-muted-foreground">
          {d.notes}
        </Section>
      )}

      <div className="text-xs text-muted-foreground">
        Despachado por {d.createdByName ?? '—'} el {formatTimestampDate(d.createdAt)}.
      </div>

      <ReasonDialog
        open={reverseOpen}
        onOpenChange={setReverseOpen}
        title={`Revertir ${d.code}`}
        reasons={ANNUL_REASONS}
        description="Devuelve el material al kardex, restaura las reservas del pedido y recalcula si el pedido sigue atendido. La fila del despacho no se borra: queda marcada como revertida."
        confirmLabel="Revertir despacho"
        pending={reverse.isPending}
        withOperationDate
        onConfirm={(reason, operationDate) => {
          reverse.mutate({ reason, operationDate });
        }}
      />
    </RoleGate>
  );
}
