# Handoff — Correcciones 03 del cliente (UI y listas), 2026-09-25

Rama `fix/correcciones-03` (worktree `../ayr-steel-erp-corr03`), desde `origin/main` en `b124a7c`.
Decisiones **D-289 a D-296** (`docs/ARQUITECTURA.md` §0.2). **Sin migraciones ni cambios de dominio**
(kardex, reservas, costeo). Estado de partida en producción: API `ayr-steel-erp-api-00053-fgk`.

## 1. Qué entró

| Milestone | Commit    | Decisión     | Resumen                                                                                                                                                                    |
| --------- | --------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | `9864460` | D-289        | Estado de las listas en la URL (`useUrlState`); filtro de estado múltiple en el servidor con exclusión por defecto de terminales negativos; chips «Anulados» / «Atendidos» |
| M1        | `967bfc0` | D-290        | Kardex por ítem (buscador, mes en curso, presets); búsqueda en catálogo                                                                                                    |
| M2        | `4a8096c` | D-291, D-292 | Sidebar acordeón; estado del PSE en ⓘ; columna «Bobina / fleje» en reportes de OP; historial de órdenes en tabla                                                           |
| M3        | `65265ca` | D-293        | Modelo de formularios (grilla de 12): `ProductDialog`, despacho, layout de documentos                                                                                      |
| M4        | `c918251` | D-294        | Estilo compacto y `Section` en los detalles                                                                                                                                |
| M5        | `94a0256` | D-295        | Filtros de columna en tablas no paginadas                                                                                                                                  |
| M6        | `f0bf1ca` | D-296        | PEPS junto al promedio en el kardex por ítem                                                                                                                               |

Después: correcciones de la autorrevisión y de la corrida completa (ver §3). Los seis milestones
**entraron**; lo que no entró de cada uno está en §5.

## 2. Verificación

- `pnpm lint`, `pnpm typecheck`, `pnpm test` (API 106 suites / 1208 pruebas; web 7 archivos / 36
  pruebas), `pnpm format:check` y `pnpm build`: en verde.
- **Suite E2E completa desde el worktree con builds de producción** (`scripts/e2e-latency.mjs
--proxy-port 5434`): **410 pasados, 6 fallidos, 45,5 min**, sin síntoma de memoria. Clasificación:

| Rojo                                                     | Clasificación                                                                                                                                                        | Resolución                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `acabados-d203.spec.ts:498`                              | **Producto/pruebas**: el spec hacía click en el enlace «Acabados» con el menú acordeón cerrado                                                                       | `openSidebarGroup`; reintento en verde                                                         |
| `despacho-peso-por-linea.spec.ts:53`                     | **Pruebas**: acoplado al markup viejo del formulario de despacho (`div.space-y-1`, `label + input`)                                                                  | locators migrados; reintento en verde                                                          |
| `correcciones-03-formularios.spec.ts:97` (1366)          | **Prueba propia mal acotada**: medía el scroll horizontal de la página **detrás** del diálogo (el catálogo con productos de toda la corrida); el diálogo estaba bien | el spec mide el diálogo; reintento en verde a 1366 y 1920                                      |
| `fase2a.spec.ts:359` (XML de factura)                    | **Infraestructura**: el worktree no tiene credenciales R2 (misma causa que F8-V4prep)                                                                                | pasa con `R2_*` inyectadas desde `.env.setup` por el entorno del proceso                       |
| `fase5a.spec.ts:100` («el alta debe dejar el PDF en R2») | **Infraestructura**: R2                                                                                                                                              | pasa con `R2_*` inyectadas                                                                     |
| `reportes-costeo-rf-s4a.spec.ts:167`                     | **Infraestructura**: la cuenta demo de Nubefact rechaza el correlativo («fuera del rango permitido, el último es 39420975»)                                          | no se puede arreglar desde acá; no toca código de esta rama. **No se comprobó contra `main`.** |

Resultado neto: 5 de 6 reintentados en verde (27+1 pruebas de las 5 suites); **queda en rojo
solo `reportes-costeo-rf-s4a:167`** (infraestructura PSE). No se corrió `e2e:pse`.

- E2E nuevos (`e2e/tests/correcciones-03-*.spec.ts`): sidebar acordeón; chips, URL y recarga en
  pedidos (con doble clic rápido); kardex vacío → ítem → rangos → recarga; filtros de columna;
  PEPS; búsqueda de catálogo; columna de bobina en el reporte; historial expandible; formularios
  medidos a 1366 y 1920; densidad medida a 1366×768.

**Mediciones en el navegador (1366×768)** — `correcciones-03-densidad.spec.ts`:

|                                                      | Antes         | Después             |
| ---------------------------------------------------- | ------------- | ------------------- |
| Alto de fila de las listas                           | 31,8 px       | 27,1 px             |
| Filas por pantalla: cotizaciones / pedidos / bobinas | 16 / 16 / 15  | 19 / 19 / 18        |
| Cajas con borde: cotización / pedido / bobina / OP   | 2 / 3 / 6 / 2 | 1 / 0 / 0 / 0       |
| Altura del detalle de bobina                         | 805 px        | 768 px (sin scroll) |

Formularios (`correcciones-03-formularios.spec.ts`): sin celdas que se pisen, misma distancia
rótulo→control en todas las celdas y sin scroll horizontal del diálogo/página, a 1366 y 1920 px.

## 3. Autorrevisión

Subagente nuevo del mismo modelo, sin haber visto este handoff: `docs/revision/correcciones-03-autorrevision.md`
(**PENDIENTE DE REVISIÓN INDEPENDIENTE**): 0 P0, 3 P1, 8 P2. P1-1 (eco atrasado del buscador) y P1-3
(spec del menú) **corregidos**; **P1-2 es preexistente** (ver §4). La resolución hallazgo por hallazgo
está al final de ese archivo.

## 4. Para el dueño (decisiones que no son de esta sesión)

1. **Hallazgo de seguridad preexistente** (P1-2 de la autorrevisión):
   `InvoicingService.findAll` (`apps/api/src/invoicing/invoicing.service.ts`, ~línea 3108) asigna
   `where.OR` para la búsqueda y **pisa** el `OR` del alcance por vendedor: un VENDEDOR que busca en
   `GET /invoicing/documents?search=` puede ver comprobantes de otros vendedores. No lo introduce
   este cambio y no se tocó (AGENTS §3.16). Propuesta: componer con `AND`, con E2E de alcance de
   vendedor, en una rama aparte. **Necesita tu decisión.**
2. **El texto del cliente no llegó.** El brief traía el marcador `[pegar acá…]`; `docs/cliente/correcciones-03.md`
   está marcado incompleto y los puntos **5 a 9** (y las respuestas a 6 y 8) están pendientes en
   `docs/cliente/revision-2026-09-25.md` §1.16.
3. **Ventana de deploy** (sin migración): no ejecutada; requiere tu OK explícito (D-232/D-251).
   Propuesta en §6.

## 5. Lo que no entró / pendientes

- **M3:** sin migrar el formulario de compra (`purchase-form.tsx`, 30 campos con condicionales) ni
  los diálogos de acabados, colores y receta. La celda se llama `FormFieldCell`/`FormCell` y no
  `FormField` (choca con el `Controller` de react-hook-form).
- **M5:** `useColumnFilters` tiene la forma de `columnFilters` de TanStack pero no usa la tabla
  (`@tanstack/react-table` está instalado y sin uso en el repo). Censo: `docs/handoff/correcciones-03-censo-tablas.md`.
- **M2, barrido de encabezados informativos:** se convirtió el bloque del PSE (`ContingencyCard`) y
  la explicación de 4 líneas de «Importar cotizaciones». **No** se convirtieron: los avisos
  condicionales de negocio (alertas de contingencia, vencimientos, faltantes, errores) porque
  ocultarlos detrás de un clic es el error que D-178 evita; los subtítulos de una o dos líneas
  (caben en dos líneas a 1366 px); y los `Alert` de estado de un documento. Barrido hecho con un
  script sobre los `<h1>` + `<p>`.
- **M4:** los diálogos y las pantallas de lista no cambian de estructura; solo los tokens
  compactos (tabla, input, select). El aviso «Reserva temporal» de la cotización sigue siendo
  `Card` (aviso de negocio independiente).
- **Autorrevisión, P2 pendientes:** ver la tabla de resolución (aserciones negativas del menú,
  `aria-describedby` de `FormCell`, pruebas unitarias del hook, medir el default de pedidos).
- **Historial de planta:** se pagina en el cliente sobre las 500 órdenes más recientes que entrega
  `GET /production` (se avisa en pantalla). Paginar en el servidor requiere agrupar por pedido en
  SQL: cambio de API aparte.
- **PEPS «Todo»:** lee desde 2000-01-01 hasta hoy; el Excel de SUNAT con «Todo» declara ese período.

## 6. Ventana propuesta (sin migración) — pendiente de OK del dueño

13:00 Lima, nadie operando: `node scripts/migrations-status.mjs --branch production` (sin
pendientes); respaldo Neon `respaldo-pre-corr03-20260925` (vía `run` quiet + `--output json`);
`pnpm deploy:api` desde el worktree en el SHA del PR (label `git-sha`); health; `pnpm smoke:prod`
contra la web vieja; merge del PR con `AYR_OWNER_PUSH=1`; Vercel; `pnpm smoke:prod` contra
`v2.mareliac.pe`; `git diff --quiet <sha> origin/main -- apps packages Dockerfile .gcloudignore package.json pnpm-lock.yaml pnpm-workspace.yaml`
→ exit 0. Rollback: tráfico a `00053-fgk` + revert del merge.

## 7. Nota de estilo compacto (investigación M4, 10 líneas)

1. El «compact algorithm» de Ant Design v5 toma el token base de 14 px a 12 px, baja la altura de
   control (de 32 px a 24–28 px), reduce `padding*`/`margin*` a la mitad y achica radios.
2. Equivalente en Tailwind/shadcn: `--spacing` de `Card` (`--card-spacing` a 12 px), controles `h-8`
   (ya de S11), texto `text-[13px]` en tablas, inputs y selects.
3. Celda de tabla `py-1` (antes `py-1.5`) y encabezado `h-7`: −4,7 px por fila.
4. `Badge` de 18 px y `Label` de 12 px ya venían de D-179; no se tocan.
5. La paleta (D-180) y los cuatro tonos de estado no cambian.
6. Jerarquía: `Section` (título 13 px semibold sobre `bg-muted/40`, cuerpo sin borde, `Separator`)
   reemplaza a la caja con borde; `Card` solo para lo independiente.
7. No se bajaron los controles por debajo de `h-8`: en las listas la altura de fila la manda la
   celda (`py-1`), no el control, así que no habría ganado filas (no se probó otra altura).
8. Se midió en el DOM (no en captura): ver §2.
9. El desplazamiento de filas por pantalla depende solo de la altura de fila; cada 1 px de fila
   son ~0,7 filas a 1366×768.
10. El siguiente paso, si se quiere más, es la altura del encabezado de página y el `gap` de `main`
    (`gap-3 p-4`), no las celdas.

## 8. Secuencia de commits

`9864460` M0 · `967bfc0` M1 · `4a8096c` M2 · tests E2E · `65265ca` M3 · `c918251` M4 · `94a0256` M5 ·
`f0bf1ca` M6 · docs y correcciones de cierre (commit siguiente).

## 9. Segunda tanda, deploy y cierre (2026-09-25, misma rama, PR #28 mergeada)

**Lo que cambia respecto de §3 a §6 de arriba:** el hallazgo de seguridad de §4.1 **está corregido**
(D-297); el texto del cliente **llegó** y `docs/cliente/correcciones-03.md` está completo (§4.2); la
ventana **se ejecutó** (§6); el gate de Sonar **pasó**.

| Milestone | Commit    | Decisión | Resumen                                                                                                                                                                                                                                                                 |
| --------- | --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | `3453b63` | —        | Texto íntegro del cliente y respuestas a los puntos 5–9 en `docs/cliente/` (6 y 8 resueltos; 5, 7 y 9 «a validar esta noche en demo»)                                                                                                                                   |
| M1        | `2c13715` | D-297    | La búsqueda de comprobantes ya no pisa el alcance del vendedor: `fiscalDocumentListWhere` compone alcance y búsqueda con `AND`; barrido de las demás listas (ninguna tenía el patrón); unitario del `where` y E2E de dos vendedores                                     |
| M2        | `1d91da6` | D-298    | Kardex con el formato del cliente (Fecha, Detalle, ENTRADAS, SALIDAS, SALDO; cantidad, C.U., monto) para **Promedio y PEPS**, en pantalla y en Excel (`GET /reports/kardex/xlsx`, solo ADMINISTRADOR); PEPS abre las salidas en una fila por capa (`PepsRow.outLayers`) |
| M3        | `9daefe0` | D-299    | Sonar: cobertura de código nuevo 55 % → gate en `pass`; hooks del web probados bajo `jsdom`                                                                                                                                                                             |
| Revisión  | `6182e3e` | —        | Correcciones de la autorrevisión de M1/M2 (descarga SUNAT con «Todo», período sin cota en el Excel de promedio) y del lint de CI                                                                                                                                        |

**Verificación de la segunda tanda:** lint, typecheck, `format:check` y unitarias (API 112 suites /
1239 pruebas; web 8 archivos) en verde; E2E afectados con builds de producción (kardex, cierre de
bobina, alcance de dos vendedores, formularios) en verde; **CI de la PR en verde en los cinco jobs**
(lint/typecheck/unit, E2E del runner, smoke con Neon `ci`, análisis estático y SonarCloud). El rojo
local `reportes-costeo-rf-s4a:167` (Nubefact) **pasó en el runner de CI**: era del entorno local.

**Autorrevisión de M1 y M2** (subagente nuevo, apéndice de `docs/revision/correcciones-03-autorrevision.md`,
sigue **PENDIENTE DE REVISIÓN INDEPENDIENTE**): 0 P0, 1 P1 (corregido), 11 P2 anotados. M1 sin
hallazgos: `AND: [{OR}, {OR}]` es correcto, `pendingOnly`/`customerId`/`salesOrderId` respetan el
alcance y ningún otro `OR` de búsqueda pisa uno de alcance.

**Deploy:** ver la sección «Ventana de Correcciones 03» de `docs/PROGRESO.md` (respaldo
`respaldo-pre-corr03-20260925`, revisión `ayr-steel-erp-api-00054-rw8` con el 100 % del tráfico y
label `git-sha=6182e3e`, smoke en verde antes y después del merge, alineación de runtime exit 0).

**Pendientes que quedan** (todos bajos, ninguno bloquea): P2 de las dos autorrevisiones (unidad de
medida en la hoja del kardex, «Saldo inicial»/«Totales» en la hoja de Promedio, tope de 10 000
movimientos en el Excel de Promedio, `aria-describedby` de `FormCell`, aserciones negativas del
menú); migrar el formulario de compra y los diálogos de acabados/colores/receta al modelo de D-293;
validar en demo los puntos 5, 7 y 9 del cliente; las ramas remotas (`fix/correcciones-03` y `docs/cierre-corr03`)
para que el dueño las borre.

**Cierre del worktree:** `local-data/corr03/` (corridas de la suite) y la captura de la hoja del
kardex se copiaron a `local-data/` del checkout principal y se compararon (mismos archivos y tamaños)
antes de borrar el worktree.
