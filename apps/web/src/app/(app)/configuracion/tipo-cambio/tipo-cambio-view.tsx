'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  CURRENCIES,
  CURRENCY_LABELS,
  Role,
  upsertManualExchangeRateSchema,
  type ExchangeRateDto,
  type UpsertManualExchangeRateInput,
} from '@ayr/shared';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const EXCHANGE_RATES_QUERY_KEY = ['exchange-rates'] as const;

const today = new Date().toISOString().slice(0, 10);

/** D-029/P-06: tipo de cambio SUNAT (apis.net.pe) con caché y fallback manual. */
export function TipoCambioView() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const rates = useQuery({
    queryKey: EXCHANGE_RATES_QUERY_KEY,
    queryFn: () => api<ExchangeRateDto[]>('/exchange-rates'),
  });

  const form = useForm<UpsertManualExchangeRateInput>({
    resolver: zodResolver(upsertManualExchangeRateSchema),
    defaultValues: { date: today, currency: 'USD', buy: '', sell: '' },
  });

  const save = useMutation({
    mutationFn: (values: UpsertManualExchangeRateInput) =>
      api<ExchangeRateDto>('/exchange-rates/manual', { method: 'PUT', body: values }),
    onSuccess: () => {
      toast.success('Tipo de cambio guardado');
      void queryClient.invalidateQueries({ queryKey: EXCHANGE_RATES_QUERY_KEY });
      form.reset({ date: today, currency: 'USD', buy: '', sell: '' });
    },
    onError: (err) => {
      form.setError('root', {
        message: err instanceof ApiError ? err.message : 'Error inesperado',
      });
    },
  });

  if (user.role !== Role.ADMINISTRADOR) {
    return (
      <div role="alert" className="text-sm text-muted-foreground">
        No tienes permiso para ver esta sección.
      </div>
    );
  }

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Tipo de cambio</h1>
        <p className="text-sm text-muted-foreground">
          Se consulta a apis.net.pe (SUNAT) por fecha y se cachea. Si la API externa falla, el
          sistema usa el último valor conocido; aquí puedes registrar uno a mano.
        </p>
      </div>

      <Card className="max-w-md">
        <CardHeader>
          <CardTitle className="text-base">Registrar manualmente</CardTitle>
        </CardHeader>
        <CardContent>
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
                  name="date"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Fecha</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Moneda</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {CURRENCIES.filter((c) => c !== 'PEN').map((c) => (
                            <SelectItem key={c} value={c}>
                              {CURRENCY_LABELS[c]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="buy"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Compra</FormLabel>
                      <FormControl>
                        <Input inputMode="decimal" placeholder="3.7500" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="sell"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Venta</FormLabel>
                      <FormControl>
                        <Input inputMode="decimal" placeholder="3.7600" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <Button type="submit" disabled={save.isPending} className="justify-self-start">
                {save.isPending ? 'Guardando…' : 'Guardar'}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fecha</TableHead>
              <TableHead>Moneda</TableHead>
              <TableHead>Compra</TableHead>
              <TableHead>Venta</TableHead>
              <TableHead>Origen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rates.isPending &&
              [0, 1, 2].map((i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {rates.isError && (
              <TableRow>
                <TableCell colSpan={5} className="text-destructive">
                  No se pudo cargar el historial de tipo de cambio.
                </TableCell>
              </TableRow>
            )}
            {rates.data?.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.date}</TableCell>
                <TableCell>{CURRENCY_LABELS[r.currency]}</TableCell>
                <TableCell>{r.buy}</TableCell>
                <TableCell>{r.sell}</TableCell>
                <TableCell>
                  {r.source === 'API' ? (
                    <Badge variant="secondary">apis.net.pe</Badge>
                  ) : (
                    <Badge variant="outline">Manual</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {rates.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  Sin registros todavía.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
