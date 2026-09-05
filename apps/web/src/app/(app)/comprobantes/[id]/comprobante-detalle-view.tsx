'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CREDIT_NOTE_REASON_LABELS,
  CREDIT_NOTE_REASONS,
  FISCAL_DOC_TYPE_LABELS,
  FULL_CREDIT_NOTE_REASONS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  LIVE_DOCUMENT_STATUSES,
  PAYMENT_TERMS_LABELS,
  Role,
  businessToday,
  toDecimal,
  type CreditNoteReason,
  type CustomerPaymentDto,
  type FiscalDocumentDto,
  type PaymentMethod,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import {
  formatDate,
  formatMoney,
  formatQty,
  formatTimestampDate,
  isPositiveDecimal,
  unitSymbol,
} from '@/lib/format';
import { invalidateInvoicing } from '@/lib/invoicing-queries';
import { FiscalDocumentStatusBadge } from '@/components/invoicing/status-badges';
import { ReasonDialog } from '@/components/reason-dialog';
import { RoleGate } from '@/components/role-gate';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const SALES_ROLES = [Role.ADMINISTRADOR, Role.VENDEDOR] as const;

/** RF-70/RF-74/RF-75/RF-76: detalle del comprobante y sus acciones fiscales. */
export function ComprobanteDetalleView({ id }: { id: string }) {
  const router = useRouter();
  const { user } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = user.role === Role.ADMINISTRADOR;
  const [voidOpen, setVoidOpen] = useState(false);
  const [annulOpen, setAnnulOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [creditReason, setCreditReason] = useState<CreditNoteReason>('ANULACION_OPERACION');
  const [creditQty, setCreditQty] = useState<Record<string, string>>({});
  const [payOpen, setPayOpen] = useState(false);
  const [payDate, setPayDate] = useState(businessToday());
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<PaymentMethod>('TRANSFER');
  const [payReference, setPayReference] = useState('');
  const [reversingPayment, setReversingPayment] = useState<CustomerPaymentDto | null>(null);

  const document = useQuery({
    queryKey: ['fiscal-document', id],
    queryFn: () => api<FiscalDocumentDto>(`/invoicing/documents/${id}`),
  });
  const d = document.data;

  function onError(err: unknown): void {
    toast.error(err instanceof ApiError ? err.message : 'La operación no se pudo completar');
  }
  function refresh(): void {
    invalidateInvoicing(queryClient, { documentId: id, orderId: d?.salesOrderId ?? undefined });
  }

  const discard = useMutation({
    // El API responde 204 sin cuerpo; `api` devuelve `undefined` en ese caso.
    mutationFn: () => api<undefined>(`/invoicing/documents/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Borrador descartado');
      refresh();
      router.push('/comprobantes');
    },
    onError,
  });

  const send = useMutation({
    mutationFn: () => api<FiscalDocumentDto>(`/invoicing/documents/${id}/send`, { method: 'POST' }),
    onSuccess: (result) => {
      // El mensaje dice el desenlace real y no "listo": con el PSE caído el documento sale
      // igual (D-073) y el usuario tiene que saber que todavía no está declarado.
      if (result.status === 'ACCEPTED') toast.success(`${result.number} aceptado por SUNAT`);
      else if (result.status === 'REJECTED') toast.error(`SUNAT rechazó ${result.number}`);
      else
        toast.warning(`${result.number} quedó emitido y pendiente de envío; ya puedes despachar`);
      refresh();
    },
    onError,
  });

  const retry = useMutation({
    mutationFn: () =>
      api<FiscalDocumentDto>(`/invoicing/documents/${id}/retry`, { method: 'POST' }),
    onSuccess: (result) => {
      if (result.status === 'ACCEPTED') toast.success('Aceptado por SUNAT');
      else toast.warning('Sigue pendiente: el envío no entró todavía');
      refresh();
    },
    onError,
  });

  const refreshStatus = useMutation({
    mutationFn: () =>
      api<FiscalDocumentDto>(`/invoicing/documents/${id}/refresh`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Estado consultado al PSE');
      refresh();
    },
    onError,
  });

  const correct = useMutation({
    mutationFn: () =>
      api<FiscalDocumentDto>(`/invoicing/documents/${id}/correct`, { method: 'POST' }),
    onSuccess: (created) => {
      toast.success('Se creó un borrador corregido con correlativo nuevo');
      refresh();
      router.push(`/comprobantes/${created.id}`);
    },
    onError,
  });

  const voidDocument = useMutation({
    mutationFn: (reason: string) =>
      api<FiscalDocumentDto>(`/invoicing/documents/${id}/void`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: (result) => {
      toast.success(
        result.status === 'VOIDED'
          ? 'Comprobante dado de baja'
          : 'Baja comunicada: SUNAT todavía no la confirma',
      );
      setVoidOpen(false);
      refresh();
    },
    onError,
  });

  const annul = useMutation({
    mutationFn: (reason: string) =>
      api<FiscalDocumentDto>(`/invoicing/documents/${id}/annul`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: () => {
      toast.success('Comprobante importado anulado: su saldo pasó a cero');
      setAnnulOpen(false);
      refresh();
    },
    onError,
  });

  const creditNote = useMutation({
    mutationFn: () => {
      // `isPositiveDecimal` y no `Number(qty) > 0`: descartar en silencio una cantidad mal
      // escrita mandaba una nota parcial por el subconjunto equivocado —o, si todas
      // quedaban fuera, una nota **total**, que es lo contrario de lo que se pidió.
      const items = Object.entries(creditQty)
        .filter(([, qty]) => isPositiveDecimal(qty))
        .map(([affectedItemId, qty]) => ({ affectedItemId, qty: qty.trim() }));
      return api<FiscalDocumentDto>(`/invoicing/documents/${id}/credit-note`, {
        method: 'POST',
        body: {
          reason: creditReason,
          issueDate: businessToday(),
          // Sin líneas es total; con líneas, parcial (RF-76).
          ...(items.length > 0 ? { items } : {}),
        },
      });
    },
    onSuccess: (created) => {
      toast.success('Nota de crédito creada en borrador: revísala y emítela');
      setCreditOpen(false);
      setCreditQty({});
      refresh();
      router.push(`/comprobantes/${created.id}`);
    },
    onError,
  });

  // Dentro del `RoleGate`: fuera, quien no tiene permiso veía "no se pudo cargar" en
  // lugar de "no tienes permiso", que es justo lo que el guard existe para decir.
  const addPayment = useMutation({
    mutationFn: () =>
      api<FiscalDocumentDto>(`/invoicing/documents/${id}/payments`, {
        method: 'POST',
        body: {
          date: payDate,
          amountPen: payAmount.trim(),
          method: payMethod,
          ...(payReference.trim() ? { reference: payReference.trim() } : {}),
        },
      }),
    onSuccess: () => {
      toast.success('Cobro registrado');
      setPayOpen(false);
      setPayAmount('');
      setPayReference('');
      refresh();
    },
    onError,
  });

  const reversePayment = useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) =>
      api<FiscalDocumentDto>(`/invoicing/documents/${id}/payments/${paymentId}/reverse`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: () => {
      toast.success('Cobro revertido: el monto volvió al saldo');
      setReversingPayment(null);
      refresh();
    },
    onError,
  });

  if (document.isPending) {
    return (
      <RoleGate allow={SALES_ROLES}>
        <Skeleton className="h-64 w-full" />
      </RoleGate>
    );
  }
  if (document.isError || !d) {
    return (
      <RoleGate allow={SALES_ROLES}>
        <Alert variant="destructive">
          <AlertDescription>No se pudo cargar el comprobante.</AlertDescription>
        </Alert>
      </RoleGate>
    );
  }

  // Una guía de remisión comparte tabla y pantalla con los comprobantes, pero su envío
  // arma otro payload y su corrección vive en el despacho.
  const isDispatchNote = d.docType === 'GUIA_REMISION_REMITENTE';
  const isDraft = d.status === 'DRAFT' && !isDispatchNote;
  // D-105: un comprobante importado entró ya emitido y el PSE no lo conoce como nuestro.
  // Todo lo que habla con el proveedor —reintentar, consultar, dar de baja, acreditar— se
  // apaga acá; lo que no habla con él —cobrarlo, verlo, reimportarlo— sigue disponible.
  const isImported = d.origin === 'IMPORTED';
  const canRetry = !isImported && (d.status === 'ISSUED' || d.status === 'SEND_ERROR');
  // Un rechazado que **ya se corrigió** no se vuelve a corregir: el API lo rechaza con un
  // 409, y lo útil es el enlace a su reemplazo.
  const canCorrect = d.status === 'REJECTED' && !isDispatchNote && d.replacedByDocumentId === null;
  // Los mismos guardas que `voidDocument`: con un cobro vigente o una nota de crédito
  // viva, la baja se rechaza. Sin esto el usuario escribía el motivo en el diálogo y
  // recién ahí recibía el "no".
  const hasLivePayments = d.payments.some((p) => p.reversedAt === null);
  // Lista blanca, y compartida con el API (`LIVE_DOCUMENT_STATUSES`): con "todas menos
  // rechazadas y borradores", una nota de crédito **anulada** (D-110) seguía contando como
  // viva acá y no allá — el saldo del afectado volvía a subir en el API mientras el web
  // escondía el botón de anular y explicaba que el saldo ya estaba ajustado.
  const hasLiveCreditNotes = d.creditNotes.some((n) => LIVE_DOCUMENT_STATUSES.includes(n.status));
  const voidBlockedBy = hasLivePayments
    ? // El verbo cambia con el origen: sobre un importado lo que se ofrece es anular por
      // dentro (D-110), y mandar al usuario a "dar de baja" un botón que no existe es peor
      // que no decir nada.
      `tiene cobros vigentes: revierte el cobro antes de ${isImported ? 'anularlo' : 'darlo de baja'}`
    : hasLiveCreditNotes
      ? 'ya tiene nota de crédito: su saldo ya está ajustado'
      : null;
  const canVoid = isAdmin && d.voidPath === 'VOID' && voidBlockedBy === null;
  // D-110: la anulación interna de un importado. Mismos dos guardrails que la baja —cobro
  // vigente y nota de crédito viva—, porque el efecto sobre el saldo es el mismo; se apaga
  // en una versión ya archivada, que salió de todas las cuentas por otro camino (RF-72).
  const canAnnul =
    isAdmin &&
    isImported &&
    d.status === 'ACCEPTED' &&
    d.archivedAt === null &&
    voidBlockedBy === null;
  // Una guía no lleva saldo ni cobros, así que sus dos guardas no aplican: lo único que
  // se le puede hacer es darla de baja.
  const canVoidDispatchNote = isAdmin && !isImported && isDispatchNote && d.status === 'ACCEPTED';
  const canCreditNote =
    !isImported && d.status === 'ACCEPTED' && d.docType !== 'NOTA_CREDITO' && !isDispatchNote;
  const isFullReason = FULL_CREDIT_NOTE_REASONS.includes(creditReason);
  // Consultar tiene sentido donde puede cambiar algo: un pendiente de aceptación, una baja
  // en trámite, o un aceptado al que le faltan archivos. En `REJECTED` y `VOIDED` la
  // consulta gastaba una llamada al PSE para mostrar un "listo" que no significaba nada.
  const canQuery =
    !isImported &&
    (d.status === 'ISSUED' ||
      d.status === 'SEND_ERROR' ||
      d.status === 'VOID_PENDING' ||
      (d.status === 'ACCEPTED' && !(d.hasPdf && d.hasXml && d.hasCdr)));
  // W9: una guía de remisión comparte tabla y pantalla con los comprobantes, pero su
  // envío arma otro payload y su corrección vive en el despacho.
  const typedCreditQty = Object.values(creditQty).filter((q) => q.trim() !== '');
  const validCreditQty = typedCreditQty.filter((q) => isPositiveDecimal(q));
  // Un motivo parcial sin cantidades acabaría emitiendo una nota **total**; y una cantidad
  // mal escrita, una parcial por el subconjunto equivocado. Las dos cosas se cortan acá.
  // Solo se cobra lo que existe fiscalmente y todavía debe algo. El saldo cero no
  // esconde el botón por gusto: cobrar de más lo rechaza el API igual.
  const canCollect =
    // RF-72: a una versión archivada se llega con un clic desde su sucesora, y cobrarla
    // dejaría el dinero colgado de un documento que ya no suma en ninguna cuenta.
    d.archivedAt === null &&
    !isDispatchNote &&
    d.docType !== 'NOTA_CREDITO' &&
    (d.status === 'ISSUED' || d.status === 'SEND_ERROR' || d.status === 'ACCEPTED') &&
    toDecimal(d.balancePen).gt(0);
  const canCreateCreditNote =
    typedCreditQty.length === validCreditQty.length && (isFullReason || validCreditQty.length > 0);

  return (
    <RoleGate allow={SALES_ROLES}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{d.number ?? 'Borrador'}</h1>
            <FiscalDocumentStatusBadge status={d.status} isStalled={d.isStalled} />
            {isImported && <Badge variant="outline">Importado</Badge>}
            {d.archivedAt && <Badge variant="secondary">Versión archivada</Badge>}
          </div>
          {/* D-110: quién anuló, cuándo y por qué. Es lo primero que se pregunta ante un
              comprobante que dejó de deber, y el motivo vive en la fila además del audit_log. */}
          {d.annulledAt && (
            <p className="text-sm text-muted-foreground">
              Anulado internamente el {formatTimestampDate(d.annulledAt)}
              {d.annulledByName ? ` por ${d.annulledByName}` : ''} — {d.annulReason}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {FISCAL_DOC_TYPE_LABELS[d.docType]} · {d.customerName} · {d.customerDocNumber}
            {d.salesOrderId && (
              <>
                {' · '}
                <Link href={`/pedidos/${d.salesOrderId}`} className="underline">
                  {d.salesOrderCode}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isDraft && (
            <Button
              variant="outline"
              disabled={discard.isPending}
              onClick={() => {
                setDiscardOpen(true);
              }}
            >
              Descartar borrador
            </Button>
          )}
          {isDraft && (
            <Button
              disabled={send.isPending}
              onClick={() => {
                send.mutate();
              }}
            >
              Emitir y enviar al PSE
            </Button>
          )}
          {canRetry && (
            <Button
              variant="outline"
              disabled={retry.isPending}
              onClick={() => {
                retry.mutate();
              }}
            >
              Reintentar envío
            </Button>
          )}
          {canQuery && (
            <Button
              variant="outline"
              disabled={refreshStatus.isPending}
              onClick={() => {
                refreshStatus.mutate();
              }}
            >
              Consultar al PSE
            </Button>
          )}
          {canCorrect && (
            <Button
              disabled={correct.isPending}
              onClick={() => {
                correct.mutate();
              }}
            >
              Corregir y reemitir
            </Button>
          )}
          {d.replacedByDocumentId && (
            <Button variant="outline" asChild>
              <Link href={`/comprobantes/${d.replacedByDocumentId}`}>
                Ver {d.replacedByDocumentNumber ?? 'la corrección'}
              </Link>
            </Button>
          )}
          {canCreditNote && (
            <Button
              variant="outline"
              onClick={() => {
                setCreditOpen(true);
              }}
            >
              Nota de crédito
            </Button>
          )}
          {canAnnul && (
            <Button
              variant="destructive"
              onClick={() => {
                setAnnulOpen(true);
              }}
            >
              Anular internamente
            </Button>
          )}
          {(canVoid || canVoidDispatchNote) && (
            <Button
              variant="destructive"
              onClick={() => {
                setVoidOpen(true);
              }}
            >
              Dar de baja
            </Button>
          )}
        </div>
      </div>

      {/* Los avisos de estado. Cada uno dice qué pasó y qué hacer, no solo qué pasó. */}
      {d.status === 'ISSUED' && (
        <Alert variant={d.isStalled ? 'destructive' : 'default'}>
          <AlertDescription>
            El comprobante tiene número y ya permite despachar, pero el PSE todavía no lo aceptó
            {d.isStalled ? ' y lleva demasiado tiempo así' : ''}. El sistema reintenta solo cada 15
            minutos; «Reintentar envío» lo empuja ahora.
            {d.lastSendError && <> Último error: {d.lastSendError}</>}
          </AlertDescription>
        </Alert>
      )}
      {d.status === 'SEND_ERROR' && (
        <Alert variant="destructive">
          <AlertDescription>
            El envío falló: {d.lastSendError ?? 'sin detalle'}. El correlativo {d.number} ya está
            tomado y se reutiliza en cada reintento; no hace falta crear otro comprobante.
          </AlertDescription>
        </Alert>
      )}
      {d.status === 'REJECTED' && (
        <Alert variant="destructive">
          <AlertDescription>
            SUNAT rechazó el comprobante{d.rejectionCode ? ` (${d.rejectionCode})` : ''}:{' '}
            {d.rejectionMessage ?? 'sin detalle'}. El número {d.number} queda en el historial.{' '}
            {d.replacedByDocumentNumber
              ? `Ya fue corregido por ${d.replacedByDocumentNumber}.`
              : '«Corregir y reemitir» crea un borrador nuevo que tomará otro correlativo.'}
          </AlertDescription>
        </Alert>
      )}
      {d.status === 'VOID_PENDING' && (
        <Alert>
          <AlertDescription>
            La baja está comunicada y SUNAT todavía no la confirmó. «Consultar al PSE» revisa si ya
            respondió.
          </AlertDescription>
        </Alert>
      )}
      {/*
        RF-71/RF-72: lo que un comprobante importado sí y no admite, dicho una vez y arriba,
        en vez de dejar que el usuario lo descubra botón por botón.
      */}
      {isImported && (
        <Alert>
          <AlertDescription>
            Este comprobante se importó ya emitido: SUNAT lo recibió fuera del ERP. Se puede ver y
            cobrar, pero su baja y su nota de crédito se hacen donde se emitió y el resultado se
            vuelve a importar. Reimportarlo archiva esta versión y deja la nueva en su lugar,
            mientras todavía no tenga cobros vigentes ni notas de crédito encima. Si no debió
            entrar, «Anular internamente» lo saca de las cuentas sin tocar nada ante SUNAT.
            {d.supersedesDocumentId && (
              <>
                {' '}
                <Link href={`/comprobantes/${d.supersedesDocumentId}`} className="underline">
                  Ver la versión que reemplazó
                </Link>
                .
              </>
            )}
            {d.supersededByDocumentId && (
              <>
                {' '}
                Ya fue reemplazado:{' '}
                <Link href={`/comprobantes/${d.supersededByDocumentId}`} className="underline">
                  ver la versión vigente
                </Link>
                .
              </>
            )}
          </AlertDescription>
        </Alert>
      )}
      {voidBlockedBy !== null && isAdmin && d.voidPath === 'VOID' && (
        <Alert>
          <AlertDescription>
            Este comprobante no se puede dar de baja porque {voidBlockedBy}.
          </AlertDescription>
        </Alert>
      )}
      {isDispatchNote && (
        <Alert>
          <AlertDescription>
            Esta es la guía de remisión del despacho{' '}
            {d.dispatchId ? (
              <Link href={`/despachos/${d.dispatchId}`} className="underline">
                {d.dispatchCode}
              </Link>
            ) : (
              d.dispatchCode
            )}
            . Se emite y se corrige desde el despacho, no desde esta pantalla.
          </AlertDescription>
        </Alert>
      )}
      {d.voidPath === 'NONE' && (
        <Alert>
          <AlertDescription>
            Este documento ya no se puede deshacer: pasó el plazo de la comunicación de baja y una
            nota de crédito no se acredita con otra. Si hay que corregir el efecto, se hace con un
            documento nuevo sobre el comprobante original.
          </AlertDescription>
        </Alert>
      )}
      {d.voidPath === 'CREDIT_NOTE' && !isDispatchNote && (
        <Alert>
          <AlertDescription>
            Para deshacer este comprobante corresponde una <strong>nota de crédito</strong>, no la
            comunicación de baja:{' '}
            {d.docType === 'BOLETA'
              ? 'la baja de una boleta se comunica por resumen diario, que está fuera de alcance.'
              : 'ya pasó el plazo de siete días de la comunicación de baja.'}
          </AlertDescription>
        </Alert>
      )}
      {d.replacesDocumentNumber && (
        <Alert>
          <AlertDescription>
            Este comprobante corrige a {d.replacesDocumentNumber}, que fue rechazado y conserva su
            propio número.
          </AlertDescription>
        </Alert>
      )}
      {d.genericCustomerOverrideByName && (
        <Alert>
          <AlertDescription>
            Boleta a «público en general» por encima del tope de SUNAT, autorizada por{' '}
            {d.genericCustomerOverrideByName}.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Emisión</CardTitle>
          </CardHeader>
          <CardContent className="text-lg">{formatDate(d.issueDate)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {PAYMENT_TERMS_LABELS[d.paymentTerms]}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-lg">
            {d.dueDate ? (
              <span className={d.isOverdue ? 'text-destructive' : undefined}>
                {formatDate(d.dueDate)}
              </span>
            ) : (
              '—'
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-semibold">{formatMoney(d.totalPen)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Saldo</CardTitle>
          </CardHeader>
          <CardContent className="text-lg font-semibold">
            {formatMoney(d.balancePen)}
            {/*
              RF-72: el saldo de una versión archivada se sigue calculando igual, pero ya no
              suma en cuentas por cobrar. Sin esta línea, la cifra se lee como una deuda viva.
            */}
            {d.archivedAt !== null && (
              <div className="text-xs font-normal text-muted-foreground">
                Versión archivada: no cuenta en cobranzas
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {(d.hasPdf || d.hasXml || d.hasCdr) && (
        <div className="flex flex-wrap gap-2">
          {d.hasPdf && (
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/invoicing/documents/${d.id}/pdf`}>Descargar PDF</a>
            </Button>
          )}
          {d.hasXml && (
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/invoicing/documents/${d.id}/xml`}>Descargar XML</a>
            </Button>
          )}
          {d.hasCdr && (
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/invoicing/documents/${d.id}/cdr`}>Descargar CDR</a>
            </Button>
          )}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Líneas</h2>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead className="text-right">Cantidad</TableHead>
                <TableHead className="text-right">P. unitario</TableHead>
                <TableHead className="text-right">Subtotal</TableHead>
                <TableHead className="text-right">IGV</TableHead>
                <TableHead className="text-right">Acreditado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.lineNumber}</TableCell>
                  <TableCell>
                    <div className="font-medium">{item.productSku ?? item.description}</div>
                    {item.productSku && (
                      <div className="text-xs text-muted-foreground">{item.description}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatQty(item.qty, unitSymbol(item.unit))}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMoney(item.unitPricePen, 'PEN', 4)}
                  </TableCell>
                  <TableCell className="text-right">{formatMoney(item.subtotalPen)}</TableCell>
                  <TableCell className="text-right">{formatMoney(item.igvPen)}</TableCell>
                  <TableCell className="text-right">
                    {toDecimal(item.creditedQty).gt(0)
                      ? formatQty(item.creditedQty, unitSymbol(item.unit))
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex justify-end gap-6 text-sm">
          <span>Subtotal {formatMoney(d.subtotalPen)}</span>
          <span>IGV {formatMoney(d.igvPen)}</span>
          <span className="font-semibold">Total {formatMoney(d.totalPen)}</span>
        </div>
      </section>

      {/*
        RF-86/RF-87: la cobranza vive en el comprobante porque el saldo es del comprobante
        (D-075). Una nota de crédito y una guía no se cobran.
      */}
      {!isDispatchNote && d.docType !== 'NOTA_CREDITO' && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Cobros</h2>
            {canCollect && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setPayAmount(d.balancePen);
                  setPayOpen(true);
                }}
              >
                Registrar cobro
              </Button>
            )}
          </div>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Medio</TableHead>
                  <TableHead>Referencia</TableHead>
                  <TableHead className="text-right">Monto</TableHead>
                  <TableHead>Registrado por</TableHead>
                  {isAdmin && <TableHead className="text-right">Acciones</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.payments.map((p) => (
                  <TableRow key={p.id} className={p.reversedAt !== null ? 'opacity-60' : undefined}>
                    <TableCell>{formatDate(p.date)}</TableCell>
                    <TableCell>{PAYMENT_METHOD_LABELS[p.method]}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.reference ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoney(p.amountPen)}
                      {p.reversedAt !== null && (
                        <Badge variant="outline" className="ml-2">
                          Revertido
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{p.createdByName ?? '—'}</TableCell>
                    {isAdmin && (
                      <TableCell className="text-right">
                        {p.reversedAt === null && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setReversingPayment(p);
                            }}
                          >
                            Revertir
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {d.payments.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={isAdmin ? 6 : 5}
                      className="text-center text-muted-foreground"
                    >
                      Todavía no hay cobros.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {d.creditNotes.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Notas de crédito</h2>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Número</TableHead>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.creditNotes.map((n) => (
                  <TableRow key={n.id}>
                    <TableCell>
                      <Link
                        href={`/comprobantes/${n.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {n.number ?? 'Borrador'}
                      </Link>
                    </TableCell>
                    <TableCell>{formatDate(n.issueDate)}</TableCell>
                    <TableCell>
                      <FiscalDocumentStatusBadge status={n.status} />
                    </TableCell>
                    <TableCell className="text-right">{formatMoney(n.totalPen)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {d.affectedDocumentNumber && (
        <div className="text-sm text-muted-foreground">
          Afecta a{' '}
          <Link href={`/comprobantes/${d.affectedDocumentId}`} className="underline">
            {d.affectedDocumentNumber}
          </Link>
          {d.creditNoteReason && <> · {CREDIT_NOTE_REASON_LABELS[d.creditNoteReason]}</>}
        </div>
      )}

      <div className="text-xs text-muted-foreground">
        Creado por {d.createdByName ?? '—'} el {formatDate(d.createdAt.slice(0, 10))}.
        {d.sunatHash && <> Hash SUNAT: {d.sunatHash}.</>}
        {d.sendAttempts > 0 && <> Intentos de envío: {d.sendAttempts}.</>}
      </div>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Descartar este borrador</DialogTitle>
            <DialogDescription>
              Un borrador no tomó correlativo y SUNAT nunca supo de él, así que se borra sin dejar
              hueco en la numeración. Es lo único de facturación que se borra de verdad: todo lo
              demás se anula y se conserva.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDiscardOpen(false);
              }}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={discard.isPending}
              onClick={() => {
                discard.mutate();
              }}
            >
              Descartar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReasonDialog
        open={voidOpen}
        onOpenChange={setVoidOpen}
        title={`Dar de baja ${d.number ?? ''}`}
        description="Comunica la baja a SUNAT: el comprobante se da por no emitido y su saldo pasa a cero. Fuera del plazo o con efecto económico, lo que corresponde es una nota de crédito."
        confirmLabel="Comunicar la baja"
        pending={voidDocument.isPending}
        onConfirm={(reason) => {
          voidDocument.mutate(reason);
        }}
      />

      {/*
        D-110: la anulación interna de un importado. El texto dice lo que la operación **no**
        hace, que es la mitad que se malinterpreta: SUNAT sigue teniendo ese comprobante.
      */}
      <ReasonDialog
        open={annulOpen}
        onOpenChange={setAnnulOpen}
        title={`Anular ${d.number ?? ''} internamente`}
        description="Este comprobante entró por planilla y SUNAT lo recibió fuera del ERP: anularlo acá lo da por no existente para el sistema y su saldo pasa a cero, pero no comunica ninguna baja. Si el comprobante existe de verdad ante SUNAT, dalo de baja donde se emitió."
        confirmLabel="Anular internamente"
        pending={annul.isPending}
        onConfirm={(reason) => {
          annul.mutate(reason);
        }}
      />

      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar cobro de {d.number}</DialogTitle>
            <DialogDescription>
              El saldo pendiente es {formatMoney(d.balancePen)}. Un cobro no se borra: si hay que
              deshacerlo, se revierte y el monto vuelve al saldo.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Fecha</Label>
              <Input
                type="date"
                value={payDate}
                onChange={(e) => {
                  setPayDate(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>Monto</Label>
              <Input
                inputMode="decimal"
                value={payAmount}
                onChange={(e) => {
                  setPayAmount(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>Medio de pago</Label>
              <Select
                value={payMethod}
                onValueChange={(v) => {
                  setPayMethod(v as PaymentMethod);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {PAYMENT_METHOD_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Referencia</Label>
              <Input
                value={payReference}
                maxLength={120}
                placeholder="N.º de operación"
                onChange={(e) => {
                  setPayReference(e.target.value);
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPayOpen(false);
              }}
            >
              Cancelar
            </Button>
            <Button
              disabled={
                addPayment.isPending ||
                !isPositiveDecimal(payAmount) ||
                toDecimal(isPositiveDecimal(payAmount) ? payAmount : '0').gt(
                  toDecimal(d.balancePen),
                )
              }
              onClick={() => {
                addPayment.mutate();
              }}
            >
              Registrar cobro
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReasonDialog
        open={reversingPayment !== null}
        onOpenChange={(open) => {
          if (!open) setReversingPayment(null);
        }}
        title={`Revertir el cobro de ${reversingPayment ? formatMoney(reversingPayment.amountPen) : ''}`}
        description="El monto vuelve al saldo pendiente. La fila del cobro no se borra: queda marcada, con el motivo en la auditoría."
        confirmLabel="Revertir cobro"
        pending={reversePayment.isPending}
        onConfirm={(reason) => {
          if (reversingPayment) {
            reversePayment.mutate({ paymentId: reversingPayment.id, reason });
          }
        }}
      />

      <Dialog
        open={creditOpen}
        onOpenChange={(open) => {
          setCreditOpen(open);
          // Cancelar y reabrir no arrastra lo tipeado la vez anterior, igual que
          // `ReasonDialog`.
          if (!open) {
            setCreditQty({});
            setCreditReason('ANULACION_OPERACION');
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Nota de crédito sobre {d.number}</DialogTitle>
            <DialogDescription>
              Sin cantidades es una nota <strong>total</strong>: acredita todo lo que quede sin
              acreditar. Escribe cantidades para acreditar solo una parte.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Motivo (catálogo 09 de SUNAT)</Label>
              <Select
                value={creditReason}
                onValueChange={(v) => {
                  setCreditReason(v as CreditNoteReason);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREDIT_NOTE_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {CREDIT_NOTE_REASON_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!isFullReason && (
                <p className="text-xs text-muted-foreground">
                  Este motivo describe un ajuste parcial: conviene indicar cantidades por línea.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Cantidades a acreditar (opcional)</Label>
              {d.items.map((item) => {
                const pending = toDecimal(item.qty).minus(toDecimal(item.creditedQty));
                return (
                  <div key={item.id} className="flex items-center gap-3">
                    <span className="flex-1 text-sm">
                      {item.productSku ?? item.description}
                      <span className="ml-2 text-xs text-muted-foreground">
                        quedan {pending.toFixed(3)} {unitSymbol(item.unit)}
                      </span>
                    </span>
                    <Input
                      className="w-32"
                      inputMode="decimal"
                      placeholder="Total"
                      value={creditQty[item.id] ?? ''}
                      onChange={(e) => {
                        setCreditQty((prev) => ({ ...prev, [item.id]: e.target.value }));
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreditOpen(false);
              }}
            >
              Cancelar
            </Button>
            <Button
              disabled={creditNote.isPending || !canCreateCreditNote}
              onClick={() => {
                creditNote.mutate();
              }}
            >
              Crear borrador de nota de crédito
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </RoleGate>
  );
}
