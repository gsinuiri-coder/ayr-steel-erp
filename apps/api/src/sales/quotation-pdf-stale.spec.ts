import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { QuotationStatus } from '@prisma/client';
import { QuotationsService } from './quotations.service';

/**
 * Revisión cruzada RF-S4b, decisión 1 del dueño: el barrido corre sin R2, así que la cotización
 * que corrige no puede regenerar su PDF. Si la clave vieja quedara puesta, la descarga serviría
 * el archivo con los importes **de antes**. Se suelta la clave y la descarga lo arma al vuelo.
 */
describe('QuotationsService — PDF que no se puede regenerar', () => {
  const OLD = Buffer.from('PDF viejo: 14678.99');
  const NEW = Buffer.from('PDF vigente: 14679.00');

  function build() {
    const row: { pdfKey: string | null } = { pdfKey: 'quotations/q-1/COT-000002.pdf' };
    const update = jest.fn(({ data }: { data: { pdfKey: string | null } }) => {
      row.pdfKey = data.pdfKey;
      return Promise.resolve({});
    });
    const svc = Object.create(QuotationsService.prototype) as QuotationsService;
    const getObject = jest.fn().mockResolvedValue(OLD);
    Object.assign(svc, {
      logger: new Logger('test'),
      prisma: {
        quotation: {
          findUniqueOrThrow: jest.fn().mockResolvedValue({ seq: 2 }),
          findUnique: jest.fn(() =>
            Promise.resolve({
              id: 'q-1',
              seq: 2,
              status: QuotationStatus.EMITTED,
              validUntil: null,
              pdfKey: row.pdfKey,
              sellerId: null,
            }),
          ),
          update,
        },
      },
      storage: {
        // Sin R2: la subida falla.
        putObject: jest
          .fn()
          .mockRejectedValue(new ServiceUnavailableException('R2 no está configurado')),
        getObject,
      },
      renderPdf: jest.fn().mockResolvedValue(NEW),
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    return { svc, row, update, getObject };
  }

  it('suelta la clave vieja y la descarga devuelve los importes vigentes, nunca los viejos', async () => {
    const { svc, row, update, getObject } = build();
    await (svc as unknown as { generatePdf: (id: string) => Promise<void> }).generatePdf('q-1');
    expect(update).toHaveBeenCalledWith({ where: { id: 'q-1' }, data: { pdfKey: null } });
    expect(row.pdfKey).toBeNull();

    const file = await svc.pdf('q-1');
    expect(file.buffer.equals(NEW)).toBe(true);
    expect(getObject).not.toHaveBeenCalled();
  });
});
