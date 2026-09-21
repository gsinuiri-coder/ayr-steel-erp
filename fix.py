import re

with open('apps/api/src/inventory/inventory.service.spec.ts', 'r', encoding='utf-8') as f:
    content = f.read()

testCode = '''
    it('Punto 8: ordena establemente y calcula saldo corrido de 5 movimientos en el mismo dia', async () => {
      const m1 = movement(10n, '2026-09-15');
      m1.qty = new Decimal('100.000');
      const m2 = movement(11n, '2026-09-15');
      m2.type = 'OUT';
      m2.qty = new Decimal('20.000');
      const m3 = movement(12n, '2026-09-15');
      m3.type = 'OUT';
      m3.qty = new Decimal('10.000');
      const m4 = movement(13n, '2026-09-15');
      m4.qty = new Decimal('50.000');
      const m5 = movement(14n, '2026-09-15');
      m5.type = 'OUT';
      m5.qty = new Decimal('30.000');
      const prisma = setReadPrisma([m1, m2, m3, m4, m5]);
      const result = await service.findMovements(
        { itemType: 'COIL', itemId: ITEM },
        true,
      );
      expect(prisma.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ operationDate: 'asc' }, { at: 'asc' }, { id: 'asc' }],
        }),
      );
      expect(result.items.map((r) => r.balanceQty)).toEqual([
        '100.000', '80.000', '70.000', '120.000', '90.000',
      ]);
    });
'''

content = content.replace("describe('consulta del kardex (D-237)', () => {", "describe('consulta del kardex (D-237)', () => {" + testCode)
content = content.replace("[{ operationDate: 'asc' }, { id: 'asc' }]", "[{ operationDate: 'asc' }, { at: 'asc' }, { id: 'asc' }]")

with open('apps/api/src/inventory/inventory.service.spec.ts', 'w', encoding='utf-8') as f:
    f.write(content)
