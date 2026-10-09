# Ventana cc38 — La OP se cierra solo con el plan completo

## Resumen

- Sesión del viernes 9 de octubre de 2026 (Lima), desatendida. Se despliega a cualquier hora (D-533).
- Sin migraciones y sin SQL contra producción. Un PR: **#157**.
- D-573..D-579 vienen de la especificación aprobada por el dueño (`local-data/cc38-cierre/ESPEC.md`
  y tableros `ProducirAvance` y `CerrarBarra`). El contexto largo está en `docs/DECISIONES.md`.
- Vuelta atrás:
  - API: llevar el tráfico a `ayr-steel-erp-api-00108-d8t` (`git-sha=609cd174`);
  - web: revertir el merge de #157.

| Paso                                      | Estado                                                               |
| ----------------------------------------- | -------------------------------------------------------------------- |
| Diagnóstico de solo lectura en producción | 0 OP de coberturas abiertas (71 cerradas, 1 anulada)                 |
| PR #157 y CI                              | CI completa en verde sobre `a7e17ef4` (E2E, smoke Neon `ci`, Sonar)  |
| API en Cloud Run                          | `ayr-steel-erp-api-00109-h97`, `git-sha=a7e17ef4`, 100 % del tráfico |
| Web (Vercel, por el merge)                | `main` `b0e73415`, despliegue de Vercel en verde                     |

## Diagnóstico previo (ESPEC § Diagnóstico previo)

`pnpm inspect:cc38 --branch production --confirm-production` corre `apps/api/prisma/inspect-cc38-cli.ts`
en una transacción `READ ONLY`. Las salidas quedan en `local-data/cc38-cierre/diagnostico/`, fuera del
repo.

- Órdenes de coberturas y accesorios: 72 (71 cerradas, 1 anulada) y **0 abiertas**.
- (1) Abiertas con lo registrado por encima del plan: **0**. No hubo parada.
- (2) Abiertas con borrador que pasaría el plan: **0**.

## Qué entró

- **API (D-573, D-574):**
  - `closeInTx` llama a `assertPlanComplete`. Es la puerta común de close, report-and-close y el
    commit del borrador con close=true, y de sus vistas previas.
    - Exige que los metros registrados sean iguales a los del plan, con 3 decimales. En el
      accesorio, a los metros de la línea del pedido.
    - Si falta, el mensaje es «Para cerrar falta registrar X m del plan».
  - Exceso: un reporte, una fila del borrador o el commit que pase el plan se rechaza con «Excede el
    plan en X m · ajusta el plan».
    - Ahora se compara a 3 decimales.
    - El accesorio que pasa sus metros deja de solo avisar y se rechaza.
    - «Ajustar el plan» exige los mismos metros **también en la plancha de catálogo**.
  - `GET /production/roofing/batch` suma lo registrado por bobina (`reportedPieces` y
    `reportedMeters`, por la salida de kardex de cada parte) y las planchas registradas de la orden.
    Es una consulta más para todo el lote.
  - El piso de precio dice «por und».
- **Web (D-575, D-576):** `lib/plan-progress.ts` (lógica pura, con pruebas) y
  `planta/plan-progress-view.tsx`, usados por las coberturas y el accesorio.
  - Barra de tres tramos y etiqueta por bobina.
  - Bloque llenado solo marcado, con «Sí, salió así» y «Vaciar».
  - Barra inferior con «Para cerrar falta registrar X m» y el detalle por largo. «Registrar y
    cerrar» queda desactivado, con el motivo en un tooltip.
  - Con un bloque sin confirmar, «Qué va a pasar» pide la casilla «Confirmo que salieron» antes de
    calcular.
  - Si el bloque llenado solo pasa la tolerancia de lo montado, se pide confirmarlo en el bloque.
- **D-579:**
  - En el web, `unitSymbol` y `formatUnits` dan «und» sin ceros de más.
  - En el API, `common/unit-symbol.ts` hace lo mismo para los Excel y el PDF de planta.
  - SUNAT, XML y comprobantes no cambian.

## Revisión

- **Autorrevisión** (subagente nuevo que no leyó este handoff): es una lista de riesgos, no un pase.
- **Segundo modelo (Sonnet, contexto limpio):** `docs/revision/cc38-segundo-modelo.md`, con la
  respuesta de la sesión.
  - Sin P0.
  - Un P1, que también encontró la autorrevisión: la plancha de catálogo ajustaba el plan libre. Se
    corrigió según la especificación.
  - P2 corregidos: el exceso a 3 decimales, «NIU» en el piso de precio y la tolerancia del bloque
    llenado solo.
- Los dos confirman que ningún camino de cierre esquiva D-573 y que el bloque sin confirmar no viaja
  en ningún commit.
- **La revisión del dueño cierra la entrega.**

## Pruebas

- Unitarias del API:
  - `roofing-close-plan.spec.ts`: los tres caminos, las vistas previas, exacto, otros largos,
    plancha, accesorio y exceso en el commit;
  - ajustes en `mounted-kg`, `roofing-drafts`, `roofing-accessory-report` y `price-floor`.
  - Prueba de mutación: sin `assertPlanComplete` caen 9 casos.
- Unitarias del web: `plan-progress.spec.ts` (tres tramos, detalle por largo, bloque llenado solo,
  exceso y accesorio) y `format.spec.ts` (D-579).
- E2E nueva, `cierre-plan-completo-cc38.spec.ts`:
  - API contra base real: los tres caminos y sus vistas previas sin escribir nada; el exceso en el
    reporte, la fila y el commit; plancha y accesorio;
  - pantalla: el bloque llenado solo no viaja; la barra; el cierre apagado; la casilla.
- E2E ajustadas a la regla nueva, sin borrar casos:
  - `planta-modelo-m-cc35` y `planta-espacio-produccion-ui`: ya no cierran con el plan incompleto,
    registran y el cierre queda apagado;
  - `multi-montar-f8s3`;
  - `fase7`: el cierre corto se rechaza, después se completa el plan y se cierra;
  - `planta-avisos-materia-prima`: rolar de más ya no es posible y se comprueba el rechazo. El aviso
    de D-154 sigue cubierto por `raw-material.spec.ts`;
  - `tolerancia-accesorio-d389`, `borrador-reportes-f8s3`, `planta-espacio-produccion`,
    `huecos-cobertura-f8s3` y `piso-drywall-d342`;
  - la fixture de `lock-order.db-spec` (d) × completar la reserva.
- Locales, contra la base propia `ayr_local_e2e_cc38`: las E2E de coberturas y accesorio tocadas o
  que cierran, en verde. `lock-order.db-spec` grupo C: 6/6.

## Capturas

`local-data/cc38-cierre/capturas/` (fuera del repo), cada una frente a su tablero:

1. avance parcial;
2. bloque llenado solo;
3. «Qué va a pasar»;
4. accesorio.

Las diferencias están en `diferencias.md`. Las principales:

- las bobinas en uso siguen como tarjetas y solo las terminadas se pliegan;
- «Qué va a pasar» va en dos pasos cuando hay un bloque sin confirmar;
- las cifras van con 2 decimales.

## Para el dueño

- **D-574 en la plancha de catálogo:** «Ajustar el plan» ya no cambia la cantidad total. Si un
  cliente pide más planchas, hace falta el cierre corto o la sobreproducción, que son piezas futuras.
- **OPs cerradas antes de cc38 (D-578):** no se tocan. Si una que se cerró con el plan incompleto se
  reabre, no vuelve a cerrar sin completar el plan. La salida es revertir sus partes y anularla.
- **El pedido baja la cantidad de un accesorio después de registrar:** queda «Excede el plan» y la
  orden no cierra. Es el caso de D-577 (cierre corto), fuera de alcance.
- **«Volver» después de «Confirmo que salieron»:** el bloque queda confirmado en el borrador.
- **PDF de la cotización:** es para el cliente y sigue mostrando el código de unidad («NIU»). Si
  debe decir «und», es un cambio de una línea.
- **Prosa «N piezas»** en mensajes de drywall: queda como texto, no es una abreviatura de cantidad.

## Infraestructura (no producto)

- `auth.service.spec` pasó el límite de 5 s una vez con la máquina cargada y pasa solo (15/15).
- La primera CI cayó en el db-spec por la fixture, que ya se ajustó. La segunda, en el smoke de
  `multi-montar`, ya ajustado. La tercera dio 601/602, con la falla de `huecos-cobertura-f8s3` ya
  ajustada.

## Estado al cierre

- `main` = `b0e73415` (merge de #157) más este cierre de docs. Sin diferencias de runtime entre
  `a7e17ef4` y `main` (`git diff --quiet` de apps, packages y archivos de build: exit 0).
- API `00109-h97` con `git-sha=a7e17ef4`. El smoke de producción salió en verde contra el API y contra
  los dos dominios web (`v2.mareliac.pe`, `ayr-steel-erp-web.vercel.app`).
- Logs de `00109-h97` hasta el cierre: 29 respuestas, 0 con estado ≥ 400.
- **UAT en producción:** solo lectura, porque no hay ninguna OP abierta y crear una movería kardex
  real.
  - Con admin efímero (borrado): `GET /production/roofing/batch` 200 con 0 órdenes abiertas; cola
    200; health 200.
  - La regla (cierre incompleto rechazado, registro parcial que entra, exceso, plancha y accesorio)
    la prueba la E2E de cc38 en el entorno de pruebas de la CI (Postgres del runner), en verde.
  - **La primera OP real que se produzca es el UAT de la pantalla.** Ver `docs/uat/cc38.md`.
- Limpieza:
  - la rama de PR se borró sola;
  - se borran el worktree `../ayr-steel-erp-cc38` y su carpeta, la rama local y la base
    `ayr_local_e2e_cc38`;
  - `local-data/cc38-cierre/` vive en el checkout principal (diagnóstico, capturas y logs).
