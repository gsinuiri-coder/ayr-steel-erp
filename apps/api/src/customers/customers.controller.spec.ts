import { CustomersController } from './customers.controller';
import type { CustomersService } from './customers.service';
import type { DocumentLookupService } from './document-lookup.service';

describe('CustomersController.search (RF-S3/M1)', () => {
  const customers = { search: jest.fn() };
  const controller = new CustomersController(
    customers as unknown as CustomersService,
    {} as DocumentLookupService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delega el texto validado al servicio', async () => {
    customers.search.mockResolvedValue([]);

    await expect(controller.search({ q: 'ACME' })).resolves.toEqual([]);
    expect(customers.search).toHaveBeenCalledWith('ACME');
  });

  it('conserva la búsqueda inicial sin texto', async () => {
    customers.search.mockResolvedValue([]);

    await controller.search({});
    expect(customers.search).toHaveBeenCalledWith(undefined);
  });
});
