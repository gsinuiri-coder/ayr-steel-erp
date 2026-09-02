# AYR STEEL ERP — Documento vivo de Arquitectura, Análisis y Requisitos

> **Documento vivo.** Fuente de verdad del proyecto. El agente (Claude Code) lo actualiza al cerrar cada fase: nuevas decisiones van a §0.2, avances a `docs/PROGRESO.md`, requisitos nuevos o cambiados se editan aquí con su RF.
> Origen: `AYR-Steel-ERP-Arquitectura-2026-09-01.docx` (v1, 2026-09-01). Convertido y ampliado el 2026-09-02.

## 0. Control del documento

### 0.1 Reglas de edición

- Identificadores de código (variables, propiedades, columnas, funciones, archivos, rutas API) en **inglés**. Todo lo demás (UI, mensajes, comentarios, docs, commits) en **español**.
- Cada requisito lleva ID `RF-nn`. Un RF sin referencia a módulo/ruta que lo implemente = pendiente.
- Decisiones se registran como `D-nnn` en §0.2 con fecha, decisión y motivo. No se borran; se marcan `SUPERSEDIDA por D-nnn`.
- Preguntas abiertas viven en §5 hasta resolverse; al resolverse pasan a §0.2.

### 0.2 Bitácora de decisiones (ADR corto)

| ID    | Fecha      | Decisión                                                                                                                                                                                                                                                              | Motivo                                                                                                                                                                                                               |
| ----- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-001 | 2026-09-02 | Greenfield. **No existe data real** que migrar de la versión previa (Firebase). Toda carga histórica entra por importación masiva desde planilla (RF-12, RF-52, RF-71).                                                                                               | Confirmado por el dueño del proyecto.                                                                                                                                                                                |
| D-002 | 2026-09-02 | Monorepo `pnpm` + Turborepo: `apps/api`, `apps/web`, `packages/shared`.                                                                                                                                                                                               | Tipos y esquemas Zod compartidos API↔Web.                                                                                                                                                                            |
| D-003 | 2026-09-02 | API: NestJS + Prisma. Dinero, pesos (kg) y medidas (mm) en columnas `NUMERIC` → tipo `Decimal` de Prisma. Prohibido operar montos/pesos con `number`.                                                                                                                 | Precisión exacta para kardex, costeo, IGV.                                                                                                                                                                           |
| D-004 | 2026-09-02 | Web: Next.js App Router + shadcn/ui + Tailwind + TanStack Query/Table + React Hook Form + Zod.                                                                                                                                                                        | Densidad de ejemplos para agentes; shadcn vive en el repo.                                                                                                                                                           |
| D-005 | 2026-09-02 | DB: Neon Postgres 17, proyecto `ayr-steel-erp`, región `aws-us-east-2`. Ramas: `main` (prod), `dev`, `ci`.                                                                                                                                                            | Wake ~300 ms; branching para tests.                                                                                                                                                                                  |
| D-006 | 2026-09-02 | Colas/jobs: **pg-boss** sobre Postgres. Sin Redis.                                                                                                                                                                                                                    | Una pieza menos; suficiente para SUNAT, PDFs, importaciones.                                                                                                                                                         |
| D-007 | 2026-09-02 | Storage de archivos: Cloudflare R2 (API S3), bucket `ayr-steel-erp-docs`.                                                                                                                                                                                             | XML de facturas, planillas, PDFs.                                                                                                                                                                                    |
| D-008 | 2026-09-02 | Hosting API: Google Cloud Run `us-central1` (proyecto GCP `ayr-steel-erp`), deploy `--source`. Web: Vercel.                                                                                                                                                           | Sin sleep, free tier.                                                                                                                                                                                                |
| D-009 | 2026-09-02 | Facturación electrónica vía Nubefact (sandbox hasta validación del cliente).                                                                                                                                                                                          | Proveedor ya conocido; cubre factura, boleta, NC/ND, GRE.                                                                                                                                                            |
| D-010 | 2026-09-02 | Auth propia: email+password (argon2), JWT access corto + refresh en tabla `sessions`; cambiar rol o desactivar usuario invalida sesiones (RF-03).                                                                                                                     | Sin dependencia externa; RF-01..04.                                                                                                                                                                                  |
| D-011 | 2026-09-02 | Calidad: ESLint estricto + typecheck + unit (Vitest/Jest) + E2E Playwright en CI. SonarCloud solo si su plan gratuito cubre repo privado; si no, Semgrep OSS.                                                                                                         | —                                                                                                                                                                                                                    |
| D-012 | 2026-09-02 | Agentes: Claude Code principal (auto mode + `/goal`). Antigravity CLI `agy` secundario, solo lectura/opinión (revisión, auditoría, research).                                                                                                                         | Nunca dos agentes editando el mismo archivo.                                                                                                                                                                         |
| D-013 | 2026-09-02 | App móvil fuera de alcance. RF-39 (terminal de operario) = ruta web responsive `/planta`.                                                                                                                                                                             | Alcance = app web lista para cliente.                                                                                                                                                                                |
| D-014 | 2026-09-02 | Entorno de desarrollo: Windows (cmd/PowerShell). Scripts del repo deben ser cross-platform (`pnpm` scripts, sin bash-isms).                                                                                                                                           | Máquina del dueño.                                                                                                                                                                                                   |
| D-015 | 2026-09-02 | El web consume el API por proxy same-origin `/api/*` → `API_URL` (mecanismo actualizado por D-022). Cookies httpOnly `SameSite=Lax` sin `domain`. CORS del API solo para `WEB_ORIGIN`. Detalle en `DECISIONES.md`.                                                    | Evita cookies de terceros entre Vercel y Cloud Run.                                                                                                                                                                  |
| D-016 | 2026-09-02 | La rama de producción de Neon se llama `production` (no `main`, corrige D-005). `dev` y `ci` cuelgan de ella. Endpoint prod `ep-square-cherry`.                                                                                                                       | El proyecto Neon ya venía creado así.                                                                                                                                                                                |
| D-017 | 2026-09-02 | Versiones fijadas sin `^`: NestJS 11.2, Next 15.5, Prisma 6.19, TS 5.9, ESLint 9, Zod 3.25, Jest 29 (API). Detalle en `DECISIONES.md`.                                                                                                                                | Reproducibilidad; NestJS 12/Next 16/Prisma 7/TS 7 existen pero cambian el tooling.                                                                                                                                   |
| D-018 | 2026-09-02 | Reset de DB de pruebas = `prisma migrate deploy` + `TRUNCATE` (`apps/api/prisma/reset-test-db.ts`), con bloqueo si la conexión apunta a `production`. Nunca `migrate reset`.                                                                                          | Prisma bloquea `migrate reset` invocado por agentes; el truncate es más seguro.                                                                                                                                      |
| D-019 | 2026-09-02 | Deploy web: build remoto en Vercel desde la raíz del monorepo con `rootDirectory=apps/web` (proyecto `ayr-steel-erp-web`, ligado al repo GitHub → auto-deploy en push a `main`).                                                                                      | `vercel build` local falla en Windows (symlinks).                                                                                                                                                                    |
| D-020 | 2026-09-02 | Auth: access token JWT 15 min con `sid`; el guard consulta la sesión en cada request (una lectura indexada) para que revocar sea inmediato (RF-03). Refresh 7 días, rotado en cada uso.                                                                               | Simplicidad y revocación inmediata sobre rendimiento marginal.                                                                                                                                                       |
| D-021 | 2026-09-02 | SonarCloud analiza desde CI (`sonarqube-scan-action`, con cobertura lcov del API); Automatic Analysis del proyecto desactivado. Semgrep OSS solo si `SONAR_TOKEN` está vacío.                                                                                         | Ambos modos a la vez fallan; CI permite cobertura y bloquear el pipeline.                                                                                                                                            |
| D-022 | 2026-09-02 | El proxy `/api/*` del web es un Route Handler (`apps/web/src/app/api/[...path]/route.ts`, fetch server-side en runtime Node), no un `rewrites()` de `next.config.ts`.                                                                                                 | Vercel bloquea rewrites declarativos hacia el dominio por defecto de Cloud Run (`*.a.run.app`) con `DNS_HOSTNAME_RESOLVED_PRIVATE`, falso positivo de su protección SSRF; un `fetch` normal no pasa por ese chequeo. |
| D-023 | 2026-09-02 | `scripts/gcp-secrets.mjs` otorga explícitamente a la service account de Compute por defecto: `roles/secretmanager.secretAccessor` por secreto, y `roles/{storage.objectViewer,cloudbuild.builds.builder,artifactregistry.writer,logging.logWriter}` a nivel proyecto. | `roles/editor` (rol por defecto de esa cuenta) no basta para que Cloud Build lea el zip fuente de `gcloud run deploy --source` ni para que la revisión de Cloud Run lea Secret Manager.                              |

### 0.3 Alcance de esta versión (v1 "lista para cliente")

Incluye: auth/roles, bobinas (alta manual/XML/planilla, partido, merma, cierre), producción drywall y coberturas, corte tercerizado, catálogo e inventario valorizado por línea, cotizaciones/ventas con comprobante electrónico (Nubefact sandbox), importación de comprobantes, auditoría inmutable, terminal de planta.
Excluye: app móvil nativa, contabilidad general (asientos), planillas de personal, integración bancaria.

---

## 1. Propósito y alcance

### 1.1 Qué es

AYR Steel ERP es una aplicación web interna de gestión para una empresa peruana de **transformación y comercialización de acero**. Cubre el ciclo desde la compra de materia prima (bobinas de acero) hasta la venta del producto terminado, incluyendo compra y venta de producto terminado y de productos de terceros.

Gestiona: compras afines al rubro (bobina, producto terminado, producto de terceros) y compras que son gastos a crédito, notas de débito, etc.; producción; ventas con facturación electrónica, guías y notas de crédito; y una vista por rol coherente con sus funcionalidades.

### 1.2 Qué cubre

- Registro de materia prima (bobinas) por alta manual, por XML de factura de compra y por importación masiva desde planilla.
- Transformación de bobina a producto terminado en dos líneas de producción físicas distintas (perfilería drywall y coberturas metálicas).

---

## 2. Contexto de negocio

### 2.1 El rubro

La empresa compra **bobinas de acero** (rollos planos, en inglés _coils_) y las transforma. Una bobina se caracteriza por su peso (kg), su ancho (mm), su espesor (mm) y su **acabado** —el recubrimiento superficial—, y se compra por peso a un precio por kilogramo.

De la bobina salen dos caminos productivos físicamente distintos:

- **Corte longitudinal (slitting):** la bobina se parte a lo largo en tiras de menor ancho llamadas **flejes**. Los flejes alimentan una perfiladora que produce perfiles de drywall.

- **Conformado:** la bobina pasa por una máquina conformadora que le da perfil ondulado o trapezoidal y produce coberturas y planchas metálicas.

Además la empresa revende productos que no fabrica.

### 2.2 Las cinco líneas de negocio

| **Línea**        | **Identificador** | **Modelo**     | **Materia prima**       |
| ---------------- | ----------------- | -------------- | ----------------------- |
| Drywall          | drywall           | Transformación | Bobina → fleje → perfil |
| Metallic Roofing | metallic-roofing  | Transformación | Bobina → conformado     |
| Roofing (UPVC)   | roofing           | Compra-venta   | Producto terminado      |
| Trading          | trading           | Compra-venta   | Producto de terceros    |
| Services         | services          | Sin stock      | N/A                     |

La línea services es deliberadamente una operación nula sobre inventario: su estrategia de inventario es `noop` (no crea movimientos de kardex).

---

## 3. Arquitectura técnica

### 3.1 Estructura del repositorio

```
ayr-steel-erp/
  apps/
    api/          NestJS 11 + Prisma + pg-boss      → Cloud Run
    web/          Next.js 15 (App Router) + shadcn  → Vercel
  packages/
    shared/       Zod schemas, tipos, enums, utilidades Decimal
  docs/
    ARQUITECTURA.md   (este archivo)
    DECISIONES.md     (espejo de §0.2, formato ADR largo cuando haga falta)
    PROGRESO.md       (estado por fase, qué falta, bloqueos)
    handoff/          (resúmenes de cierre de sesión)
  .claude/        settings.json, agents/, commands/
  .mcp.json       playwright (headless), context7
  CLAUDE.md       reglas operativas del agente
```

### 3.2 Módulos del API (NestJS)

`auth` · `users` · `business-lines` · `finishes` (acabados) · `coils` (bobinas, partidos, mermas, cierre) · `strips` (flejes, corte tercerizado) · `production` (drywall, coberturas, cola) · `catalog` (productos por línea) · `inventory` (kardex, movimientos, valorización) · `quotes` · `sales` · `invoicing` (Nubefact, XML UBL 2.1) · `imports` (planillas, XML) · `documents` (R2) · `audit` · `jobs` (pg-boss).

Regla transversal: **todo cambio de stock pasa por `inventory`** como movimiento de kardex inmutable; los módulos nunca escriben stock directamente.

### 3.3 Modelo de datos — principios

- Toda entidad con stock lleva `businessLineId`. `services` no tiene stock (estrategia `noop`).
- Bobina: `weightKg`, `widthMm`, `thicknessMm`, `finishId`, `currency`, `exchangeRate`, `unitCostPerKg`, `typeKey` (acabado+espesor), `code` (proveedor-acabado-espesor-peso-correlativo). Partido = bobina hija con `parentCoilId`.
- Kardex: tabla `inventory_movements` append-only (`type`, `qty`, `unitCost`, `refType`, `refId`, `reversalOfId`). Anulaciones = movimiento inverso, nunca delete.
- Auditoría: `audit_log` append-only con `actorId`, `action`, `entity`, `entityId`, `before`, `after`, `at`.
- Todos los `Decimal` con escala explícita: dinero 4, kg 3, mm 2.

### 3.4 Roles (RF-02)

| Rol               | Alcance                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| ADMINISTRADOR     | Todo, incl. usuarios, catálogos, anulaciones, auditoría                |
| SUPERVISOR_PLANTA | Bobinas, producción, corte tercerizado, inventario, terminal `/planta` |
| VENDEDOR          | Cotizaciones, ventas, catálogo (lectura), inventario (lectura)         |

### 3.5 Integraciones

| Servicio      | Uso                              | Credencial                       |
| ------------- | -------------------------------- | -------------------------------- |
| Nubefact      | Emisión factura/boleta/NC/ND/GRE | `NUBEFACT_URL`, `NUBEFACT_TOKEN` |
| Cloudflare R2 | Archivos                         | `R2_*`                           |
| Neon          | DB + ramas                       | `DATABASE_URL`, `DIRECT_URL`     |
| UptimeRobot   | Monitores `/health` y web        | `UPTIMEROBOT_API_KEY`            |

### 3.6 Entornos

| Entorno | API                         | Web            | DB                                 |
| ------- | --------------------------- | -------------- | ---------------------------------- |
| local   | `pnpm dev` (localhost:3000) | localhost:3001 | Neon rama `dev`                    |
| ci      | GitHub Actions              | build          | Neon rama `ci` (reset por corrida) |
| prod    | Cloud Run                   | Vercel         | Neon `main`                        |

### 3.7 Fases de construcción

| Fase | Entrega                                                                     | Cierre (`/goal`)                          |
| ---- | --------------------------------------------------------------------------- | ----------------------------------------- |
| 0    | Bootstrap: monorepo, CLAUDE.md, CI, auth, deploy vacío, monitores           | Login E2E verde en prod, CI verde         |
| 1    | Líneas, acabados, catálogo, importación planilla                            | RF-25, RF-50, RF-52 E2E                   |
| 2    | Bobinas completas (RF-10..RF-23) + kardex                                   | E2E alta/partido/merma/cierre             |
| 3    | Corte tercerizado + flejes (RF-40..42)                                      | E2E envío/recepción/prorrateo             |
| 4    | Producción drywall + coberturas + cola + `/planta` (RF-30..39)              | E2E corrida y anulación                   |
| 5    | Cotizaciones y ventas (RF-60..69)                                           | E2E cotización→producción→venta→anulación |
| 6    | Facturación Nubefact + XML + importación comprobantes (RF-11, RF-71, RF-72) | Comprobante sandbox aceptado              |
| 7    | Auditoría, reportes, hardening, UAT                                         | Checklist cliente                         |

---

## 4. Requisitos funcionales

Cada requisito está trazado a la ruta, el callable o el módulo que lo implementa. Si un requisito no tiene una referencia de código al lado, no está en esta lista.

### 4.1 Autenticación y usuarios

| **#** | **Requisito**                                                                      |
| ----- | ---------------------------------------------------------------------------------- |
| RF-01 | El usuario inicia sesión con correo y contraseña.                                  |
| RF-02 | Cada usuario tiene exactamente un rol: ADMINISTRADOR, SUPERVISOR PLANTA, VENDEDOR. |
| RF-03 | Bajar el rol de un usuario o desactivarlo invalida sus sesiones abiertas.          |
| RF-04 | Un administrador gestiona el alta, edición y baja de usuarios.                     |

### 4.2 Materia prima (bobinas)

| **#** | **Requisito**                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------ |
| RF-10 | Alta individual de bobina con datos de factura de compra.                                              |
| RF-11 | Alta de bobina a partir del XML de la factura electrónica del proveedor.                               |
| RF-12 | Alta masiva desde planilla, con revisión previa fila por fila.                                         |
| RF-13 | El identificador de bobina se genera con formato compuesto proveedor-acabado-espesor-peso-correlativo. |
| RF-14 | Cada bobina lleva una clave de tipo que agrupa por acabado y espesor, ignorando el ancho.              |
| RF-16 | Revertir un partido, devolviendo peso y ancho a la madre.                                              |
| RF-17 | Registrar merma sobre una bobina.                                                                      |
| RF-18 | Anular una merma mal registrada.                                                                       |
| RF-19 | Abrir y cerrar una bobina; una bobina cerrada no entra a producción.                                   |
| RF-20 | Editar los datos de una bobina, incluida su moneda y tipo de cambio.                                   |
| RF-21 | Anular una bobina solo si no tiene ningún movimiento.                                                  |
| RF-22 | Cancelar el plan de corte de una bobina.                                                               |
| RF-23 | Consultar inventario de bobinas separado por línea de negocio.                                         |
| RF-25 | Gestionar el catálogo de acabados con su factor de densidad.                                           |

### 4.3 Producción

| **#** | **Requisito**                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------- |
| RF-30 | Producir cobertura o plancha consumiendo una o varias bobinas a la vez.                           |
| RF-31 | Toda producción de coberturas debe ir contra una cotización; no se admite producción suelta.      |
| RF-32 | Una misma corrida no puede mezclar bobinas de acabados distintos.                                 |
| RF-33 | Anular una producción de coberturas devuelve a cada bobina el peso exacto que consumió.           |
| RF-34 | Producir perfiles de drywall desde fleje.                                                         |
| RF-35 | Revertir una producción de drywall.                                                               |
| RF-36 | No se puede anular una producción si el producto resultante ya tiene una venta cerrada posterior. |
| RF-37 | La cola muestra las cotizaciones confirmadas pendientes de fabricar, con su avance.               |
| RF-38 | Un indicador en el menú lateral muestra cuántas cotizaciones esperan producción.                  |
| RF-39 | Terminal simplificada para el operario de planta.                                                 |

### 4.4 Corte tercerizado

| **#** | **Requisito**                                                   |
| ----- | --------------------------------------------------------------- |
| RF-40 | Enviar bobinas a un tercero para corte, con plan de anchos.     |
| RF-41 | Recibir los flejes y prorratear el costo del servicio por peso. |
| RF-42 | Consultar el stock de flejes por ancho.                         |

### 4.5 Catálogo e inventario

| **#** | **Requisito**                                                             |
| ----- | ------------------------------------------------------------------------- |
| RF-50 | Cada línea tiene su catálogo propio de productos.                         |
| RF-51 | Cada línea con stock tiene su vista de inventario valorizado.             |
| RF-52 | Importación masiva de catálogo desde planilla, con edición fila por fila. |
| RF-53 | Consultar el kardex de un producto o de una bobina.                       |

### 4.6 Ventas y cotizaciones

| **#** | **Requisito**                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| RF-60 | Emitir una venta desde el punto de venta interno.                                                                                   |
| RF-61 | Emitir una cotización.                                                                                                              |
| RF-62 | Confirmar una cotización para producción.                                                                                           |
| RF-63 | Registrar que el cliente aceptó una cotización y con ello mandarla a producción. **Pendiente P-03:** ¿orden de producción separada? |
| RF-64 | Convertir una cotización en venta, descontando stock.                                                                               |
| RF-65 | Cancelar una cotización.                                                                                                            |
| RF-66 | Editar una cotización propia que no tenga producción viva.                                                                          |
| RF-67 | Anular una venta, con cascada sobre su cotización gemela y reversa de stock.                                                        |
| RF-68 | Listar ventas con búsqueda, filtros y totales agregados del conjunto filtrado.                                                      |
| RF-69 | Listar cotizaciones por separado de las ventas.                                                                                     |
| RF-71 | Importar comprobantes ya emitidos desde planilla, incluidas notas de crédito.                                                       |
| RF-72 | Reimportar un comprobante ya importado archiva la versión anterior en vez de pisarla.                                               |
| RF-73 | Venta directa de bobina (sin transformar). Ver P-04.                                                                                |

### 4.9 Auditoría y configuración

| **#** | **Requisito**                                            | **Implementación** |
| ----- | -------------------------------------------------------- | ------------------ |
| RF-95 | Toda acción crítica queda registrada de forma inmutable. |
| RF-96 | Consultar el registro de auditoría.                      |                    |

---

## 5. Preguntas abiertas (pendientes de grill)

| #    | Pregunta                                                                                                                     | Recomendación del agente                                                                                     | Estado               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------- |
| P-01 | ¿Data real que migrar?                                                                                                       | —                                                                                                            | **Resuelta → D-001** |
| P-02 | ¿El ERP emite comprobantes directo a SUNAT (Nubefact API) o solo registra/importa los emitidos fuera?                        | Emitir directo desde ventas; importación (RF-71) solo para histórico/contingencia.                           | Abierta              |
| P-03 | RF-63: ¿cotización confirmada genera **orden de producción** separada o la cotización misma es la orden?                     | Orden de producción separada (`production_orders`), con FK a cotización. Permite parciales y reprogramación. | Abierta              |
| P-04 | Venta directa de bobina: ¿se genera SKU en catálogo o se vende por código de bobina?                                         | Vender por código de bobina, línea `trading`, sin SKU; kardex descuenta la bobina completa.                  | Abierta              |
| P-05 | Método de valorización del kardex: promedio ponderado vs PEPS.                                                               | Promedio ponderado por producto/línea (más simple, aceptado por SUNAT).                                      | Abierta              |
| P-06 | Moneda: ¿ventas en PEN y USD? ¿Tipo de cambio manual o SUNAT diario?                                                         | Ambas monedas; TC manual editable con default del último usado.                                              | Abierta              |
| P-07 | Compras que son gastos/crédito y notas de débito (§1.1): ¿módulo de compras completo con cuentas por pagar, o solo registro? | v1: registro de compras + saldo por proveedor; sin contabilidad.                                             | Abierta              |
| P-08 | Secciones faltantes del docx (3, 4.7, 4.8, RF-15, RF-24, RF-70): ¿existían (reportes, clientes, proveedores)?                | Asumir 4.7 = clientes/proveedores, 4.8 = reportes; confirmar.                                                | Abierta              |
| P-09 | Precio de venta: ¿lista de precios por línea, por cliente, o manual por cotización?                                          | Lista base por producto + override manual con permiso.                                                       | Abierta              |
| P-10 | Corte tercerizado: ¿un solo proveedor de corte o varios? ¿costo por kg fijo?                                                 | Varios proveedores; costo por kg ingresado al recibir.                                                       | Abierta              |

---
