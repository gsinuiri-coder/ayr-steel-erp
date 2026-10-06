import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { LIST_XLSX_MAX_ROWS, listExportTooLargeMessage, toSkipTake } from '@ayr/shared';

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
 * Envía un xlsx como descarga. Es el mismo `sendXlsx` privado de `reports.controller.ts`; el de
 * reportes queda donde está hasta que se unifiquen.
 */
export function sendXlsx(res: Response, file: { buffer: Buffer; filename: string }): void {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.buffer);
}
