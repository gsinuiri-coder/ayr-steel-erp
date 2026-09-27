# Handoff — Drywall sin receta, ancho del accesorio y notas de crédito por línea (D-344 a D-346)

**Estado al cierre:** el trabajo está en el PR #43 (`feat/drywall-sin-receta`), con CI en curso o
en SUCCESS (confirmar antes del deploy). **No desplegado todavía**: esta ventana empieza el lunes,
con OK del dueño por comando (D-251). Decisiones **D-344**, **D-345** y **D-346** en
`docs/ARQUITECTURA.md` §0.2. Guion UAT: `docs/uat/drywall-sin-receta.md`. Bitácora:
`docs/PROGRESO.md`, entrada «Drywall sin receta» en el registro de riesgo. Respuesta a la
revisión: `docs/revision/drywall-sin-receta-segundo-modelo.md`.

## 1. Qué entró

| Milestone | Decisión | Resumen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1        | D-344    | **Drywall deja de usar receta.** El espesor y el ancho del fleje son datos del SKU (`products.thickness_mm`/`width_mm`; corrige la lectura de D-118: en drywall `width_mm` es el ancho del **fleje**, no el de la pieza). El acabado no se guarda: siempre galvanizado. Fleje compatible en un solo lugar (`apps/api/src/common/drywall-strip.ts`): `STRIP` + acabado `GALVANIZADO` + espesor y ancho **exactos** (sin la tolerancia de coberturas). Piso desde el SKU (`STRIP_SKU`), con motivos `NO_THICKNESS`/`NO_WIDTH`/`NO_PIECE_WEIGHT`/`NO_COMPATIBLE_STRIPS`/`NO_MARGIN`. La OP nace sin `bom_id`, con las mismas dos guardas que tenía la receta (fabricado y `NIU`) restituidas en `ProductionService.create`/`stripOptions` y en `CatalogService.update` (no se cambia unidad/origen/espesor/ancho con una OP en curso). Se retiran `BomsService`, `/production/boms` y el diálogo de receta. Aviso (no bloqueo) de kg/pieza a más del 5 % del teórico. |
| M2        | D-345    | El reporte de un accesorio **avisa** —sin bloquear ni cambiar ningún cálculo— cuando el ancho de la bobina montada no es el del SKU.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| M3        | D-346    | Lo facturado por línea de pedido descuenta las **notas de crédito vivas** (una sola función, `invoicedByOrderItem`, usada por el guard de facturación, la vista de avance y la revalidación al emitir).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| M4        | —        | Ramas de Neon: 3 borradas con OK del dueño por nombre (`respaldo-pre-s2-20260917`, `ensayo-v4-20260915`, `dev-antes-de-rf-s3-20260917`). Quedan 18.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**Cambios de comportamiento que el dueño debe tener presentes:**

- **Los 10 perfiles de drywall activos en producción no tienen espesor** (medido antes de esta
  sesión): quedan «Sin espesor en el SKU: sin piso» hasta que se cargue, y **no se puede abrir una
  orden** para ellos. Tres (`PERFILH`, `PERFILU`, `R39GALV090`) además tienen ancho y peso de
  relleno (1.00 mm / 1.000 kg) que hay que corregir. **En producción no hay flejes (`STRIP`)**: la
  producción de drywall espera al primer corte.
- **Los pesos declarados no llevan el 1 % de merma de D-165.** OMEGA045 (115 mm de fleje, 3 000 mm,
  0.45 mm) tiene declarado 1.220 kg; sin merma da 1.219, con merma 1.231. El piso de esos perfiles
  queda ~1 % por debajo de lo que debería hasta que se revisen los pesos. No es un defecto de
  código: es un dato de catálogo.
- **`product_boms` no se borra.** La migración `20260927120000_d344_drywall_sin_receta` agrega
  `CHECK (NOT is_active)` y **falla a propósito** si la rama tiene una receta activa; antes de
  aplicarla en dev o demo hay que correr `pnpm retire:boms --branch <rama> --execute` (dry-run por
  defecto, auditada). En producción el dry-run debe confirmar 0 activas (medido: 1 receta, de
  cobertura, inactiva).
- **NC de solo monto también liberan cantidad.** Una nota de crédito de motivo «descuento» o
  «ajuste» copia siempre `qty`, así que también repone cantidad facturable de la línea — igual que
  D-223 ya hace con el total en dinero. No se cambió: es una decisión de negocio, no un defecto.

## 2. Secuencia de commits (PR #43)

`c3cdf91` M3 (NC por línea) · `6725308` M1 (drywall sin receta) · `4989814` M2 (aviso de ancho del
accesorio) · `29cf0f3` guardas de la receta trasladadas · `a154590` E2E y docs · `4c59543`
correcciones de la revisión.

## 3. Revisiones

- **Autorrevisión** (subagente nuevo, sin leer el handoff) y **segundo modelo** (subagente
  `sonnet`, contexto limpio): 0 P0. Los 3 P1 (lint roto en CI, un locator y una aserción del E2E
  nuevo, `galvanizedDensity()` sin filtrar por línea) se corrigieron antes del deploy, con tests.
  Detalle y respuesta a cada punto: `docs/revision/drywall-sin-receta-segundo-modelo.md`.
- **Ningún pase es independiente** (AGENTS §2): registrado en `docs/PROGRESO.md` como **PENDIENTE
  DE REVISIÓN DEL DUEÑO**, con las piezas de riesgo (el fleje compatible, la migración `d344`, la
  CLI de retirada y las lecturas de `productBom` eliminadas de ventas).

## 4. Pendientes y decisiones abiertas (del dueño)

1. **Cargar el espesor de los 10 perfiles de drywall** y corregir ancho/peso de `PERFILH`,
   `PERFILU` y `R39GALV090` (lista completa en `docs/cliente/revision-2026-09-25.md` §2.5).
2. **Revisar si los pesos declarados deben llevar el 1 % de merma de D-165** (ver arriba). Si el
   dueño decide que sí, es una corrección de datos, no de código: se recalculan y se recargan desde
   el catálogo.
3. **Decidir si una NC de solo monto debería seguir liberando cantidad facturable** (hoy sí, por
   coherencia con D-223). Si el dueño quiere separarlo, es alcance nuevo.
4. **Correr `pnpm retire:boms` en dev y demo** antes de aplicar la migración `d344` ahí (en
   producción no hace falta: 0 recetas activas).
5. **Revisión con ojos frescos** de las piezas de riesgo (§3).

## 5. Rollback

- **Migración:** aditiva (`ADD CONSTRAINT ... CHECK (NOT is_active)`), no se revierte; deja de
  aplicarse volviendo a una API anterior. Si hiciera falta deshacerla, es un
  `ALTER TABLE product_boms DROP CONSTRAINT product_boms_none_active_ck` con aprobación explícita
  del dueño (regla dura 3: nunca SQL directo sin ella).
- **API:** llevar el tráfico a la revisión anterior. Una API anterior a esta ventana sigue
  funcionando sobre el esquema nuevo (ignora el `CHECK`); lo que no podría es abrir una OP de
  drywall sin receta, porque el código viejo la exige.
- **Datos:** `retireActiveBoms` es una desactivación (`isActive: false`), append-only en el
  sentido de que queda auditada; revertirla es reactivar la receta a mano si hiciera falta (no hay
  caso de uso previsto).

## 6. Lo que la sesión siguiente tiene que saber (aprendido en esta)

- **`width_mm` de drywall cambió de significado** (de «ancho de la pieza» a «ancho del fleje»):
  cualquier código o dato que asumiera lo primero para drywall específicamente hay que revisarlo
  (ya se revisaron todos los que existían: catálogo, planta, corte, piso, ventas).
- **Cargar un dato que faltaba con una OP en curso no debe bloquearse** — solo cambiar o quitar un
  dato que una orden ya usó. Es una distinción sutil (`null → valor` vs. `valor → otro valor` o
  `valor → null`) que el primer intento de la guarda no hacía bien; quedó cubierta con tests.
- **`getByText` en Playwright hace match por substring**: un texto de ayuda que contenga la
  palabra que se busca ocultar hace fallar un `toBeHidden()`. Usar `getByLabel` para campos de
  formulario.
