'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  DOC_TYPE_LABELS,
  DOC_TYPES,
  DocType,
  docNumberLengths,
  type CustomerDto,
  type DocumentLookupDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
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

/**
 * Identificar al cliente del mostrador en un solo diálogo (RF-60).
 *
 * El camino tiene **un** dato de entrada: el documento. Con él se busca primero en el
 * maestro; si el cliente ya existe se elige y listo, y si no, se completa la razón social
 * con el lookup de D-067 y se crea en el acto. Es el mismo flujo del formulario de clientes
 * comprimido a lo que un mostrador puede sostener: nadie va a tipear correo y días de
 * crédito con alguien esperando el vuelto.
 */
export function CustomerPicker({
  open,
  onOpenChange,
  onPicked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPicked: (customer: CustomerDto) => void;
}) {
  const [docType, setDocType] = useState<DocType>(DocType.RUC);
  const [docNumber, setDocNumber] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDocNumber('');
    setName('');
    setNote(null);
    setError(null);
    setSearched(false);
  }, [open]);

  const { min, max } = docNumberLengths[docType];
  const trimmed = docNumber.trim();
  const validDoc = /^[A-Za-z0-9]+$/.test(trimmed) && trimmed.length >= min && trimmed.length <= max;

  const search = useMutation({
    mutationFn: async (): Promise<CustomerDto | null> => {
      // Primero el maestro: un cliente de mostrador que vuelve no se crea dos veces.
      const all = await api<CustomerDto[]>('/customers');
      const existing = all.find((c) => c.docNumber === trimmed && c.docType === docType);
      if (existing) return existing;
      // Y solo si no está, el servicio externo (D-067), que tiene cuota.
      const looked = await api<DocumentLookupDto>(
        `/customers/lookup?docType=${encodeURIComponent(docType)}&docNumber=${encodeURIComponent(trimmed)}`,
      );
      setName(looked.name ?? '');
      setNote(
        looked.found
          ? 'Datos traídos de SUNAT. Revísalos antes de guardar.'
          : 'No se encontró el documento: escribe el nombre y se crea igual.',
      );
      return null;
    },
    onMutate: () => {
      setError(null);
      setNote(null);
    },
    onSuccess: (found) => {
      setSearched(true);
      if (found) {
        if (!found.isActive) {
          setError('Ese cliente está desactivado: reactívalo desde Clientes antes de venderle.');
          return;
        }
        onPicked(found);
        onOpenChange(false);
      }
    },
    onError: (err) => {
      setSearched(true);
      setError(err instanceof ApiError ? err.message : 'No se pudo buscar el documento');
    },
  });

  const create = useMutation({
    mutationFn: () =>
      api<CustomerDto>('/customers', {
        method: 'POST',
        body: { docType, docNumber: trimmed, name: name.trim(), creditDays: 0 },
      }),
    onSuccess: (created) => {
      onPicked(created);
      onOpenChange(false);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear el cliente');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Identificar al cliente</DialogTitle>
          <DialogDescription>
            Con RUC se emite factura; con DNI o carné de extranjería, boleta.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid grid-cols-[7rem_1fr] gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="pos-doc-type">Documento</Label>
              <Select
                value={docType}
                onValueChange={(v) => {
                  setDocType(v as DocType);
                  setSearched(false);
                }}
              >
                <SelectTrigger id="pos-doc-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOC_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {DOC_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pos-doc-number">Número</Label>
              <Input
                id="pos-doc-number"
                inputMode="numeric"
                autoComplete="off"
                value={docNumber}
                onChange={(e) => {
                  setDocNumber(e.target.value);
                  setSearched(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && validDoc && !search.isPending) search.mutate();
                }}
              />
            </div>
          </div>

          {searched && (
            <div className="grid gap-1.5">
              <Label htmlFor="pos-customer-name">Nombre o razón social</Label>
              <Input
                id="pos-customer-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            </div>
          )}

          {note && <p className="text-sm text-muted-foreground">{note}</p>}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancelar
          </Button>
          {searched ? (
            <Button
              disabled={name.trim().length < 2 || create.isPending}
              onClick={() => {
                create.mutate();
              }}
            >
              {create.isPending ? 'Guardando…' : 'Crear y usar'}
            </Button>
          ) : (
            <Button
              disabled={!validDoc || search.isPending}
              onClick={() => {
                search.mutate();
              }}
            >
              {search.isPending ? 'Buscando…' : 'Buscar'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
