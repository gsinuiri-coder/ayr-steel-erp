import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

/** Valida el body/query con un schema Zod de @ayr/shared y devuelve el valor tipado. */
@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    // Un POST/PATCH sin cuerpo llega acá como `undefined` (Express no parsea nada sin
    // `Content-Type: application/json`, y el cliente del web no lo manda cuando `body` es
    // `undefined`). Para un schema con todos los campos opcionales eso es exactamente `{}`;
    // para uno con campos obligatorios, sigue fallando la validación como antes, solo que
    // con el error por campo en vez del genérico `_form: ["Required"]`.
    const result = this.schema.safeParse(value ?? {});
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
