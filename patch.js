const fs = require('fs');
let c = fs.readFileSync('apps/api/src/sales/sales-orders.service.ts', 'utf8');
const newMethod = `
  private async computeReadinessMap(orderIds: string[]): Promise<Map<string, OrderReadinessDto>> {
    if (orderIds.length === 0) return new Map();
    const ops = await this.prisma.productionOrder.findMany({
      where: {
        kind: 'ROOFING',
        reservation: { salesOrderId: { in: orderIds } },
      },
      select: {
        status: true,
        planMeters: true,
        metersReported: true,
        reservation: { select: { salesOrderId: true } },
      },
    });

    const byOrder = new Map<string, ReadinessOrder[]>();
    for (const id of orderIds) byOrder.set(id, []);

    for (const op of ops) {
      const orderId = op.reservation!.salesOrderId!;
      byOrder.get(orderId)!.push({
        status: op.status,
        orderedMl: op.planMeters?.toFixed(3) ?? '0.000',
        reportedMl: op.metersReported?.toFixed(3) ?? '0.000',
      });
    }

    const map = new Map<string, OrderReadinessDto>();
    for (const [id, ops] of byOrder.entries()) {
      map.set(id, deriveOrderReadiness(ops));
    }
    return map;
  }
`;
c = c.replace(/  \/\/ -------------------------------------------------------------------------\n  \/\/ Lectura/, newMethod + '\n  // -------------------------------------------------------------------------\n  // Lectura');
fs.writeFileSync('apps/api/src/sales/sales-orders.service.ts', c);
