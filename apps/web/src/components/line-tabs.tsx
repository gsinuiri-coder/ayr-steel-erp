'use client';

import { BUSINESS_LINE_LABELS, type BusinessLine } from '@ayr/shared';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ALL_LINES_TAB, type LineTab } from '@/lib/line-tabs';

/**
 * cc23: las pestañas de línea de negocio de un reporte. Los nombres salen del mapa central
 * (`BUSINESS_LINE_LABELS`, D-174); el estado lo lleva `useLineTab`, en la URL.
 */
export function LineTabs({
  lines,
  includeAll,
  value,
  onChange,
}: {
  lines: readonly BusinessLine[];
  includeAll: boolean;
  value: LineTab;
  onChange: (tab: LineTab) => void;
}) {
  return (
    <Tabs
      activationMode="manual"
      value={value}
      onValueChange={(next) => {
        onChange(next as LineTab);
      }}
    >
      <TabsList aria-label="Línea de negocio" data-testid="pestanas-linea">
        {includeAll && <TabsTrigger value={ALL_LINES_TAB}>Todas</TabsTrigger>}
        {lines.map((line) => (
          <TabsTrigger key={line} value={line}>
            {BUSINESS_LINE_LABELS[line]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
