# Ventana cc24 — Reportes por línea que cc23 dejó fuera

## Resumen

- **PR #107**, rama `cc24-reportes-linea`, abierta desde `main` `cf9cc32`.
- **Sin migración.** Toca la API y la web.
- **Los cinco hitos están hechos:** M0 a M4. No se sacrificó ninguno.
- **Estado al escribir esto:**
  - el PR está listo para la ventana: CI en curso, revisiones sin P0 ni P1 y UAT propio hecho;
  - **sin desplegar**;
  - falta el UAT del dueño en demo, y antes el refresco de demo con su OK.

## Hitos (M0 a M4)

- **M0** (`fbc7ebf3`): los P2 y los P3 triviales de cc23 (D-410).
  - P2-1 de la autorrevisión de cc23, con D-412: la venta de Servicios no depende del estado de
    costo del pedido.
  - P3-4: el comprobante de una línea que no despachó muestra «—», no costo 0.
  - P3-10: una bobina de otra línea en inventario muestra su tabla.
  - Los otros P2 de cc23 eran D-398 y D-403, ya ratificadas, o ya estaban corregidos.
- **M1** (`d590450a`), D-409: el margen de «Todas» se calcula sin Servicios.
  - `totals.noCostSalesPen` da la venta de Servicios, que se muestra aparte y sigue sumando a la
    venta.
  - La franja y el Excel de «Todas» siguen la regla.
  - El costo no cambia: Servicios no tiene kardex.
- **M2** (`d44536d9`): ventas por material para Coberturas Aluzinc y Drywall, con `?linea=` y
  sin «Todas» (D-406, D-407, D-413..D-416).
  - Drywall muestra Perfiles × espesor del fleje, con el color «Galvanizado». El teórico es piezas
    × kg por pieza; lo hecho a stock y lo comprado se declaran aparte.
  - La bobina entera se queda en la línea de su bobina.
  - Hay un aviso de venta sin línea.
  - El Excel solo aparece en Aluzinc.
- **M3** (`96e04b1b`): Coberturas (UPVC) y Reventa, por producto (D-417).
  - El costo es el de kardex de los despachos que declaran el comprobante.
  - Lo no atribuible va a «No trazable» con su motivo.
- **M4** (`33769e96`): bobinas con `LineTabs`, sin «Todas» y con Aluzinc por defecto (D-408,
  D-418).
  - El mes va en la URL.
  - El PDF y el Excel siguen la pestaña y nombran la línea.
- **Revisiones** (`86ea3d98`, `4b83a35c`): las correcciones de abajo, los informes y el UAT.
- **Antes de los hitos:**
  - `9dcc3a65` prohíbe `git push` con `--force`, `--delete` y `-f`;
  - `a562bce5` registra D-398..D-405 como ratificadas, D-406..D-411 y la regla D-411 en
    AGENTS.md (el commit lo hizo el agente con la instrucción explícita del dueño, después de que
    el clasificador lo frenara);
  - `e2b94c05` aplica el formato de Prettier.

## Decisiones

Todas están en `docs/ARQUITECTURA.md` §0.2.

- **Ratificadas por el dueño:** D-398..D-405. D-404 queda cerrada por D-409.
- **Del brief:** D-406..D-410.
- **D-411:** cambio de regla. Merge, push a main, `deploy:api`, `smoke:prod` y la vuelta atrás
  por `update-traffic` corren sin OK por acción, solo entre las 20:00 y las 07:00 de Lima.
  Está en AGENTS.md §3 regla 1 y en `.claude/settings.json`.
- **Del dueño en la sesión:**
  - D-412: Servicios no depende del costo.
  - D-413: la bobina entera se queda en su línea; enmienda D-406.
  - D-414: Drywall usa el motor de D-354 y declara lo que no traza.
  - D-415: fila de Drywall por espesor, con «Galvanizado».
  - D-417: UPVC y Reventa por producto, con costo de kardex.
  - D-418: bobinas abre en Aluzinc y el Excel sigue la pestaña.
- **Provisional, a confirmar por el dueño:** D-416, el Excel de ventas por material solo en
  Aluzinc, por el criterio de D-399.

## Revisiones

**Autorrevisión** (`docs/revision/cc24-autorrevision.md`; subagente nuevo, es una lista de
riesgos y no una aprobación): 0 P0, 0 P1, 3 P2, 4 P3.

- **Corregidos en `86ea3d98`:**
  - P2-1: en UPVC y Reventa, el subtítulo y el aviso de costeo hablaban de kilos de bobina.
  - P2-2: un pedido de solo Servicios facturado en dos meses contaba como «fuera de los
    totales».
  - P3: la fila «Total del rango» del Excel ahora dice «(margen sin Servicios)».
  - P3: con despacho parcial, trazado + no trazable suman exacto.
  - P3: el reporte de bobinas rotula «Total de <línea>».
- **Anotados:**
  - **P2-3, para el dueño (D-230):** «Margen (sin Servicios)» sigue incluyendo, con costo 0, los
    servicios escritos a mano que caen en «Sin línea (servicios y ajustes)». D-409 nombra
    Servicios y D-398 deja «Sin línea» aparte.
  - P3: el aviso «sin línea» de ventas por material cuenta toda la venta sin producto del rango;
    la fila «Sin línea» de ventas y margen excluye los pedidos fuera de los totales.

**Segundo modelo** (Sonnet, contexto limpio; `docs/revision/cc24-segundo-modelo.md`): 0 P0, 0 P1,
3 P2, 5 P3.

- **P2-1..P2-3, todos de permisos, para el dueño.** El agente no toca `.claude/settings.json` ni
  las reglas de permisos de AGENTS.md: los decide el dueño.
  - P2-1: la versión permisiva de `.claude/settings.json` quita del `ask` `rm -rf *`,
    `git branch -D *`, `deploy:web` y el `git push *` genérico, que D-411 no nombra.
  - P2-2: AGENTS.md (§3.2, §5 y §10) sigue pidiendo OK para merge y push a main (D-232),
    contra el párrafo de D-411.
  - P2-3: la prohibición de push forzado no cubre `-f` al final, `+main`, `:main` ni `-d`.
- **Corregidos en `86ea3d98`:**
  - P3: `PARCIAL` ya no se cuenta en la pestaña Servicios;
  - P3: el rótulo del Excel.
- **P3 anotados:**
  - el teórico de perfil supone NIU, que es la unidad de Drywall (D-055);
  - filtros viejos en la URL piden dos consultas en las pestañas por producto;
  - JSDoc desactualizado en bobinas.

## Tests y UAT

- **Unitarios:**
  - API `src/reports`: 164;
  - API `src/reports` + `src/coils`: 330 al cerrar M4;
  - web: 96.
- **lint y typecheck:** limpios.
- **E2E nuevo `reportes-por-linea-cc24.spec.ts` (4 casos):**
  - pestañas, historial, refrescar y URL inválida en ventas por material y bobinas;
  - la venta por material de cada línea = la venta de esa línea en ventas y margen;
  - el margen de «Todas» sin Servicios.
- **UAT propio** (`docs/uat/cc24.md`): build de producción, base `ayr_local_e2e_cc24`.
  - E2E: 25 passed, 1 failed. El rojo es `rf-s4a` M2, por infraestructura: PSE apagado en local.
  - Recorrido de cada pestaña de cada reporte: refrescar, retroceder y URL inválida, en verde.
  - Las ventas del recorrido manual quedan en 0 porque los specs purgan las suyas. Los números
    con ventas reales van en el UAT del dueño en demo.

## Pendiente antes de la ventana

1. **CI verde** del PR #107 sobre el último commit.
2. **Refresco de demo desde producción** (D-227): salidas externas apagadas y limpieza de los
   datos de prueba de cc20 y cc21. Necesita OK del dueño. No se crean ramas Neon nuevas (hay 9
   de 10).
3. **UAT del dueño en demo.**
4. **Resumen de D-232 al dueño:** commits, CI, qué se despliega, riesgo y vuelta atrás.

## Ventana (D-411: entre las 20:00 y las 07:00 de Lima)

1. Vuelta atrás: API `ayr-steel-erp-api-00087-pcg` y `main` `cf9cc32`.
2. Confirmar 0 migraciones pendientes.
3. Deploy de la API desde el commit del PR, con `git-sha`. Health.
4. Merge del PR. Esperar a que Vercel sirva el commit.
5. `smoke:prod` y cada reporte con cada pestaña en producción.
6. Si falla 3, 4 o 5: vuelta atrás automática (API a `00087-pcg` + revert del merge) y smoke
   otra vez.

## Convivencia entre versiones

- **API nueva + web vieja:**
  - la web vieja no manda `businessLine` a ventas por material y recibe Coberturas Aluzinc, igual
    que antes;
  - los campos nuevos (`noCostSalesPen`, `products`, `noLineSalesPen`, `businessLine`) se ignoran;
  - **el margen de «Todas» de la web vieja ya viene sin Servicios (D-409),** con el rótulo viejo
    «Margen». Es la ventana corta entre el deploy y el merge.
  - `reconciliation.roofingSalesPen` pasó a llamarse `lineSalesPen`. **La API sigue mandando
    `roofingSalesPen` como alias** con el mismo valor, para que la web vieja no se rompa entre el
    deploy y el merge. Se retira en la pieza siguiente.
- **Web nueva + API vieja:**
  - la API vieja ignora `businessLine` en ventas por material: cada pestaña mostraría Aluzinc;
  - faltaría `noCostSalesPen`.
  - Por eso el orden es API primero y después merge, como siempre.

## Neon

Esta sesión no creó ni borró ramas.
