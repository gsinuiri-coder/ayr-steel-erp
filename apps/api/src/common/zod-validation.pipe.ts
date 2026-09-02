import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

/** Valida el body/query con un schema Zod de @ayr/shared y devuelve el valor tipado. */
@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const flat = result.error.flatten();
      throw new BadRequestException({
        statusCode: 400,
        message: 'Datos inválidos',
        errors: { ...flat.fieldErrors, _form: flat.formErrors },
      });
    }
    return result.data as z.infer<T>;
  }
}
