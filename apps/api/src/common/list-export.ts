import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import {
  DERIVED_FILTER_FETCH_CAP,
  LIST_XLSX_MAX_ROWS,
  listExportTooLargeMessage,
  toSkipTake,
} from '@ayr/shared';

/**
 * cc26 (D-provisional): la ventana de filas que pide un listado paginado.
 *
 * La lista y su Excel llaman al **mismo** método de servicio: la lista con la ventana de su
 * página (`pageWindow`) y el Excel con la ventana completa (`exportWindow`). Así las filas del
 * archivo son exactamente las DTOs de la pantalla —mismo filtro, mismo alcance del vendedor,
 * mismo orden—, y no una segunda consulta escrita aparte que pueda divergir de la primera.
 *
 * `maxTotal` solo lo lleva la exportación: el servicio cuenta antes de traer filas y, si el total
 * pasa el tope, corta con 400 sin haber cargado nada (`assertExportable`).
 */
export interface ListWindow {
  skip: number;
  take: number;
  maxTotal?: number;
}

/** La ventana de una página de la lista. */
export function pageWindow(query: { page: number; pageSize: number }): ListWindow {
  return toSkipTake(query);
}

/** La ventana del Excel: todas las filas, hasta el tope declarado. */
export function exportWindow(max: number = LIST_XLSX_MAX_ROWS): ListWindow {
  return { skip: 0, take: max, maxTotal: max };
}

/** 400 si el total de la exportación pasa su tope. Nunca un archivo recortado en silencio. */
export function assertExportable(total: number, window: ListWindow): void {
  if (window.maxTotal !== undefined && total > window.maxTotal) {
    throw new BadRequestException(listExportTooLargeMessage(total, window.maxTotal));
  }
}

/**
 * cc26 (segundo modelo, P2 R1). Un filtro derivado (`pendingOnly`, `onlyWithBalance`) se aplica
 * en memoria sobre un universo que la consulta ya cortó en `DERIVED_FILTER_FETCH_CAP`. Si ese
 * universo llegó al corte, puede haber filas que cumplen el filtro y quedaron fuera: la lista lo
 * arrastra desde antes, pero la exportación no puede entregar un archivo incompleto (D-446), así
 * que responde 400. La lista paginada no cambia.
 */
export function assertDerivedUniverseComplete(fetched: number, window: ListWindow): void {
  if (window.maxTotal !== undefined && fetched >= DERIVED_FILTER_FETCH_CAP) {
    throw new BadRequestException(
      `La exportación con este filtro parte de más de ${String(DERIVED_FILTER_FETCH_CAP)} filas y podría quedar incompleta: acota los filtros.`,
    );
  }
}

/** Envía un xlsx como descarga (listas y reportes). */
export function sendXlsx(res: Response, file: { buffer: Buffer; filename: string }): void {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.buffer);
}
