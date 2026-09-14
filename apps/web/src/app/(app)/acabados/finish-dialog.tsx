'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  BUSINESS_LINE_LABELS,
  COIL_BUSINESS_LINES,
  FINISH_KIND_LABELS,
  FinishKind,
  finishColorError,
  finishKindHasColor,
  type FinishDto,
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
import {
  Form,
  FormControl,
  FormDescription,
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
import { ColorSelect } from '@/components/colors/color-select';

const FINISHES_QUERY_KEY = ['finishes'] as const;

const KINDS = [FinishKind.NATURAL, FinishKind.PREPINTADO, FinishKind.GALVANIZADO] as const;

const formSchema = z
  .object({
    code: z.string().trim().min(1, 'Obligatorio').max(20),
    name: z.string().trim().min(2, 'Mínimo 2 caracteres').max(120),
    densityFactor: z.string().trim().min(1, 'Obligatorio'),
    // String y no enum: el formulario arranca sin tipo elegido (`''`).
    kind: z
      .string()
      .refine((v) => (KINDS as readonly string[]).includes(v), 'Elige el tipo de acabado'),
    colorId: z.string(),
    businessLine: z.string().min(1, 'Elige la línea del acabado'),
  })
  .superRefine((v, ctx) => {
    if (!isKind(v.kind)) return;
    const error = finishColorError(v.kind, v.colorId === '' ? null : v.colorId);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['colorId'], message: error });
  });
type FormValues = z.infer<typeof formSchema>;

function isKind(value: string): value is FinishKind {
  return (KINDS as readonly string[]).includes(value);
}

interface Props {
  open: boolean;
  finish?: FinishDto;
  onOpenChange: (open: boolean) => void;
}

/**
 * Alta y edición de un acabado (RF-25, D-203): tipo + color + línea. El color solo aparece con
 * «Prepintado», que es el único tipo que lo lleva — ofrecerlo en los otros sería pedir un dato
 * que la base rechaza.
 */
export function FinishDialog({ open, finish, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const editing = !!finish;
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      code: finish?.code ?? '',
      name: finish?.name ?? '',
      densityFactor: finish?.densityFactor ?? '',
      kind: finish?.kind ?? '',
      colorId: finish?.colorId ?? '',
      businessLine: finish?.businessLine ?? '',
    },
  });
  const kind = form.watch('kind');
  const withColor = isKind(kind) && finishKindHasColor(kind);

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      const identity = {
        kind: values.kind,
        colorId: withColor && values.colorId !== '' ? values.colorId : null,
        businessLine: values.businessLine,
      };
      if (editing) {
        return api<FinishDto>(`/finishes/${finish.id}`, {
          method: 'PATCH',
          body: { name: values.name, densityFactor: values.densityFactor, ...identity },
        });
      }
      return api<FinishDto>('/finishes', {
        method: 'POST',
        body: {
          code: values.code,
          name: values.name,
          densityFactor: values.densityFactor,
          ...identity,
        },
      });
    },
    onSuccess: () => {
      toast.success(editing ? 'Acabado actualizado' : 'Acabado creado');
      void queryClient.invalidateQueries({ queryKey: FINISHES_QUERY_KEY });
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
          <DialogTitle>{editing ? 'Editar acabado' : 'Nuevo acabado'}</DialogTitle>
          <DialogDescription>
            El color de las bobinas sale del acabado: una bobina prepintada se registra eligiendo su
            acabado, sin cargar el color aparte.
          </DialogDescription>
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
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Código</FormLabel>
                  <FormControl>
                    <Input disabled={editing} autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nombre</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="businessLine"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Línea</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full" aria-label="Línea">
                        <SelectValue placeholder="Elige la línea" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {COIL_BUSINESS_LINES.map((line) => (
                        <SelectItem key={line} value={line}>
                          {BUSINESS_LINE_LABELS[line]}
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
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tipo</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      field.onChange(v);
                      form.clearErrors('colorId');
                    }}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full" aria-label="Tipo">
                        <SelectValue placeholder="Elige el tipo" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {FINISH_KIND_LABELS[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {withColor && (
              <FormField
                control={form.control}
                name="colorId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Color</FormLabel>
                    <ColorSelect
                      value={field.value}
                      onChange={field.onChange}
                      allowEmpty={false}
                      placeholder="Elige el color"
                    />
                    <FormDescription>
                      Los colores se administran en Catálogo → Colores.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="densityFactor"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Factor de densidad</FormLabel>
                  <FormControl>
                    <Input inputMode="decimal" autoComplete="off" {...field} />
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
              <Button
                type="submit"
                disabled={save.isPending}
                pending={save.isPending}
                pendingText="Guardando…"
              >
                {editing ? 'Guardar cambios' : 'Crear acabado'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
