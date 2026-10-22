# Ventana cc65 · venta por mostrador de la cobertura en stock e higiene de audit-02

21–22/10/2026, sesión atendida.

- **Decisiones nuevas:** D-697 (forma aprobada por el dueño) y D-709 (decisión del dueño), por ratificar.
- **Registro del dueño (21/10):** D-705..D-707 ratificadas, alta desde el padrón aprobada, UAT de cc64 aprobado y regla
  de cierre D-708 (PR #246).
- **Migraciones:** ninguna.
- **`--execute`:** ninguno.
- **SQL contra producción:** ninguno.
- **Demo:** sin cambios. **Neon:** sin cambios de ramas.

## En producción

| Qué   | Corte A (PR #247)                   | Corte B (PR #248)                   |
| ----- | ----------------------------------- | ----------------------------------- |
| API   | `00151-qn4` (`git-sha=06acf58c`)    | `00152-7hz` (`git-sha=cc569224`)    |
| Merge | `6f7c2844`                          | `1ba03313`                          |
| Smoke | verde (`--expect-api-sha 06acf58c`) | verde (`--expect-api-sha cc569224`) |

- **Orden:** en cada corte, la API se desplegó desde la rama antes del merge (regla 11). `git diff` de runtime entre la
  etiqueta y `main`: vacío.
- **Vuelta atrás:** `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=ayr-steel-erp-api-00151-qn4=100`
  y revert del merge del #248 (para volver antes del corte A, `00150-75k` y revert del #247).
- **Incidente externo:** el deploy del corte B falló tres veces (22/10, 02:58–03:21 UTC) por 502/503 del registro de
  npm al bajar pnpm en Cloud Build. El tráfico no se movió de `00151-qn4`; se desplegó cuando el registro volvió.

## Qué entró

- **D-697 (corte A):**
  - `sales/sales-lines.ts`: opción `fromFinishedStock`, que solo pasa `createDirectInTx` con `counterSale`.
  - `pos/pos.service.ts`: el buscador ofrece la cobertura terminada con saldo libre.
  - Panel de stock con `counter=1` (saldo y piso por unidad).
  - `sales-order-edits.service.ts`: un pedido del mostrador no se edita.
  - `reports/document-profitability.ts`: la línea servida solo desde stock se costea por su despacho (A-01).
  - El aviso de anular pedido dice que lo fabricado suelto se puede vender en el mostrador.
- **Higiene (corte B):**
  - SEC-02: tope de la sesión en el access token.
  - SEC-03: `ipBucket` normaliza la IPv4 mapeada en cualquier escritura.
  - SEC-05/A2-07 (D-709): `sessions.ip` y `auth.refresh.reuse` guardan el código de D-694.
  - NC-03: NC 03/13 sobre un comprobante acreditado por completo se rechaza.
  - Fechas imposibles rechazadas en todos los campos de fecha de comprobantes.
  - `carga:revisar`: bloque al inicio con los clientes que se crearán desde el padrón.
  - PERM-01, REG-01 (regla 8 nombra `recostEntries`), REG-02 y los dos mensajes con voseo.

## Pruebas

- **Unitarias:** API 3918 en verde (sobre el merge del B con `main`).
- **`test:db`:** corte A 248 de 248 (`ayr_local_e2e_cc65db`); corte B 242 de 242 (`ayr_local_e2e_cc65bdb`).
- **E2E local completa** (build de producción, `CI=true`), en cada corte: 619 pasadas, 19 rojas, 1 inestable y 2
  omitidas. Las 19 son las mismas de infraestructura local de cc63 y cc64 (PSE apagado, CLI contra la base de Docker y
  el XML de `fase2a`).
- **CI de #247 y #248:** en verde, incluidos los dos shards, drift, smoke de Neon `ci` y SonarCloud.

## Revisiones

- **Corte A:** autorrevisión (A-01..A-06) y segundo modelo (R-01..R-08), sin P0 ni P1. A-01, A-03, A-04 y A-06
  corregidos.
- **Corte B:** autorrevisión (P2-1, P2-2, P3) y segundo modelo (R-01..R-05), sin P0 ni P1. P2-1, P2-2, P3-2, R-01 y
  R-03 corregidos.
- Respuestas del autor en cada informe.

## No se hace (queda anotado)

- **Sin prueba propia:** la reserva de producto terminado que abre una OP, la NC con devolución y el despacho parcial
  sobre una línea de cobertura del mostrador. Por lectura se tratan como cualquier producto de stock.
- **Fechas imposibles fuera de comprobantes:** las fechas de cotizaciones y pedidos (`sales.ts`) siguen con
  `Date.parse`, y entran.
- **IP en claro heredada:** las filas viejas de `sessions.ip` se borran al renovar o vencen a los 30 días.
  `audit_log` no se toca.
- **`inspect:audit02`:** queda en `local-data` (decisión del dueño).

## Pendiente

- **Dueño:**
  - ratificar D-697 y D-709;
  - hacer el UAT de `docs/uat/cc65.md`;
  - decidir si revertir un reporte de OP sigue trabándose por una venta posterior de mostrador del mismo código.
- **Para la carga real:** plan lleno y OK por nombre del lote, antes del **12/01/2027**.
- **cc62:** el importador de saldos (al final de todo) y NC-02.
