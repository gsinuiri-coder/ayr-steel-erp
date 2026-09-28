# Handoff — Correcciones 06, M2: recorrido de UX (solo análisis)

## 1. Resumen

**Estado al cierre: informe escrito y revisado por dos pases; PR de solo docs abierto, sin mergear.** Sin código
de producto, sin migración, sin despliegue. Rama `docs/recorrido-ux` desde `origin/main` = `bc0c331` (CI de `main`
verde antes de crearla). Worktree `../ayr-ux`. El entregable es
`docs/analisis/ux-recorrido-2026-09-28.md`: **57 hallazgos de UX** (Alta 0 · Media 21 · Baja 36), **3 posibles
bugs de lógica** aparte y sin tocar, un barrido de dónde se crea un producto/SKU, y una propuesta de sesiones de
arreglo con D-367 registrada y P-01 a P-16 solo propuestas. La sesión se detiene acá hasta que el dueño decida
qué se arregla.

## 2. Hecho

- **M0 — entorno.** Base descartable `ayr_local_ux` en el Postgres de Docker (no `ayr_local`, que es del dueño),
  migraciones y seed (con `SEED_ADMIN_FOR_TESTS=1`, porque el seed deja al administrador con cambio de contraseña
  obligatorio) y un poblado por API con nombres realistas (3 colores, 4 acabados, 2 proveedores, 3 clientes, 6
  productos de coberturas, 4 bobinas recibidas). El seed solo trae un administrador: no se puede «recorrer con el
  seed» tal cual.
- **M1 — flujo comercial por la pantalla:** COT-000001 → PED-000001 → OP-000001/OP-000002 (montar, reportar,
  cerrar) → DES-000001 → borrador → F001-00001401 (manual) → cobro. Más el cambio de contraseña obligatorio y los
  menús de VENDEDOR y SUPERVISOR_PLANTA.
- **M2 — resto:** barrido de 50 pantallas a 1366×768 y a 1920×1080 con una sonda de DOM propia (desborde de
  tablas, altura, rótulos sin control, referencias internas), kardex de una bobina, reportes, auditoría, alta de
  cliente/proveedor/usuario/acabado/producto.
- **M3 — formularios y segunda resolución:** hecho (los 5 diálogos de alta cumplen; los rótulos sin control están
  en el despacho y en `corte/nueva`; D-293 sigue sin migrar en compra y acabados, deuda ya conocida).
- **M4 — informe** `docs/analisis/ux-recorrido-2026-09-28.md`, agrupado por flujo y ordenado por severidad, con
  «ya decidido» aparte (§3), el barrido de creación de producto/SKU sin juicio (§3.3), el análisis de D-367 frente
  a D-156 (§3.4) y los posibles bugs de lógica aparte (§5). Cruce con los 20 hallazgos de S11 (§6).
- **M5 — dos revisiones**, ninguna independiente: `docs/revision/recorrido-ux-autorrevision.md` (0 P0, 6 P1) y
  `docs/revision/recorrido-ux-segundo-modelo.md` (Sonnet; 1 P0, 9 P1). Sus P1 se verificaron otra vez antes de
  aceptarlos y están resueltos en el informe (cada revisión termina con una «Resolución del autor»).
- **M6 — cierre:** `docs/PROGRESO.md` (sección «Recorrido de UX»), este handoff, D-367 en §0.2, commit, PR.

**Lo que las revisiones corrigieron** (para no repetirlo): DES-1 (el despacho ya autocompleta, D-078: lo miré con
la base vacía), CAT-1 (el enlace abre pestaña nueva) y COT-10 (la fila del selector sí es clicable) eran míos y
falsos; PLA-9 era un bug de lógica (`metersReported` nulo en órdenes de plancha), hoy LOG-3.

## 3. Decisiones tomadas

- **D-367** (registrada en `docs/ARQUITECTURA.md` §0.2, **sin implementar**) — un producto o SKU se crea, de forma
  interactiva, solo desde Catálogo. Origen: instrucción del dueño en la sesión del 2026-09-28, que la relata como
  feedback del cliente; **no hay documento en el repo que la respalde y la razón textual del cliente queda pendiente
  de que el dueño la dicte**. Excepción acotada a D-156 (sigue como regla general). Conflicto vigente nombrado:
  el «+ Crear» del importador de compras (desplegado el 2026-09-27), que no se tocó.
- **Propuestas, no escritas en §0.2:** P-01 a P-16 (informe §7). Ninguna se aplica sin el OK del dueño.

## 4. Bloqueos / pendientes

- **Del dueño:** (1) dictar la razón del cliente de D-367 (la fila lo dice; hoy es un vacío explícito, no un
  texto inventado); (2) decidir P-12: el «+ Crear» del importador de compras (visible también para
  SUPERVISOR_PLANTA, que recibe 403) y el texto obsoleto del importador de cotizaciones, y si D-367 alcanza a la
  creación automática del SKU de bobina; (3) decidir PLA-8 (cierre de orden sin confirmación; hoy es D-159/D-191);
  (4) completar la lista de lo que el cliente validó en UAT (el repo no la registra); (5) verificar
  `manual_by_default` en producción, solo lectura, antes de asignar FAC-2.
- **Lo que pide una sesión propia (no se ejerció):** mostrador (no había producto terminado con saldo), corte
  tercerizado, drywall (la base no tenía productos), importadores con archivo real, anulaciones y reversas,
  confirmar con faltante y el resto de los roles.
- **Cierre del entorno, a cargo de esta sesión al terminar:** API `:3000` y web `:3001` detenidos; los scripts de
  un solo uso que escriben datos (poblado, roles, flujos) borrados; capturas y herramientas de medida copiadas de
  `../ayr-ux/local-data/c06/ux/` a `local-data/c06/ux/` del checkout principal y verificadas (AGENTS §4). La
  base `ayr_local_ux` **se conserva** para poder reproducir los hallazgos; se borra con
  `DROP DATABASE ayr_local_ux` en el contenedor `ayr-local-db` cuando el dueño lo diga. **El worktree `../ayr-ux`
  y la rama local se conservan** hasta que el dueño revise el informe (puede haber correcciones); la rama remota
  la borra el dueño después del merge (AGENTS §4).
- **Ramas Neon y de git:** no se tocó ninguna. `ensayo-c06-20260928` sigue pendiente de OK por nombre (handoff de
  correcciones 06).

## 5. Cómo verificar

```bash
# El informe y las revisiones (solo docs):
git diff --stat origin/main...docs/recorrido-ux
# Formato (CI lo corre aparte de lint/typecheck):
pnpm exec prettier --check docs/analisis/ux-recorrido-2026-09-28.md docs/ARQUITECTURA.md docs/PROGRESO.md docs/handoff/correcciones-06-m2.md docs/revision/recorrido-ux-autorrevision.md docs/revision/recorrido-ux-segundo-modelo.md

# Reproducir cifras clave (con la base y los servidores levantados; ver PROGRESO):
#   /despachos/nuevo → 16/16 rótulos sin control; /comprobantes/<id> → tabla de Rentabilidad 2002/1078 px a 1366;
#   GET /api/production?status=CLOSED → OP de plancha con metersReported null (LOG-3);
#   GET /api/invoicing/receivables/summary → totalBalancePen 0.0024 con customerCount 1 (LOG-2).
```

Pruebas ejecutadas: ninguna de producto (no cambió código). Las medidas salen del DOM y del API de la app viva, no
de capturas. No se corrió la suite E2E (`pnpm e2e`), por la regla de no tocar `ayr_local_e2e` ni los puertos del
dueño.

## 6. Siguiente sesión

Ninguna tarea autorizada por este handoff: **el dueño decide qué se arregla.** Cuando decida, la primera tarea
concreta sale de §7 del informe (las dos investigaciones de lógica, P-14 y P-16, y la sesión A corta). Este
handoff no encadena alcance.
