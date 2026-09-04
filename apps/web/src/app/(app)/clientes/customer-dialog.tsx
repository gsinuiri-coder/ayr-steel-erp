'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  DOC_TYPE_LABELS,
  DOC_TYPES,
  docNumberLengths,
  type CustomerDto,
  type DocumentLookupDto,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const CUSTOMERS_QUERY_KEY = ['customers'] as const;

const formSchema = z.object({
  docType: z.enum(DOC_TYPES),
  docNumber: z.string().trim().min(1, 'Obligatorio').max(20),
  name: z.string().trim().min(2, 'Mínimo 2 caracteres').max(160),
  address: z.string().trim().max(240).optional(),
  email: z.string().trim().max(160).optional(),
  phone: z.string().trim().max(30).optional(),
  creditDays: z.coerce.number().int().min(0).max(365),
});
type FormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  customer?: CustomerDto;
  onOpenChange: (open: boolean) => void;
}

export function CustomerDialog({ open, customer, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const editing = !!customer;
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      docType: customer?.docType ?? 'RUC',
      docNumber: customer?.docNumber ?? '',
      name: customer?.name ?? '',
      address: customer?.address ?? '',
      email: customer?.email ?? '',
      phone: customer?.phone ?? '',
      creditDays: customer?.creditDays ?? 0,
    },
  });

  /**
   * D-067: autocompletar razón social y dirección desde apis.net.pe. Es **opcional** de
   * punta a punta: si el servicio no responde, no está configurado o el documento no
   * existe, se avisa y la captura manual sigue igual de disponible. Nada bloquea el
   * formulario — mismo criterio que el fallback del tipo de cambio (D-029).
   */
  const lookup = useMutation({
    mutationFn: ({ docType, docNumber }: { docType: string; docNumber: string }) =>
      api<DocumentLookupDto>(
        `/customers/lookup?docType=${encodeURIComponent(docType)}&docNumber=${encodeURIComponent(docNumber)}`,
      ),
    onSuccess: (result) => {
      if (result.found && result.name) {
        form.setValue('name', result.name, { shouldValidate: true });
        if (result.address) form.setValue('address', result.address, { shouldValidate: true });
        setLookupNote(null);
        toast.success('Datos traídos del padrón');
        return;
      }
      setLookupNote(
        result.reason === 'UNAVAILABLE'
          ? 'El servicio de consulta no respondió. Escribe los datos a mano.'
          : result.reason === 'NOT_CONFIGURED'
            ? 'La consulta automática no está configurada. Escribe los datos a mano.'
            : 'No se encontró ese documento. Escribe los datos a mano.',
      );
    },
    onError: () => {
      setLookupNote('No se pudo consultar el documento. Escribe los datos a mano.');
    },
  });

  const docType = form.watch('docType');
  const docNumber = form.watch('docNumber');
  const lengths = docNumberLengths[docType];
  const canLookup =
    !editing &&
    docType !== 'CE' &&
    docNumber.trim().length >= lengths.min &&
    docNumber.trim().length <= lengths.max;

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      if (editing) {
        const { docType: _docType, docNumber: _docNumber, ...body } = values;
        return api<CustomerDto>(`/customers/${customer.id}`, { method: 'PATCH', body });
      }
      return api<CustomerDto>('/customers', { method: 'POST', body: values });
    },
    onSuccess: () => {
      toast.success(editing ? 'Cliente actualizado' : 'Cliente creado');
      void queryClient.invalidateQueries({ queryKey: CUSTOMERS_QUERY_KEY });
      onOpenChange(false);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.errors) {
        for (const [field, messages] of Object.entries(err.errors)) {
          if (messages?.[0] && field in form.getValues()) {
            form.setError(field as keyof FormValues, { message: messages[0] });
          }
        }
      }
      form.setError('root', {
        message: err instanceof ApiError ? err.message : 'Error inesperado',
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar cliente' : 'Nuevo cliente'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((v) => {
              save.mutate(v);
            })}
            className="grid gap-4"
            noValidate
          >
            {form.formState.errors.root && (
              <p role="alert" className="text-sm text-destructive">
                {form.formState.errors.root.message}
              </p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="docType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tipo de documento</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={editing}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {DOC_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {DOC_TYPE_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="docNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Número</FormLabel>
                    <div className="flex gap-2">
                      <FormControl>
                        <Input disabled={editing} autoComplete="off" {...field} />
                      </FormControl>
                      {!editing && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!canLookup || lookup.isPending}
                          onClick={() => {
                            setLookupNote(null);
                            lookup.mutate({ docType, docNumber: docNumber.trim() });
                          }}
                        >
                          {lookup.isPending ? 'Buscando…' : 'Buscar'}
                        </Button>
                      )}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {lookupNote && (
              <p className="text-sm text-muted-foreground" role="status">
                {lookupNote}
              </p>
            )}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nombre / razón social</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Dirección</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Correo</FormLabel>
                    <FormControl>
                      <Input type="email" autoComplete="off" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Teléfono</FormLabel>
                    <FormControl>
                      <Input autoComplete="off" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="creditDays"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Días de crédito</FormLabel>
                  <FormControl>
                    <Input type="number" min={0} max={365} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear cliente'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
