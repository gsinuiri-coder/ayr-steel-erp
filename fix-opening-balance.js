const fs = require('fs');
let file = 'apps/api/src/inventory/inventory.service.ts';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  /private async openingBalance\(\n\s*query: InventoryQuery,\n\s*from: string,\n\s*\): Promise<\{ qty: Decimal; value: Decimal \}> \{/,
  "private async openingBalance(\n    query: Pick<InventoryQuery, 'itemType' | 'itemId'>,\n    from: string,\n  ): Promise<{ qty: Decimal; value: Decimal }> {",
);

fs.writeFileSync(file, content, 'utf8');
