const fs = require('fs');

let c = fs.readFileSync('apps/api/src/sales/sales.controller.ts', 'utf8');
c = c.replace(
  '  findLinesWithoutOrder(): Promise<LineWithoutOrderDto[]> {\n    return this.orders.findLinesWithoutOrder();',
  '  findLinesWithoutOrder(@CurrentUser() actor: RequestUser): Promise<LineWithoutOrderDto[]> {\n    return this.orders.findLinesWithoutOrder(actor);',
);
fs.writeFileSync('apps/api/src/sales/sales.controller.ts', c);

let s = fs.readFileSync('apps/api/src/sales/sales-orders.service.ts', 'utf8');
s = s.replace(
  '  async findLinesWithoutOrder(): Promise<LineWithoutOrderDto[]> {\n    const reservations = await this.prisma.reservation.findMany({\n      where: { status: ReservationStatus.ACTIVE, itemType: InventoryItemTypeEnum.RAW_MATERIAL },',
  '  async findLinesWithoutOrder(actor: RequestUser): Promise<LineWithoutOrderDto[]> {\n    const reservations = await this.prisma.reservation.findMany({\n      where: { status: ReservationStatus.ACTIVE, itemType: InventoryItemTypeEnum.RAW_MATERIAL, salesOrder: sellerWhere(actor) },',
);
fs.writeFileSync('apps/api/src/sales/sales-orders.service.ts', s);
