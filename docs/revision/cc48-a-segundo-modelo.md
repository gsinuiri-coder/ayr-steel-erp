# Revisión del segundo modelo — cc48 corte A

**Alcance revisado:** `96270eda...cc48-a-restos`, 8 commits (1196b37f, 737aa863, bd8d8e8c, 67c6b9c4, 4d61d222, 82e6ffc6, c37e03ba, 64e4af7c), 38 archivos. Diff completo leído; puntos dudosos verificados con `git show cc48-a-restos:<ruta>`. Sin tests ni servidores.

## P0

Ninguno.

## P1

Ninguno. Verificado como correcto:

- **Cobranzas, filtro y paginación.** `filterReceivablesBySearch` filtra el resumen en memoria antes de paginar; `total` y las páginas son las del filtro. `assertExportable` cuenta las filas filtradas.
- **Cobranzas, tarjetas y Excel.** `receivables/summary` no recibe `search`; el Excel sí, por `receivablesExportQuerySchema`, que omite `page` y `pageSize`.
- **Bobinas, PDF.** `coils/pdf` valida `search` con `reportXlsxSearchSchema` y filtra con el mismo `searchCoilMonth` que el Excel.
- **Tailwind.** `hidden` sobre un `ul` con `flex` funciona por el preflight de Tailwind 4.3.
- **Seed.** `/annul` acepta todo lo que no es `ISSUED_HERE`, `ACCEPTED` y no archivado; `origin` está en los dos DTO.

## P2

1. **«Por línea» (Ventas y margen) y «Por OP»/«Por pedido» (Producción) siguen con una fila de total en la misma columna que las filas.** `SUM(B:B)` de «Por línea» da el doble; en Producción, OPs + Total. Arreglo: sacar el total de la columna sumable o corregir el comentario.

## P3

1. Cobranzas: el buscar distingue tildes («Perez» no encuentra «Pérez»); los reportes usan los buscadores de `@ayr/shared`, que no las distinguen.
2. Cobranzas: el esquema limita `search` a 80 caracteres y la web no recorta `rSearch`; una URL manual más larga da 400.
3. `LineTotalsStrip` decide solo con `ResizeObserver(document.body)` y `resize`; si la franja cambia de alto sin que cambie el body, la decisión queda vieja. Además escribe en `heights.current` dentro del updater (idempotente).
4. La franja no tiene prueba de comportamiento (plegado real, clic manual, `aria-expanded`).
5. `voidPrevious`: `/annul` solo vale para `ACCEPTED`; otro estado queda registrado como falla por `attempt`. Aceptable.
6. `exportReceivables(query = {})` conserva un default sin uso. Inofensivo.

## Conclusión

Coherente: las cifras no cambian; sin P0 ni P1. Corregir o decidir el P2 antes del merge.

## Qué se hizo (sesión)

- P2: corregido. Las hojas nuevas no llevan fila de total en la columna sumable: «Por línea» queda solo con las líneas y el redondeo (su suma es la venta de la franja, que está en «Totales»); Producción queda con «Por OP» y «Por pedido» sin total, y el total va en su propia hoja «Total».
- P3-1: corregido, el buscar de «Por cliente» usa `filterBySearch` de `@ayr/shared` (sin tildes ni mayúsculas, por palabras).
- P3-2: corregido, la web recorta `rSearch` a 80 caracteres.
- P3-3: corregido, la franja también observa su propio alto.
- P3-4: cubierto por el E2E nuevo de la franja (`cc48-restos.spec.ts`).
- P3-5 y P3-6: anotados.
