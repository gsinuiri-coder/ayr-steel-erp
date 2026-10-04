# Ventana D-383 — proteger la anulación de un pedido

## Ejecutada el 2026-10-04: sin incidencias

Cada paso sensible tuvo el OK explícito del dueño (D-251/D-232). Sin migración.

| Qué                                  | Resultado                                                                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UAT                                  | Confirmado por el dueño en demo sobre `e7a1c14` (`env:demo` + `db:demo` + `dev:demo` desde `../ayr-d383`). Después se sumó `b4857c1`, unidad legible en el diálogo, a pedido del dueño    |
| Reacomodo                            | `main` había avanzado a `e828f1d` (#92) y el PR quedó `CONFLICTING`. Se reacomodó: el conflicto fue solo de docs y el código quedó idéntico a `b4857c1`. Commit desplegado: **`4528b65`** |
| CI                                   | Corrida 37181329875 en `4528b65`: E2E 503 pasados, smoke Neon `ci` 36 pasados; lint, typecheck, unitarios y Sonar en verde                                                                |
| Foto de impacto (`READ ONLY`)        | 2026-10-04 05:30 UTC (`local-data/d383/foto-impacto-2026-10-04T0530.json`). Ver «Qué cambia hoy en producción»                                                                            |
| Revisión API anterior (vuelta atrás) | `ayr-steel-erp-api-00080-wgf`, `git-sha=99e76b0`                                                                                                                                          |
| Demo                                 | Apagada antes del deploy                                                                                                                                                                  |
| Paso 1: deploy de la API             | **`ayr-steel-erp-api-00081-p5g`**, al 100 %, `git-sha=4528b65`, `/health` 200, `smoke:prod` 8/8 con la web vieja                                                                          |
| Paso 2: merge del #90                | `main` = **`7e7ba9d`**, diff de runtime vacío contra `4528b65`, Vercel `success`, `smoke:prod` 8/8 en `vercel.app` y 8/8 en `v2.mareliac.pe`. Salidas completas guardadas en archivo      |

## Qué cambia en producción

- **Anular un pedido se bloquea** con:
  - un comprobante vivo que todavía factura alguna línea (neto de D-346);
  - un borrador de factura o boleta, nombrado y sin borrado automático;
  - un despacho vigente.

  No bloquea un comprobante acreditado por completo con notas de crédito vivas, así que la
  anulación del mostrador sigue igual.

- **Con producto fabricado sin despachar**, el diálogo lo lista por línea y exige una casilla. El
  API también la exige (`acknowledgeFabricated`) y la audita (`fabricatedLoose`).
- **Un borrador de un pedido anulado** ya no se registra ni se emite.
- **La alerta «no se puede anular»** sale solo con una OP viva.
- **Aviso** al anular un pedido que tiene comprobantes manuales anulados.
- **Los dos P2 de cc16**: el menú del pedido y el detalle del comprobante.

**Qué cambia hoy en producción** (foto de impacto). Hay 4 pedidos abiertos:

- **PED-000001, PED-000015 y PED-000019**: anularlos pide la casilla. Tienen producto fabricado
  sin despachar (OP-000001, OP-000002, OP-000020 y OP-000023, cerradas).
- **PED-000047**: anularlo se bloquea mientras FFA1-00001367 siga vigente.
- **Borradores en producción: 0**. Ningún borrador queda afectado.

## Cierre

- El worktree `../ayr-d383` y la rama `d383/proteger-anular-pedido` (local y remota) se borraron.
  Antes se copió y verificó su `local-data` en el checkout principal.
- El PR de docs de este cierre está sin merge.

## Lo que queda abierto en el proyecto (al 2026-10-04)

1. **Orden único de bloqueos en despacho y reversas.** Es la **siguiente pieza, después de cc17**.
   cc17 es D-385, el importador de bobina en toneladas y sin stock: está en curso en otra sesión,
   con prioridad alta (dueño, 2026-10-04). Origen: P2-1 y P2-2 de
   `docs/revision/cc15b-p2b-segundo-modelo.md`. Detalle en `docs/PROGRESO.md`, «Pendiente».
2. **Respaldos Neon con fecha de borrado.** Se borran solo con el OK del dueño por nombre:
   - `respaldo-pre-cc16-20261003` (`br-late-poetry-aewbwyl6`): se conserva hasta el 2026-10-11;
   - `respaldo-pre-replaceentry-20261003` (`br-rapid-river-ae59y2vw`), de cc15b;
   - se repasa el resto según `AGENTS.md` §3.3.
3. **Decisiones propuestas o sin implementar:**
   - **D-380**: corregir las líneas de un manual vivo sin anularlo, conservando los cobros. No
     tiene fecha: los comprobantes afectados no tienen cobros;
   - **D-367**: crear productos o SKU solo desde Catálogo. Es regla de producto, sin implementar;
   - **D-362**: resetear las contraseñas de todos los usuarios al restablecer demo. Está en
     backlog.
4. **P3 abiertos de D-383:**
   - la confirmación no queda atada a la vista previa;
   - `purgeSalesTrail` y `purgeRoofingTrail` (limpieza E2E) siguen sin avisar si un pedido no se
     anula.
5. **P2/P3 sin corregir de entregas anteriores.** Las listas están en sus entradas de
   `docs/PROGRESO.md`:
   - de cc14 y cc15a: por ejemplo, que el cambio de producto no toca la descripción del papel,
     pasar a contado, el «antes» del vencimiento y una serie heredada fuera de formato;
   - de cc16: el tercer pase del emparejado de D-381 sin mirar importes, y el refetch al
     terminar.
6. **Descarga de comprobantes en Excel.** El alcance está por definir.
7. **D-374, punto 3.** Falta el cambio de la herramienta `fix:purchase-received-dates`, que hoy
   excluye las compras con salidas posteriores. El dueño eligió no cambiarla por ahora (opción B).
8. **Registro de riesgo.** Hay piezas marcadas «PENDIENTE DE REVISIÓN DEL DUEÑO» en
   `docs/PROGRESO.md` («Registro de riesgo»). Desde 2026-09-26 son un registro de dónde mirar
   primero, no una deuda de revisión, salvo que el dueño diga otra cosa.
9. **Ramas remotas de sesiones anteriores**, si quedan. Las borra el dueño, salvo que pida lo
   contrario.
