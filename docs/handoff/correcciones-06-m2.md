# Handoff — Correcciones 06, M2: recorrido de UX (solo análisis)

## ⚠ Cobertura NO ejercida (lo primero que preguntará la sesión siguiente)

El recorrido cubrió el flujo comercial de punta a punta **con el rol ADMINISTRADOR** sobre una plancha y una
cobertura a medida. **No se ejerció:**

- **Mostrador** (POS): no había producto terminado con saldo; solo se vio «Abrir caja».
- **Corte tercerizado.**
- **Drywall:** la base de prueba no tenía productos de esa línea.
- **Importadores con archivo real** (compras, cotizaciones, bobinas desde XML, precios de lista).
- **Anulaciones y reversas.**
- **Otros roles:** de VENDEDOR y SUPERVISOR_PLANTA solo se probaron el cambio de contraseña obligatorio, el
  menú y unas URL prohibidas; **no sus flujos** (un vendedor cotizando, un supervisor produciendo).
- Además: confirmar con faltante (D-341), edición de pedido, el aviso de materia prima faltante (S11 F1-04) y
  el recojo con peso (S11 F2-03).

Las pantallas de detalle de bobina y de compra, inventario, flejes y usuarios se miraron **solo por métricas**.

## 1. Resumen

**Estado al cierre: informe escrito, revisado por dos pases y con las decisiones del dueño del 2026-09-28
incorporadas; PR #54 de solo docs abierto, sin mergear.** Sin código de producto, sin migración, sin
despliegue. Rama `docs/recorrido-ux` desde `origin/main` = `bc0c331`. Worktree `../ayr-ux`. Entregable:
`docs/analisis/ux-recorrido-2026-09-28.md` —**57 hallazgos de UX** (Alta 0 · Media 21 · Baja 36), **3 posibles
bugs de lógica** aparte y sin tocar, un barrido de dónde se crea un producto/SKU y la propuesta de sesiones de
arreglo—. **LOG-3 primero de todo y LOG-2 segundo.** La sesión se detiene hasta que el dueño decida qué se arregla.

## 2. Hecho

- **M0 — entorno.** Base descartable `ayr_local_ux` (no `ayr_local`, que es del dueño), migraciones, seed (con
  `SEED_ADMIN_FOR_TESTS=1`: si no, el admin queda con cambio de clave obligatorio) y poblado por API. El seed
  solo trae un administrador; no se puede «recorrer con el seed» tal cual.
- **M1 — flujo comercial por la pantalla:** COT-000001 → PED-000001 → OP-000001/OP-000002 → DES-000001 →
  borrador → F001-00001401 (manual) → cobro.
- **M2 — resto:** barrido de 50 pantallas a 1366×768 y 1920×1080 con una sonda de DOM propia; kardex de una
  bobina, reportes, auditoría, altas de cliente/proveedor/usuario/acabado/producto.
- **M3 — formularios y segunda resolución:** hecho (los 5 diálogos de alta cumplen; rótulos sin control en el
  despacho y en `corte/nueva`; D-293 sigue sin migrar en compra y acabados, deuda ya conocida).
- **M4 — informe**, agrupado por flujo y ordenado por severidad, con «ya decidido» aparte (§3), el barrido de
  creación de producto/SKU sin juicio (§3.3), D-367 frente a D-156 (§3.4), posibles bugs de lógica aparte (§5) y
  cruce con S11 (§6).
- **M5 — dos revisiones**, ninguna independiente: `docs/revision/recorrido-ux-autorrevision.md` (0 P0, 6 P1) y
  `docs/revision/recorrido-ux-segundo-modelo.md` (Sonnet; 1 P0, 9 P1). Sus P1 se verificaron otra vez antes de
  aceptarlos; cada revisión termina con una «Resolución del autor».
- **M6 — cierre:** PROGRESO, este handoff, D-367, commit y PR #54.

**Lo que las revisiones corrigieron** (para no repetirlo): DES-1 (el despacho ya autocompleta, D-078: lo miré
con la base vacía), CAT-1 (el enlace abre pestaña nueva) y COT-10 (la fila del selector sí es clicable) eran
míos y falsos; PLA-9 era un bug de lógica, hoy LOG-3.

## 3. Decisiones tomadas

- **D-367** (registrada en `docs/ARQUITECTURA.md` §0.2, **sin implementar**) — un producto o SKU se crea, de
  forma interactiva, solo desde Catálogo. Origen: instrucción del dueño en la sesión del 2026-09-28. **Razón,
  dictada por el dueño (relato sin documento en el repo):** «El cliente pidió que crear productos y SKU sea un
  acto deliberado del catálogo, no un paso al costado dentro de otro flujo, porque los productos creados al
  vuelo durante una cotización o una importación entran con datos incompletos y ensucian el catálogo.»
  Excepción acotada a D-156. **No alcanza a `ensureCoilSaleProduct`** (SKU canónico, derivado, sin intervención
  humana; D-257 lo cubre; las dos reglas conviven; no se reabre).
- **Decisiones del dueño incorporadas al informe (2026-09-28):**
  - El «+ Crear» del importador de compras **sale por D-367**, en la sesión de arreglos, no en esta.
  - Que se le muestre a SUPERVISOR_PLANTA, que recibe 403, es un hallazgo propio (CAT-1, P-17): la UI ofrece lo
    que el rol no puede hacer; la sesión de arreglos busca el patrón en toda la app.
  - El texto del importador de cotizaciones que promete un botón inexistente es Baja y trivial (CAT-3); el
    commit `78f679c` (2026-09-18, alta de producto quitada sin D-nnn) es el precedente de por qué existe D-367.
  - **PLA-8 no es intencional y sube a Media:** cerrar una OP mueve kardex, declara consumo y dispara la
    terminación automática de la bobina; lleva confirmación con el resumen de lo que va a consumir.
  - **LOG-3 primero de todo, LOG-2 segundo**, por encima de las 21 Medias.
  - La lista de lo que el cliente validó en UAT **la arma el dueño**; §3.2 del informe queda pendiente suya.
- **Propuestas, no escritas en §0.2:** P-01 a P-17 (informe §7). Ninguna se aplica sin el OK del dueño.

## 4. Bloqueos / pendientes

- **Verificación de `manual_by_default` en producción — NO HECHA.** El dueño pidió leerlo en solo lectura para
  asignar FAC-2 (si vale `true`, se descarta; si vale `false`, Media/S en P-08). No hay una vía de lectura que
  no sea SQL contra producción (prohibido, AGENTS §3.3) o una sesión de administrador de producción. Opciones
  para que el dueño elija: (a) que la mire él en la tarjeta de contingencia de producción (donde vive el
  interruptor) o viendo qué botón sale azul en un borrador; (b) autorizar una lectura por la API con una sesión
  de administrador de producción, con OK por comando (D-251). FAC-2 queda provisional (Baja) hasta entonces.
- **Del dueño:** armar la lista de lo validado por el cliente en UAT; aceptar o no las P-01 a P-17.
- **Cierre del entorno:** API `:3000` y web `:3001` detenidos; los scripts de un solo uso que escriben datos
  borrados; capturas y herramientas de medida copiadas y verificadas a `local-data/c06/ux/` del checkout
  principal (302 archivos). **`ayr_local_ux`, el worktree `../ayr-ux` y la rama local se conservan hasta que el
  dueño lo diga** (`DROP DATABASE ayr_local_ux` en el contenedor `ayr-local-db` cuando lo autorice). La rama
  remota la borra el dueño después del merge (AGENTS §4).
- **Ramas Neon y de git:** no se tocó ninguna. `ensayo-c06-20260928` sigue pendiente de OK por nombre (handoff
  de correcciones 06).

## 5. Cómo verificar

```bash
# El informe y las revisiones (solo docs):
git diff --stat origin/main...docs/recorrido-ux
# Formato (CI lo corre aparte de lint/typecheck):
pnpm exec prettier --check docs/analisis/ux-recorrido-2026-09-28.md docs/ARQUITECTURA.md docs/PROGRESO.md docs/handoff/correcciones-06-m2.md docs/revision/recorrido-ux-autorrevision.md docs/revision/recorrido-ux-segundo-modelo.md

# Reproducir cifras clave (con la base y los servidores levantados):
#   /despachos/nuevo → 16/16 rótulos sin control; /comprobantes/<id> → tabla de Rentabilidad 2002/1078 px a 1366;
#   GET /api/production?status=CLOSED → OP de plancha con metersReported null (LOG-3);
#   GET /api/invoicing/receivables/summary → totalBalancePen 0.0024 con customerCount 1 (LOG-2).
```

Pruebas ejecutadas: ninguna de producto (no cambió código). Las medidas salen del DOM y del API de la app viva,
no de capturas. No se corrió la suite E2E (`pnpm e2e`), por la regla de no tocar `ayr_local_e2e` ni los
puertos del dueño.

## 6. Siguiente sesión

Ninguna tarea autorizada por este handoff: **el dueño decide qué se arregla.** Cuando decida, la primera tarea
concreta sale de §7 del informe: **P-16 (LOG-3)**, después P-14 (LOG-2) y la sesión A corta. Este handoff no
encadena alcance.
