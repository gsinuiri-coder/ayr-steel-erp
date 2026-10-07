# Ventana cc30 — Orden de bloqueos entre documentos (grupo C de cc18)

## Resumen

- Sesión desatendida del 6 al 7 de octubre. Dos cortes sin migraciones, ventana de 20:00 a 07:00
  de Lima. Hora de Lima = UTC − 5. Las dos horas van anotadas.
- **Corte 1 (PR #121), M0–M2:**
  - puerta de documentos `lockDocuments`;
  - producción con pedido → OP → reserva;
  - cruces a–d del grupo C y C12.
  - API `ayr-steel-erp-api-00097-vxv` (`git-sha=9e2e034a`), `main` `f4273691`, smoke 8/8 en la API
    y en los dos dominios.
- **Corte 2 (PR #122), M3–M4:**
  - todos los `FOR UPDATE` sobre documentos pasan por la puerta, con centinela;
  - cruces C6–C11 y las violaciones de la matriz;
  - regla 17 sin salvedad (texto provisional).
  - API `ayr-steel-erp-api-00098-drm` (`git-sha=fc5c54f7`), `main` `b60bf311`, smoke 8/8 en la API y
    en los dos dominios.
- **Decisiones:**
  - del dueño: D-470, D-472, D-473, D-474, D-475 y D-476;
  - provisionales: D-471, D-477, D-478 y D-479.
- **Matriz:** `docs/analisis/cc30-matriz-bloqueos.md`. Relevó 106 transacciones y encontró 12
  cruces; ninguna retiene el bloqueo de un pedido durante E/S externa.

## Matriz y cruces

| Cruce      | Qué                                                    | Cómo quedó                                                                       | Prueba (20 iteraciones)              |
| ---------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------ |
| a (C1, C2) | Revertir reporte de drywall × anular pedido / despacho | `lockOrder(own)`: pedido → OP → reserva al inicio                                | × despacho: viejo 16/20 deadlock → 0 |
| b (C3)     | Revertir reporte de coberturas × anular pedido         | pedido → OP, las dos reservas juntas por id                                      | viejo 4/20 → 0                       |
| c (C4)     | `updateItemQty` × reportar coberturas                  | OP de la línea y reservas detrás del pedido; el reporte va pedido → OP           | viejo 20/20 → 0                      |
| d (C5)     | Cerrar coberturas sin despunte × completar reserva     | `lockOrder(own)` en el cierre                                                    | viejo 14/20 → 0                      |
| C6         | Crear las OP del pedido × anular / completar           | pedido → reservas por id al inicio                                               | sin par propio (serializa el pedido) |
| C7         | Reasignar vendedor × anular pedido                     | anular toma la cotización antes que el pedido; reasignar toma los pedidos por id | viejo 19/20 → 0                      |
| C8         | Borrador con despacho × revertir despacho              | despacho → pedido en los dos                                                     | viejo 19/20 → 0                      |
| C9         | Editar compra recibida × partir bobina                 | `FOR NO KEY UPDATE` sobre la compra y relectura de bobinas                       | con `FOR UPDATE` 19/20 → 0           |
| C10        | CLI de fecha de recepción × anular/editar compra       | compras antes del inventario                                                     | sin par (CLI de ventana)             |
| C11        | Importador de cotizaciones × sí mismo                  | advisory locks ordenados al inicio                                               | unitario                             |
| C12        | Anular OP × anular pedido                              | `lockOrder(own)`                                                                 | cubierto por el orden                |

Otras violaciones arregladas:

- liberar una reserva a mano sin ningún bloqueo (V17);
- descartar un borrador que podía borrar un comprobante ya numerado (F8);
- F4 y F9 sin bloquear lo que deciden;
- la purga de cotizaciones por `seq`.

## Evidencia de mutación

- **Corte 1:** con el orden de clases invertido en la puerta, los 6 pares de cc30 fallan (`LOCK`)
  (`local-data/cc30/mutation-c1.log`).
- **Corte 2:** con la misma mutación, C7 falla 19/20. C8 y C9 no dependen de ese orden:
  - C8 toma despacho y pedido en una sola llamada a la puerta;
  - C9 no pasa por la puerta (es el modo del bloqueo de la compra).

  Su evidencia en rojo es la corrida contra el código anterior: C8 19/20 y C9 19/20 (con
  `FOR UPDATE`) (`red-c7c8.log`, `red-c9.log`).

- `test:db` completo en local:
  - corte 1: 46/46;
  - corte 2: 48/48, más C9 aparte;
  - los 31 pares de D-386, en verde y sin un solo `LOCK`.

## Corte 1 — ventana

Horas en Lima (UTC entre paréntesis).

- **22:09 (03:09):** la CI del PR #121 en verde (run 37562169201: E2E 28 min, smoke de Neon `ci`,
  Sonar). La corrida anterior se cortó por el tope de 30 min del job sin ningún rojo; se subió a
  40 (commit `9e2e034a`, medido: `test:db` 6,6 min).
- **22:10 (03:10):** `pnpm deploy:api` desde el checkout principal en `--detach 9e2e034a`. Resultado:
  `00097-vxv`, `git-sha=9e2e034a`, 100 %, `/health` ok. Vuelta atrás anotada: `00096-zt9`.
- **22:12–22:30:** `smoke:prod` no pudo correr. `neonctl connection-string` fallaba de forma
  intermitente con `Cannot read properties of undefined (reading 'branches')`.
  - Las llamadas de proyecto andaban.
  - neonstatus.com decía «All Systems Operational».
  - Los logs de `00097-vxv` no tenían ningún 409 ni 500.
  - Por precaución se volvió el tráfico a `00096-zt9` (22:31). No hubo redeploy.
- **23:11 (04:11):** `neonctl` estable. Tráfico a `00097-vxv`, `connection-string` volvió a fallar y
  se volvió a `00096-zt9` (23:20). `connection-string` respondió 6/6 en una medición aparte.
- **23:22 (04:22):** tráfico a `00097-vxv`, `smoke:prod` 8/8.
- **23:23 (04:23):** merge del #121, `main` = `f4273691`, sin diff de runtime. Vercel en `success`.
- **23:24 (04:24):** smoke 8/8 en `ayr-steel-erp-web.vercel.app` y en `v2.mareliac.pe`. Logs sin
  409 ni 500.
- Salidas: `local-data/cc30/` (deploy, smokes, rollbacks, CI).

## Corte 2 — ventana

Horas en Lima (UTC entre paréntesis).

- **Revisiones** (`docs/revision/cc30-corte2-*.md`):
  - autorrevisión: 0 P0, 0 P1, 2 P2;
  - segundo modelo: 0 P0, 0 P1, 4 P2.
  - **Corregidos:**
    - F4 y F9 toman comprobante → pedido;
    - C9 relee las bobinas tras bloquear;
    - el par C9 y la dependencia del índice parcial de `purchases`, escrita en D-479;
    - el par (d) × completar reserva, que en el runner nunca dejaba ganar a completar (escalón por
      turnos);
    - tres `sort()` sin comparador (Sonar, confiabilidad D).
- **00:09 (05:09):** la CI del PR #122 en verde en `fc5c54f7`. Run anterior: `dashboards.db-spec`
  falló una vez, el inestable conocido de cc29.
- **00:12 (05:12):** `pnpm deploy:api` en `--detach fc5c54f7`. Se creó la revisión `00098-drm`, pero
  **el tráfico seguía fijado en `00097-vxv`** por el `update-traffic` del corte 1 (trampa conocida de
  cc26). `update-traffic --to-latest` dejó `00098-drm` al 100 % y como «latest», con `/health` ok.
  Vuelta atrás anotada: `00097-vxv`, `main` `f4273691`.
- **00:17 (05:17):** `smoke:prod` 8/8.
- **00:18 (05:18):** merge del #122, `main` = `b60bf311`, sin diff de runtime. Vercel en `success`.
- **00:19 (05:19):** smoke 8/8 en `ayr-steel-erp-web.vercel.app` y en `v2.mareliac.pe`. Logs de
  `00098-drm` sin 409 ni 500.

## P3 abiertos

- Ver `docs/revision/cc30-corte1-*.md` y `docs/revision/cc30-corte2-*.md`.
- **Abiertos:**
  - carreras estrechas que antes esperaban y ahora dan 409 por `NOWAIT`: anular un pedido cuando
    nace una OP en el medio, reactivar o traer con un borrador que nace y se emite, el barrido de
    importados desde la segunda línea;
  - la puerta no se entera de un `ROLLBACK TO SAVEPOINT` (hoy ningún savepoint la usa);
  - el centinela no ve tablas con esquema, `$queryRawUnsafe` concatenado ni bloqueos por FK;
  - D-373 toma el pedido aunque ninguna línea lo use;
  - `createFromSalesOrder` retiene el pedido hasta 60 s;
  - el GET de reservas temporales escribe (V7);
  - `expireDue` sin orden por id (V8);
  - el re-fechado con varios despachos pide reservas con `NOWAIT` (sin contienda por análisis, sin
    par);
  - sin par contra la base: C6, C10 y C11;
  - el cupo de espesores de `lock-order.db-spec`: los pares de cc30 suman unos 100 agregados (paso
    de 0,03 mm, tope de 9,99 mm).

## Sacrificado

- Nada de M0–M4. De M5 (P3), lo de arriba queda abierto.
- **Fuera de alcance, sin tocar:**
  - anular la OP con la bobina montada y su sobrante;
  - la casilla de tolerancia;
  - los pendientes de la prioridad 2.
