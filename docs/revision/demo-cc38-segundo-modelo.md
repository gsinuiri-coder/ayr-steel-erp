# Revisión de segundo modelo — demo-cc38 (D-579, PDF de la cotización)

Alcance: `git diff origin/main...HEAD` (un commit): `quotation-pdf.ts`, spec nuevo
`quotation-pdf-unit.spec.ts`, notas en `docs/DECISIONES.md` y `docs/ARQUITECTURA.md`.

## Verificaciones

- Único llamador de `buildQuotationPdf`: `quotations.service.ts#renderPdf` (línea ~1109), que pasa
  `i.unit` de la línea guardada. El PDF solo se genera para almacenar en R2 y enviar al cliente;
  no alimenta SUNAT, XML ni PSE. El código guardado en la línea no cambia (solo la vista).
- `unitSymbol` mapea KGM, NIU, MTR, TNE, ZZ y deja pasar códigos desconocidos tal cual. No hay
  línea que deba conservar el código.
- El test nuevo corre en verde con el cambio. Se revirtió temporalmente la línea (sin cambio) y el
  primer test falla («NIU» escrito), así que el test sí detecta la regresión. Se restauró el
  archivo; el árbol queda limpio.
- Docs: ARQUITECTURA D-579 y DECISIONES coinciden entre sí; la ratificación de D-574 en
  DECISIONES.md y la nota añadida a la fila D-574 son consistentes.

## Hallazgos

- P3 — El segundo test («la cantidad sin decimales») no depende del cambio: `formatQty` ya
  recortaba ceros antes. Pasa con y sin el cambio, así que no protege D-579; es inocuo.
- P3 — `ZZ` se muestra como cadena vacía (`unitSymbol('ZZ') === ''`): una línea con unidad `ZZ`
  deja la columna «Unidad» en blanco en la cotización. Es el comportamiento ya existente del
  mapa compartido; solo conviene saberlo si alguna cotización usa `ZZ`.
- P3 — El spec mockea `pdfkit` completo: no detecta si cambia la API real de pdfkit. Aceptable
  para este alcance.

Sin P0, P1 ni P2.

## Veredicto

Aprobado. Cambio mínimo, correcto, de solo presentación, sin impacto en SUNAT ni en datos.
(Esto es un pase de segundo modelo; no sustituye la revisión del dueño al cierre.)
