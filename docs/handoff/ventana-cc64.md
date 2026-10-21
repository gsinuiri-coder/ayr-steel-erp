# Ventana cc64 · cargador de la carga atrasada

21/10/2026, sesión atendida.

- **Decisiones nuevas:** D-705 a D-707, provisionales. Las decisiones 1 a 6 del dueño (21/10) están en
  `DECISIONES.md`.
- **Registro del dueño (21/10):** D-701..D-704 ratificadas y UAT de cc63 aprobado, en PROGRESO y en el handoff de
  cc63.
- **Migraciones:** ninguna (el lote vive en `audit_log`).
- **`--execute` contra producción:** ninguno.
- **SQL contra producción:** ninguno.
- **Demo:** restablecida desde producción con el OK de D-227, para el ensayo. Apagada al cerrar.
- **Neon:** 10 de 10 ramas, sin cambios.

## En producción

| Qué   | Valor                                                        |
| ----- | ------------------------------------------------------------ |
| PR    | #244                                                         |
| API   | `00150-75k` (`git-sha=25e0afce`), tráfico 100 %              |
| Merge | `dcc990cd`                                                   |
| Web   | `dcc990cd` en las dos URLs                                   |
| Smoke | verde, con `--expect-sha dcc990cd --expect-api-sha 25e0afce` |

- **Orden:** la API se desplegó desde la rama antes del merge (regla 11). `git diff` de runtime entre `25e0afce` y
  `main`: vacío.
- **Vuelta atrás:** `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=ayr-steel-erp-api-00149-798=100`
  y revert del merge.

## Qué entró

- **D-705, cargador:**
  - `imports/backdated-load-ops.ts`: el plan de operaciones en el orden de D-704, con clave estable e idempotencia
    por lote.
  - `imports/backdated-load-runner.ts`: ejecuta por los servicios de dominio, anota cada operación en `audit_log`
    (`backdated_load_batches`), reanuda y para en la primera fila que falla.
  - `imports/backdated-load-context.ts`: lectura del Excel y del contexto de la revisión.
  - `prisma/backdated-load-run-cli.ts`: `pnpm carga:ejecutar` y `pnpm carga:revertir`, en dry-run por defecto, con
    huella del archivo y la revisión como candado de la primera corrida.
- **Revisión (`backdated-load.ts`):**
  - columnas opcionales LARGOS, CONDICIÓN DE PAGO, VENCIMIENTO, MODALIDAD, DIRECCIÓN DESTINO y UBIGEO;
  - una bobina en una sola OP abierta, producir de más, drywall «se carga a mano» (con su entrada simulada);
  - clientes nuevos, partes sin bobina y medios de pago desconocidos, como avisos;
  - simulación por paso y fecha.
- **D-706:** la reversa, con la excepción a D-578 para las OP que cerró el mismo lote.
- **D-707:** una entrega se registra como recojo con su destino real.
- **Guía:** `docs/operacion/carga-atrasada.md` (cómo llenar el plan, cargar, revertir, límites y ensayo).

## Ensayo en demo

El plan sintético de cc63 en la plantilla nueva (30 compras, 150 ventas, 60 partes, 155 despachos, 150 comprobantes y
150 cobros):

- **Corte y reanudación:** corte a mano a los 10 min; la segunda corrida saltó 152 operaciones y siguió.
- **Parada:** en un parte con una bobina montada en otra OP abierta. De ahí salió la regla de la revisión.
- **Reversa del lote a medias:** 331 operaciones en 1426,6 s, reportes de vuelta al céntimo.
- **Carga completa:** 845 operaciones, 0 fallas, 6415,4 s (1 h 47 min).
- **Sin duplicados:** la segunda corrida completa saltó las 845.
- **Reversa completa:** 845 operaciones en 4159,0 s (1 h 9 min), reportes y `check:balances` de vuelta al céntimo.
- **Cifras:** Ventas y margen S/ 120 178,00 y CxC del lote S/ 12 564,64, iguales a cc63. Recosteos pendientes: 0.

Los scripts y la evidencia (`prep-plan.mjs`, `fix-coils.mjs`, `foto.mjs`, `maestros.mjs`, logs y fotos) están en
`local-data/cc64/ensayo/` del checkout principal; los informes del cargador, en `local-data/carga-atrasada/`.

## Panel

El Panel de administrador y el de vendedor leen la emisión del comprobante o de la cotización (mes de venta), así que
la carga no los mueve al mes de hoy. Planta va por estado. Solo el pedido y la OP quedan con la fecha del día de la
carga (no se pueden retrofechar). No se cambió nada.

## Pruebas

- **Unitarias del cargador:** 110 en verde; runner y contexto al 100 % de líneas.
- **`test:db` completo:** 242 de 242, contra la base propia `ayr_local_e2e_cc64db`.
- **E2E local completa** (build de producción, `CI=true`): 618 pasadas, 19 rojas, 2 inestables y 2 omitidas. Las 19
  son de infraestructura local, como en cc63:
  - PSE apagado;
  - CLI que apuntan a la base `ayr_local_e2e` de Docker;
  - el XML de compras de `fase2a`, que pasa en CI.
- **CI del PR #244:** en verde, incluidos los dos shards, drift, smoke de Neon `ci` y SonarCloud.

## Revisiones

- **Autorrevisión** por un subagente que no leyó este handoff: P1 1–7 corregidos; P2 y P3 corregidos o anotados abajo.
  Es una lista de riesgos.
- **Segundo modelo:** `docs/revision/cc64-segundo-modelo.md`, dos pasadas (R-01..R-14); sin P0; los dos P1 (R-01, R-02) se corrigieron antes del deploy. La respuesta
  del autor está en el mismo archivo.

## No se hace (queda anotado)

- La condición de pago y el vencimiento se leen de la primera fila del comprobante.
- Las «NOTA DE VENTA» del export se descartan como las notas de crédito, igual que en el importador de cotizaciones.
- Las reversas quedan fechadas hoy en el kardex. Lo cargado a mano (drywall) no lo revierte el cargador.
- El alta de un cliente desde el padrón es sin vista previa (pendiente de ratificar).
- Un plan grabado en una zona horaria y leído en otra no se probó (fechas probadas en seis zonas, mismo equipo).

## Pendiente

- **Dueño:**
  - ratificar D-705..D-707 y el alta de clientes desde el padrón;
  - hacer el UAT de `docs/uat/cc64.md`.
- **Para la carga real**, el dueño prepara:
  - el plan lleno en la plantilla (`local-data/cc64/plantilla-plan-de-carga.xlsx` del checkout principal):
    - el export de facturación tal cual;
    - el Excel de producción con bobinas coherentes;
    - los comprobantes de compra;
  - clientes y proveedores dados de alta, o aceptar el alta desde el padrón;
  - el **OK por nombre del lote** en producción (D-460).
- **Fecha límite:** lo más antiguo se puede registrar hasta el **12/01/2027**.
- **cc65:** la venta del accesorio suelto (D-697).
- **cc66:** higiene de auth y docs.
- **cc62:** el importador de saldos (al final de todo) y NC-02.
