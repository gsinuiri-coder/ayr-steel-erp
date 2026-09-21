const fs = require('fs');

let content = fs.readFileSync('apps/api/src/inventory/inventory.service.spec.ts', 'utf8');

const testCode =
  '\n' +
  "    it('Punto 8: ordena establemente y calcula saldo corrido de 5 movimientos en el mismo dia', async () => {\n" +
  "      const m1 = movement(10n, '2026-09-15');\n" +
  "      m1.qty = new Decimal('100.000');\n" +
  "      const m2 = movement(11n, '2026-09-15');\n" +
  "      m2.type = 'OUT';\n" +
  "      m2.qty = new Decimal('20.000');\n" +
  "      const m3 = movement(12n, '2026-09-15');\n" +
  "      m3.type = 'OUT';\n" +
  "      m3.qty = new Decimal('10.000');\n" +
  "      const m4 = movement(13n, '2026-09-15');\n" +
  "      m4.qty = new Decimal('50.000');\n" +
  "      const m5 = movement(14n, '2026-09-15');\n" +
  "      m5.type = 'OUT';\n" +
  "      m5.qty = new Decimal('30.000');\n" +
  '      const prisma = setReadPrisma([m1, m2, m3, m4, m5]);\n' +
  '      const result = await service.findMovements(\n' +
  "        { itemType: 'COIL', itemId: ITEM },\n" +
  '        true,\n' +
  '      );\n' +
  '      expect(prisma.findMany).toHaveBeenCalledWith(\n' +
  '        expect.objectContaining({\n' +
  "          orderBy: [{ operationDate: 'asc' }, { at: 'asc' }, { id: 'asc' }],\n" +
  '        }),\n' +
  '      );\n' +
  '      expect(result.items.map((r) => r.balanceQty)).toEqual([\n' +
  "        '100.000', '80.000', '70.000', '120.000', '90.000',\n" +
  '      ]);\n' +
  '    });\n';

content = content.replace(
  "describe('consulta del kardex (D-237)', () => {",
  "describe('consulta del kardex (D-237)', () => {" + testCode,
);
content = content.replace(
  "[{ operationDate: 'asc' }, { id: 'asc' }]",
  "[{ operationDate: 'asc' }, { at: 'asc' }, { id: 'asc' }]",
);

fs.writeFileSync('apps/api/src/inventory/inventory.service.spec.ts', content, 'utf8');
