# Ventana cc63 · topes de audit-02, recosteos pendientes y carga atrasada

20/10/2026, sesión atendida.

- **Decisiones nuevas:** D-701 a D-704, provisionales. El orden de carga de D-704 lo decidió el dueño.
- **Registro del dueño (20/10):** D-698..D-700 ratificadas, UAT de cc61 aprobado y la respuesta a A2-01, en PROGRESO.
- **Migraciones:** ninguna.
- **`--execute`:** ninguno.
- **SQL contra producción:** ninguno.
- **Demo:** restablecida desde producción con el OK de D-227, para el ensayo.

## En producción

| Qué   | Valor                                                        |
| ----- | ------------------------------------------------------------ |
| PR    | #242                                                         |
| API   | `00149-798` (`git-sha=3d2425c4`), tráfico 100 %              |
| Merge | `11152d28`                                                   |
| Web   | `11152d28` en las dos URLs                                   |
| Smoke | verde, con `--expect-sha 11152d28 --expect-api-sha 3d2425c4` |

- **Orden:** la API se desplegó desde la rama antes del merge (regla 11).
- **Vuelta atrás:** `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=ayr-steel-erp-api-00148-q6w=100`
  y revert del merge.

## Qué entró

- **D-703 (LK-01, LK-02):**
  - El centinela de topes (`transaction-options.sentinel.spec.ts`) sigue `this.<método>`, las puertas de bloqueo y los
    `FOR UPDATE`.
  - 19 transacciones con bloqueo pasan a `KARDEX_TX_OPTIONS`.
  - Los literales del tope del día se nombran.
- **D-702 (RC-01, RC-03):**
  - Módulo `inventory/recost-pending.ts`.
  - Aviso en el log desde `recostPending`.
  - `GET /inventory/recost-pending`, solo ADMIN.
  - Aviso en Inventario (`recost-pending-notice.tsx`).
  - `pnpm recosteo:pendientes` (`prisma/recost-pending-cli.ts`).
  - Prueba en `recost.db-spec.ts`: el pendiente forzado se completa, también la salida que agota el ítem.
- **`planReplacement`:** ve las guías por el pedido de su despacho. Prueba en `credit-note-reasons.db-spec.ts`.
- **D-704:**
  - `imports/backdated-load.ts` (revisión pura).
  - `prisma/backdated-load-review-cli.ts` (`pnpm carga:revisar`, `--plantilla`).
  - `docs/operacion/carga-atrasada.md`.
- **D-701:** el acuse de retrofecha llega al ajuste del cierre de coberturas y de drywall, y al de la recepción de una
  orden de corte. Lo vigila el centinela `production/close-backdate.sentinel.spec.ts`.

## RC-02

Medido en demo, desde la PC a Neon:

- recosteo en línea de 100, 250 y 490 filas: 2,9 s, 3,1 s y 3,3 s;
- un pendiente de 1000 filas, completado con `recosteo:pendientes`: 3,3 s;
- en el ensayo, ninguna operación del día pasó de 30 s. La más cercana fue el parte con cierre, con 28 s (tope 60 s).

No hace falta cambiar topes. Los números están en `local-data/cc63/rc02/` del checkout principal.

## Ensayo

En `docs/operacion/carga-atrasada.md`:

- 0 rechazos y 1 h 45 min de máquina;
- reportes cuadrados al céntimo;
- unas 16 horas de trabajo manual por cada 4 semanas.

Los scripts y la evidencia (`ensayo.mjs`, `verificar.mjs`, `state.json`, `tiempos.json`) están en
`local-data/cc63/ensayo/` del checkout principal.

## Pruebas

- **Unitarias:** API 3787, en verde.
- **`test:db` completo:** 239 de 239, contra la base propia `ayr_local_e2e_cc63db`.
- **E2E local completa** (build de producción, `CI=true`): 621 pasadas, 18 rojas y 2 omitidas. Las 18 son las mismas de
  infraestructura local que en cc61:
  - PSE apagado;
  - R2 apagado;
  - CLI que apuntan a la base `ayr_local_e2e` de Docker;
  - el XML de compras de `fase2a`, que pasa en CI.
- **CI del PR #242:** en verde, incluidos los dos shards, drift, smoke de Neon `ci` y SonarCloud.

## Revisiones

- **Autorrevisión** por un subagente que no leyó este handoff: sin P0 ni P1. Es una lista de riesgos.
- **Segundo modelo:** `docs/revision/cc63-segundo-modelo.md`, sin P0 ni P1. H-1..H-4 y los puntos 1, 2 y 5 de la
  autorrevisión están corregidos; la respuesta del autor está en el mismo archivo.

## No se hace (queda anotado)

- La revisión no simula el consumo de componentes de drywall por receta.
- El barrido por `this.` no sigue las llamadas a servicios inyectados que no son del kardex.
- Dos mensajes viejos con voseo («registrá primero lo más antiguo» y «reintentá la operación») quedan para cc65.
- `pnpm recosteo:historico` no escribe el «resuelto»: las marcas se cierran con `recosteo:pendientes`.

## Pendiente

- **Dueño:**
  - ratificar D-701..D-704 y hacer el UAT de `docs/uat/cc63.md`;
  - decidir el cargador automático (`pnpm carga:ejecutar`).
- **Antes de la carga real:** correr `carga:revisar` con el plan real. Lo más antiguo se puede registrar hasta el
  **12/01/2027**.
- **cc62:** el importador de saldos (al final de todo) y NC-02.
- **cc64:** la venta del accesorio suelto (D-697).
- **cc65:** higiene de auth y docs.
