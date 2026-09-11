# Handoff — S11: escritorio robusto y compacto, color e inspección de flujos — 2026-09-11

## 1. Resumen

Sesión S11 (T7) sobre S10b cerrado. Se entregaron las tres fases del brief: la **inspección
de los cinco flujos** en navegador real (Fase 1, commiteada antes de tocar producto), la
**densidad y la robustez de escritorio** (Fase 2, D-179) y la **paleta y los tonos de estado**
(Fase 3, D-180) — ninguna se sacrificó. Entorno **LOCAL**: nada desplegado y **sin push**,
prohibido por el brief; los seis commits se suman a los pendientes de S9/S10/S10b para la
ventana única.

El perfil de uso lo fijó el dueño como decisión de negocio y no se cuestionó: el ERP se opera
**solo en PC de escritorio**, el operario de planta no usa la app y el supervisor ingresa
todo, incluida producción. No se agregó ni una media query para pantallas chicas.

## 2. Hecho

### Fase 1 — inspección de flujos

`docs/analisis/s11-inspeccion-flujos.md` (475 líneas, commit `5662fe6`, **antes** de tocar una
sola línea de producto). Los cinco flujos del brief recorridos en Chrome contra
`pnpm dev:local`, y tres de ellos **ejecutados de verdad**: COT-000054 creada, emitida y
rechazada al confirmar por falta de materia prima; OP-000007 reportada y cerrada desde
`/planta`; DES-000001 despachado. Cada hallazgo clasificado en (a) fix barato de UI, (b)
lógica o schema —solo documentado— y (c) fricción de flujo.

Los dos que mandan sobre el resto:

- **T-01 — toda la app se renderizaba en Times New Roman.** `apps/web/src/app/globals.css`
  declaraba `--font-sans: var(--font-sans)` dentro de `@theme inline` (autorreferencia que no
  resuelve) y `apps/web/src/app/layout.tsx` aplicaba las variables de `next/font` en `<body>`
  cuando quien consume `font-sans` es `<html>`. La declaración quedaba inválida y el navegador
  caía a su fuente serif. Verificado con `getComputedStyle`. **Arreglado.**
- **F2-01 — con transporte no se puede despachar ninguna línea que no se mida en kilos.**
  `apps/api/src/invoicing/dispatches.service.ts:243-250` exige `weightKg` por línea cuando la
  modalidad no es recojo y la unidad no es `KGM`; el formulario
  (`apps/web/src/app/(app)/despachos/nuevo/nuevo-despacho-view.tsx`) nunca pide ese campo,
  aunque el schema compartido lo tiene (`packages/shared/src/schemas/invoicing.ts:637`) y el
  detalle del despacho ya lo muestra. Reproducido de punta a punta. **Es (b): documentado para
  Fase 8, no tocado.**

### Fase 2 — densidad y robustez (D-179)

**B1 — densidad** (`8b9e87d`). Filas visibles en un viewport de 950 px, medidas con el primer
`<tr>` de cada lista:

| Lista           | Antes | Después |        |
| --------------- | ----: | ------: | -----: |
| `/cotizaciones` |  13.3 |    23.4 |  +76 % |
| `/pedidos`      |  13.3 |    23.4 |  +76 % |
| `/bobinas`      |  15.5 |    23.1 |  +49 % |
| `/produccion`   |   6.5 |    13.2 | +103 % |

Tres de las cuatro superan el objetivo del brief (≥50 %); bobinas queda en +49 %, que es lo
que había para ganar ahí porque sus filas ya eran de una sola línea. La densidad salió de
**sacar andamiaje** y no de achicar el dato: el texto de tabla sigue en 14 px.

Archivos clave: `apps/web/src/app/globals.css` (fuente y tokens),
`apps/web/src/app/(app)/layout.tsx` (cabecera 48→32 px, `main` `gap-3 p-4`),
`apps/web/src/components/ui/table.tsx`, `label.tsx`, `card.tsx`, `badge.tsx`, y
`apps/web/src/components/stat-strip.tsx` (nuevo: reemplaza el bloque de cuatro `Card` de una
cifra que estaba copiado en cinco vistas).

**B2 — robustez 1366-1920** (`8cfc238`). El hallazgo grande:
`apps/web/src/components/ui/sidebar.tsx` — **`SidebarInset` no tenía `min-w-0`**, así que el
panel de contenido no bajaba de su ancho mínimo automático y quedaba tan ancho como la ventana
**además** del menú de 256 px. Toda la app scrolleaba 256 px en horizontal a cualquier ancho, y
a 1366 px los botones de acción de cada lista quedaban fuera de la pantalla. Medido con el
viewport en 1366: `document.documentElement.scrollWidth` 1622 → 1366.

Además: la celda de cliente acotada (`apps/web/src/lib/utils.ts`,
`CUSTOMER_CELL_CLASSNAME`/`CUSTOMER_NAME_CLASSNAME`) — una razón social de ochenta caracteres
con `whitespace-nowrap` empujaba la tabla 363 px más allá del ancho disponible; el nombre se
corta con elipsis y queda entero en el `title`, el documento **no** se corta porque es el que
desambigua. Y el menú lateral de 944 a ~780 px.

**B3 — los fixes baratos (a)** (`67ab2ab`). Toast a `bottom-right` (tapaba **y se comía el
clic de** la barra de acciones: `elementFromPoint` sobre «Confirmar y reservar», «Anular» y
«Duplicar» devolvía el toast); `/produccion` pasa a titularse «Órdenes de producción»;
los veinte controles `h-12`/`h-16 text-lg` de `/planta` vuelven al tamaño del resto de la app;
el «por» huérfano; el formulario de despacho dice qué falta en palabras; el motivo del kardex
completo en el `title`; el mostrador deja de contestar una búsqueda que nadie hizo.

### Fase 3 — color (D-180)

`d5c6456`. Un solo color de marca —azul acero `oklch(0.46 0.105 248)`— y cuatro tonos de
estado con significado fijo, mapeados en `apps/web/src/components/status-tone.ts` con
`Record<Status, StatusTone>` **exhaustivos** para las doce familias de estado de `@ayr/shared`:
un estado nuevo no compila hasta que alguien decida qué significa. Rojo y ámbar quedaron
reservados para error y aviso. Contrastes medidos en el navegador, claro y oscuro: ninguno
baja de 4.7:1.

### Cierre de la revisión

`82baa9a`. `revisor` no encontró bloqueantes y confirmó lo que más importaba verificar: el
`canSubmit` reescrito del despacho es **exactamente equivalente** al anterior, condición por
condición. Los cinco hallazgos MEDIO eran incoherencias de las decisiones que esta misma sesión
acababa de tomar, así que se cerraron todos: tres enums sin mapa de tono, el detalle de compra
eligiendo variante a mano, el semáforo de la cola sin pasar por la convención, el badge
derivado del pedido y los campos numéricos de planta sin criterio de tamaño. Después de ese
commit **no queda ningún `Badge` de estado eligiendo variante a mano en la app**.

## 3. Decisiones tomadas

- **D-179** — Escritorio compacto: el sistema se diseña para una sola clase de pantalla. Sin
  objetivo móvil, densidad alta con objetivo medible, y `/planta` deja de estar a escala táctil.
- **D-180** — Paleta sobria de un solo acento y cuatro tonos de estado de dominio
  (`progress`/`done`/`warning`/`destructive`, más neutro para lo anulado), con rojo y ámbar
  reservados para error y aviso.

## 4. Bloqueos / pendientes

### Heredados, siguen sin acción — ninguno depende de esta sesión

- **⛔ Rotar `neondb_owner`** — pendiente desde el incidente del 2026-09-10, 11:54 UTC. Es lo
  más urgente.
- **Vaciar los comprobantes de la cuenta demo del PSE** y correr `pnpm e2e:pse`.
- **Empujar los commits pendientes** (`207bdf9` + Saneamiento E2E + S9 + S10 + S10b + los seis
  de S11) y confirmar CI verde.

### Nuevo de esta sesión

- **F2-01, para Fase 8 y es el importante**: agregar la columna de peso por línea en la tabla
  «Qué sale» del despacho, con el valor propuesto ya calculado y editable con la báscula. Hoy
  la única salida desde la UI para una línea en `NIU`/`MTR` con guía es declararla como recojo
  en mostrador, que es mentira documental. **La suite E2E no lo cubre porque despacha por API**
  (`e2e/helpers/invoicing.ts` manda `weightKg` en el payload), así que agregar el campo debería
  venir con un caso que ejerza la pantalla.
- El resto del reporte de Fase 1 que quedó sin hacer, todo (b) o (c): F2-03 (el peso bruto que
  se descarta en un recojo), F3-02 (qué significa «Disponible» para una bobina cerrada con
  saldo), T-08 (extender el sort a compras, comprobantes, despachos, cobranzas y kardex),
  F1-04 (aviso persistente de materia prima faltante en la cotización).
- **Sin converger**: `/planta` conserva su propio `MiniStat` y `/pos/caja` su `<dl>`; se ven
  igual que `StatStrip` (mismo recurso de `gap-px`) pero son tres componentes. Unificarlos es
  mecánico y no se hizo por alcance.
- `docs/analisis/e2e-velocidad.md` sigue sin trackear y dice «Medición / Estimación» cuando
  ordena los specs por tamaño de archivo y `test.setTimeout`, no por tiempo real. O se mide con
  el reporter de Playwright, o el título dice «estimación» a secas.

## 5. Cómo verificar

```bash
pnpm turbo lint typecheck test          # verde (399 unitarios)
pnpm format:check                       # verde

pnpm e2e                                # 239 pasados, 0 fallados, 2 saltados (54.6 min)
```

Mismo baseline que S9/S10/S10b. Hizo falta una corrida intermedia: la primera versión de la
tira de cifras dejaba la cifra pegada a su renglón de contexto en el mismo nodo de texto, y
`fase7e-ajustes-d121.spec.ts:92` —que busca el valor con `exact: true`— lo detectó. Se
arregló **el componente y no el spec**: lo que la pantalla promete es mostrar la cifra, no una
cadena que la contenga.

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126). La base de E2E se recreó antes de la corrida,
como recomienda la nota operativa:

```bash
docker exec ayr-local-db psql -U ayr -d postgres -c "DROP DATABASE ayr_local_e2e;"
docker exec ayr-local-db psql -U ayr -d postgres -c "CREATE DATABASE ayr_local_e2e OWNER ayr;"
```

Un solo spec se ajustó, y por un cambio de esta sesión: `e2e/tests/auth.spec.ts` busca el
correo del usuario por `title` en vez de como texto visible, porque el pie del menú lo movió
ahí al bajar de 113 a 69 px.

Verificación visual: `pnpm dev:local` (`:3000`/`:3001`) y el navegador a 960, 1366 y 1920 px.
**Los puertos 4000/4001 son del dueño** (regla dura 15) y estuvieron ocupados durante la
sesión; no se tocaron.

## 6. Siguiente sesión

Con T7 cerrado, la fila que sigue en `docs/ARQUITECTURA.md` §3.7 es la **Fase 8 — Auditoría,
reportes, hardening, UAT (RF-90..96)**. Antes de arrancarla:

1. **Rotar `neondb_owner`** y redesplegar el API — primero y sin depender de nada más.
2. **Vaciar el cupo del PSE demo** y correr `pnpm e2e:pse` hasta verde.
3. **Empujar** los commits pendientes y confirmar CI verde.
4. Recién entonces, **Fase 8**, y arrancarla por **F2-01**: es un bloqueo de flujo real, ya
   está diagnosticado con el archivo y la línea, y es más barato de cerrar ahora que de
   descubrir en UAT con el cliente delante.
