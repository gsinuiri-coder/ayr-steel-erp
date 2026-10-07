'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { businessToday } from '@ayr/shared';
import { ListStateMessage } from '@/components/list-state';
import { defaultPeriod, readStoredPeriod, sessionStore } from '@/lib/report-period';
import { reportHref, reportSectionsFor } from '@/lib/reports-index';
import { useSession } from '@/lib/session';

/**
 * cc32 — inicio de Reportes (`/reportes`, antes un 404): los reportes que el rol puede abrir,
 * agrupados por la pregunta que responden. Los enlaces llevan el último periodo elegido en la
 * sesión, o el mes en curso.
 */
export function ReportesIndexView() {
  const { user } = useSession();
  const today = businessToday();
  // Lo guardado se lee después de montar: el servidor no tiene `sessionStorage`.
  const [period, setPeriod] = useState(() => defaultPeriod(today, null));
  useEffect(() => {
    const today = businessToday();
    setPeriod(defaultPeriod(today, readStoredPeriod(sessionStore(), today)));
  }, []);
  const sections = reportSectionsFor(user.role);

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Reportes</h1>
        <p className="text-sm text-muted-foreground">
          Se abren con el mes en curso. El periodo que elijas se mantiene al pasar de un reporte a
          otro.
        </p>
      </div>
      {sections.length === 0 && (
        <ListStateMessage
          title="No tienes reportes disponibles"
          hint="Los reportes son del administrador y, algunos, de planta."
        />
      )}
      {sections.map((section) => (
        <section
          key={section.title}
          className="space-y-2"
          aria-labelledby={sectionId(section.title)}
        >
          <h2
            id={sectionId(section.title)}
            className="flex h-8 items-center rounded-md bg-muted px-3 text-sm font-semibold"
          >
            {section.title}
          </h2>
          <ul className="flex flex-wrap gap-3">
            {section.reports.map((report) => (
              <li key={report.href} className="flex min-w-0 flex-[1_1_300px]">
                <Link
                  href={reportHref(report.href, period, today)}
                  data-testid="tarjeta-reporte"
                  className="flex w-full flex-col gap-0.5 rounded-lg border bg-card px-3.5 py-3 transition-colors hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <report.icon className="size-4 text-muted-foreground" aria-hidden />
                    {report.title}
                  </span>
                  <span className="text-xs text-muted-foreground">{report.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function sectionId(title: string): string {
  return `reportes-${title.toLowerCase().replace(/\s+/g, '-')}`;
}
