const fs = require('fs');
let c = fs.readFileSync('apps/api/src/sales/sales-orders.service.ts', 'utf8');

c = c.replace(
  '    queueStatus: QueueStatus | null = null,\n  ): SalesOrderDto {',
  '    queueStatus: QueueStatus | null = null,\n    readiness: OrderReadinessDto,\n  ): SalesOrderDto {',
);
c = c.replace(
  '      queueStatus,\n      priceChanges: [],\n      isEditable: false,\n    };',
  '      queueStatus,\n      priceChanges: [],\n      isEditable: false,\n      readiness,\n    };',
);

c = c.replace(
  'const actors = await this.resolveActorNames(rows.map((r) => r.createdById));',
  'const [actors, readinessMap] = await Promise.all([\n      this.resolveActorNames(rows.map((r) => r.createdById)),\n      this.computeReadinessMap(rows.map((r) => r.id)),\n    ]);',
);

c = c.replace(
  '        new Map(),\n        actors,\n      );',
  '        new Map(),\n        actors,\n        null,\n        readinessMap.get(r.id)!,\n      );',
);

c = c.replace(
  '      this.computeQueueStatus(row),\n      findPriceChanges(this.prisma, { salesOrderId: id }),',
  '      this.computeQueueStatus(row),\n      findPriceChanges(this.prisma, { salesOrderId: id }),\n      this.computeReadinessMap([id]).then((m) => m.get(id)!),',
);

c = c.replace(
  'const [actors, queueStatus, priceChanges, invoice] = await Promise.all([',
  'const [actors, queueStatus, priceChanges, readiness, invoice] = await Promise.all([',
);

c = c.replace(
  '      ...this.toDto(row, labels, actors, queueStatus),',
  '      ...this.toDto(row, labels, actors, queueStatus, readiness),',
);

fs.writeFileSync('apps/api/src/sales/sales-orders.service.ts', c);
