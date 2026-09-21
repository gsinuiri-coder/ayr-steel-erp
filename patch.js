const fs = require('fs');
let c = fs.readFileSync('apps/api/src/sales/quotations.service.ts', 'utf8');

c = c.replace(
  "if (!source) throw new NotFoundException('Cotización no encontrada');",
  "if (!source) throw new NotFoundException('Cotización no encontrada');\n    if (actor) assertSellerAccess(actor, source.sellerId, 'Cotización');",
);

c = c.replace(
  '          notes: source.notes,\n          createdById: actor.id,\n          items: { create: lines.map(toItemCreate) },',
  '          notes: source.notes,\n          createdById: actor.id,\n          sellerId: actor.id,\n          items: { create: lines.map(toItemCreate) },',
);

fs.writeFileSync('apps/api/src/sales/quotations.service.ts', c);
