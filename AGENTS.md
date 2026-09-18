# AGENTS.md — Reglas del repositorio AYR Steel ERP

Archivo canónico de contexto para TODOS los agentes que trabajan este repo: Codex CLI y
Antigravity (`agy`).

> Si una regla de este archivo choca con lo que el agente cree saber, manda este archivo.
> Si choca con una instrucción directa del dueño en la sesión, manda el dueño y se registra
> como decisión `D-nnn`.

El arquitecto del proyecto es el dueño, asesorado en conversación aparte. Los agentes de este
repo **implementan y verifican**: no redefinen alcance, no inventan tareas, no deciden política.

---

## 1. Qué es esto

ERP de una empresa peruana de transformación y comercialización de acero (coberturas y drywall).
**Producción tiene datos reales desde el 2026-09-07; el dataset operativo actual fue saneado y
recargado en V-4 el 2026-09-15**: hay clientes, cotizaciones, pedidos, kardex y comprobantes
reales. Nada de limpias casuales, nada de datos de prueba en prod.

- Monorepo TypeScript: pnpm + Turborepo.
- API NestJS en Cloud Run (`ayr-steel-erp-api`, us-central1, proyecto `ayr-steel-erp`).
- Web Next.js 15 App Router en Vercel (`https://v2.mareliac.pe`).
- Prisma + Postgres en Neon. Ramas: `production`, `demo`, `dev`, `ci` (+ respaldos con fecha).
- UI: shadcn/ui + Tailwind + TanStack Query/Table + React Hook Form + Zod.
- Colas con pg-boss (sin Redis). Documentos en Cloudflare R2. PSE SUNAT: Nubefact.
- E2E con Playwright, CI en GitHub Actions. Cuenta GitHub: `gsinuiri-coder`.

Perfil de uso: **solo escritorio**. No hay objetivo móvil ni tablet. Alta densidad de información.

Fuentes de verdad, en este orden:

1. `AGENTS.md` (este archivo) — reglas de comportamiento.
2. `.agents/skills/` — procedimientos ejecutables (arranque, cierre, revisión, QA, handoff, ventana).
3. `docs/ARQUITECTURA.md` §0.2 — bitácora de decisiones `D-nnn`.
4. `docs/PROGRESO.md` — estado por fase/sesión.
5. `docs/DECISIONES.md` — contexto largo cuando una fila de §0.2 no basta.
6. `docs/handoff/<ultima-ventana>.md` — último cierre.
7. `docs/ENTORNOS.md` — entornos, runbooks de ventana, PITR.

Antes de programar se leen, como mínimo, `AGENTS.md`, `docs/PROGRESO.md`, el último handoff y
las partes aplicables de `docs/ARQUITECTURA.md`: §0.2, §3 para arquitectura/modelo, §4 para los
RF del alcance y §5 para formular una recomendación cuando exista una pregunta abierta. Leer
`docs/ENTORNOS.md` antes de operar entornos y `docs/DECISIONES.md` cuando §0.2 remita a contexto
largo.

---

## 2. Los dos agentes

| Agente                  | Rol                                                                                            | Escritura                                             | Modo                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| **Codex CLI**           | **Agente principal.** Sesiones de ventana (`RF-Sn`), features, migraciones, cierre             | Sí, en su worktree                                    | aprobación **Auto** (`workspace-write`), nunca Full Access |
| **Antigravity (`agy`)** | **Segundo implementador.** Tareas acotadas en paralelo y revisión cruzada del trabajo de Codex | Sí, en su propio worktree; solo lectura cuando revisa | acotado                                                    |

Reglas de convivencia, sin excepción:

1. **Un solo agente escritor por worktree y por rama.** Dos agentes no comparten directorio.
   Cada sesión vive en su worktree: `ayr-steel-erp-<rama>`.
2. **El revisor nunca es el autor.** Si implementó Codex, revisa `agy`; si implementó `agy`,
   revisa Codex. Sin pase de revisión independiente, la sesión no cierra.
3. **Una rama por ventana/tarea**, desde `origin/main` actualizado. Nunca se trabaja directo
   sobre `main`. Antes de abrir rama: `git fetch` y CI de `main` verde
   (`gh run list --branch main --limit 3`).
4. El agente que abre sesión **lee primero** `AGENTS.md` → `docs/PROGRESO.md` → último handoff,
   y **reporta el estado entendido antes de escribir código** (skill `ayr-arranque`).
5. **El handoff es el único canal de traspaso entre agentes** (skill `ayr-handoff`). Lo que no
   está en el handoff, en `PROGRESO.md` o en una decisión `D-nnn`, no existe para el siguiente.
6. Ningún agente arranca una sesión nueva por iniciativa propia ni encadena tareas fuera del
   prompt que recibió.

---

## 3. Reglas duras (nunca se saltan)

1. **Los agentes pueden empujar ramas de trabajo y abrir PRs.** Solo pueden empujar o mergear a
   `main` después de presentar al dueño un resumen de commits, CI, despliegue y riesgo, y recibir
   su OK explícito en la sesión. Sin ese OK, `main` sigue bloqueada por el hook; con él, se usa
   `AYR_OWNER_PUSH=1`. `gh repo sync` y el borrado de ramas protegidas siguen prohibidos.
2. **Credenciales nunca en argv ni impresas.** Los comandos que podrían imprimirlas (p. ej.
   `neonctl`) van en modo silencioso y con `--output json`. Las cadenas de conexión viajan por
   entorno o archivo, jamás por línea de comandos.
3. **SQL directo contra `production` prohibido.** Todo pasa por servicios de dominio. Las
   migraciones contra prod se corren con aprobación manual explícita del dueño, nunca en un
   turno automático.
4. **Nada destructivo sobre datos reales.** Exige respaldo Neon + decisión del dueño + horario
   muerto. Borrar ramas Neon: solo con OK del dueño **por nombre**, conservando
   `respaldo-pre-v4-20260915`.
5. **Dry-run por default.** Escrituras masivas requieren `--confirm-production`; un
   `--execute --confirm-production` exige aprobación explícita del dueño.
6. **Los puertos 4000/4001 son del dueño** (`dev:preview`). Ningún agente los toca ni los mata.
   El entorno demo corre en web 3001 / api 3000.
7. **Sin texto multilínea por `node -e` ni interpolación de shell** (regla añadida después de
   borrar por accidente la BD de E2E).
8. **Todo movimiento de stock pasa por `InventoryService.record()`.** El kardex es append-only:
   las reversas son movimientos inversos, nunca edición de saldos.
9. **`Decimal`, nunca `number`,** para dinero, pesos y dimensiones.
10. **Sin creación silenciosa de entidades.**
11. **Orden de deploy siempre:** migraciones Prisma → deploy API → push web.
12. **`e2e:prod` prohibido** con datos reales en producción (D-126). La verificación
    post-deploy es `pnpm smoke:prod`, de solo lectura. La suite completa vive en local y CI. Si
    alguna vez corre por accidente, ejecutar `pnpm prod:purge-e2e` inmediatamente y documentar
    el incidente en `docs/PROGRESO.md`; la purga es solo una herramienta de emergencia y no
    convierte la corrida en segura.
13. **`needsPieces` se decide por unidad de venta**, nunca por subtipo de producto (D-131).
    `sellsByLength(product)` —`unit === MTR`— responde si la línea necesita detalle de largos;
    `isMadeToMeasure(product)` —`roofingKind === A_MEDIDA`— responde si se cotiza a medida.
    Son preguntas distintas aunque ambas devuelvan `boolean`; el centinela vive en
    `apps/api/src/sales/sales-lines.spec.ts`.
14. **La historia previa al día D vive fuera del sistema** (D-150): no se importan compras ni
    movimientos históricos. Única excepción viva: la herramienta de inventario inicial
    (D-206/D-207), que hereda invariantes vía servicios de dominio y rechaza correr sobre
    bobinas con kardex.
15. **Las reversas se construyen en la misma fase que la operación directa.**
16. **Ambigüedad = detenerse, presentar recomendación y esperar decisión del dueño** (D-230),
    nunca suposición silenciosa ni alcance inventado. Toda ambigüedad de alcance o política
    requiere decisión antes de implementar; la recomendación y la decisión se registran como
    `D-nnn`. Esto sustituye la regla anterior de aplicar por cuenta propia la recomendación de
    `docs/ARQUITECTURA.md` §5 salvo acción externa.

### 3.1 Credenciales y secretos

- `.env.setup` contiene las credenciales. Nunca imprimirlo, commitearlo, copiar valores a código
  o docs, ni apuntar un comando de diagnóstico (`rg`, `grep`, `ls`, `find`, `head`, `tail`, `wc`)
  a `.env*` o a rutas/globs que puedan expandirse a ellos. Los scripts lo leen con
  `scripts/lib.mjs#readEnvFile`.
- Una credencial jamás viaja por `argv`; siempre por el entorno del proceso hijo. Nada de
  `--url <cadena>`, `--password` o `--token`: los argumentos son visibles en el proceso y se
  imprimen con frecuencia cuando un comando falla.
- Todo helper compone errores sin repetir argumentos. `scripts/lib.mjs#run` filtra
  `secret|password|token`; ningún helper local arma errores con `args.join(' ')`.
- La contraseña de `neondb_owner` es la misma en las cuatro ramas Neon: exponer `dev` o `demo`
  expone también `production`.
- Todo comando que pueda emitir credenciales aun cuando termina bien —`neonctl`,
  `connection-string`, dumps de configuración o `gcloud ... describe` sobre secretos— se
  invoca mediante `scripts/lib.mjs#run` con `quiet: true` y `--output json`, y solo se leen del
  JSON los campos necesarios. Nunca se ejecuta directo con salida heredada.
- Ante una fuga, la credencial se rota; no basta con «tener cuidado». Rotar `neondb_owner`
  implica `neonctl roles reset-password` y actualizar `.env.setup`, Secret Manager y GitHub
  Actions. Mientras no se rote, producción está comprometida y el incidente se registra en
  `docs/PROGRESO.md` con fecha y hora exactas.
- `migrate deploy`, `migrate diff`, `db:prod` y cualquier comando con credenciales de BD de
  producción se ejecutan con el dueño fuera de modo automático, con aprobación manual
  individual por comando. Una autorización de ventana no permite encadenarlos.

### 3.2 Git, deploy y sincronización de artefactos

- Web y API van juntos. Toda ventana verifica que el label `git-sha` de la revisión activa de
  Cloud Run corresponde al SHA desplegado. El deploy de API siempre lleva
  `--update-labels git-sha=<sha-corto>`; un push a `main` publica el web en Vercel, no la API.
- `pnpm smoke:prod` se corre desde un worktree en el mismo SHA desplegado: un smoke más nuevo
  que la API produce falsos rojos y uno más viejo, falsos verdes.
- Un `migrate diff` no vacío solo se admite si coincide **exactamente** con el drift conocido en
  `docs/PROGRESO.md`; cualquier diferencia nueva obliga a parar.
- El label puede quedar detrás de commits posteriores exclusivamente documentales. Verificarlo
  con `git diff --quiet <sha-desplegado> origin/main -- apps packages Dockerfile .gcloudignore
package.json pnpm-lock.yaml pnpm-workspace.yaml`. Exit 0 permite cerrar; exit 1 significa
  desalineación de runtime y obliga a parar.
- `pnpm setup:agentes` configura `core.hooksPath=.githooks`. `.githooks/pre-push` permite ramas
  de trabajo y bloquea cualquier push cuyo destino sea `main`; `AYR_OWNER_PUSH=1` solo se usa
  después del OK explícito del dueño exigido por D-232.

### 3.3 Datos reales, Neon y operaciones destructivas

- Nunca se borran `production`, `dev`, `ci`, `demo` ni `respaldo-pre-v4-20260915`.
- Un respaldo pre-ventana solo se borra con OK explícito del dueño **por nombre**, cuando la
  ventana está cerrada/verificada y existe un respaldo posterior que cubre el mismo estado.
  Conservar siempre los dos respaldos post-día-D más recientes. Tras cada ventana verificada,
  se pueden proponer para borrado los respaldos de ventanas verificadas con más de siete días,
  conservando siempre el respaldo del día D. Las ramas de ensayo también requieren OK por
  nombre. Antes de borrar, verificar que el ID coincide con el nombre.
- Datos reales de clientes/importaciones (Excel, CSV, JSON de decisiones, RUC, montos) viven en
  `local-data/`, ignorada por completo; nunca quedan sueltos en la raíz. Un script de un solo
  uso se crea, ejecuta y borra en la misma sesión. Si debe sobrevivir, va a `scripts/oneoff/`
  con fecha en el nombre.
- Dry-run es el default. Toda escritura masiva exige `--confirm-production`; combinar
  `--execute --confirm-production` requiere aprobación explícita del dueño.

### 3.4 Invariantes técnicas y de dominio

- `Decimal` (D-003): dinero, kg y mm nunca se operan con `number`. Usar
  `Decimal`/`money()`/`kg()`/`mm()` de `@ayr/shared`; columnas `NUMERIC` con escala dinero 4,
  kg 3 y mm 2; serializar como string.
- Auditoría (RF-95): `audit_log` es append-only y las acciones críticas pasan por
  `AuditService.log`/`write`. Nunca actualizar ni borrar su historia.
- Sesiones (RF-03): cambiar rol, desactivar un usuario o resetear contraseña llama a
  `AuthService.revokeAllSessions`.
- Todo hecho fechado del dominio —kardex, bobina, corte, OP, reporte de piezas, despacho,
  cobranza, pago— lleva `operationDate` (día de negocio en Lima), por defecto hoy y editable
  solo por ADMINISTRADOR mediante `OperationDateService.resolve`. `createdAt`/`at` son
  auditoría; reportes, listados y agrupados por fecha leen `operationDate`.
- Sin creación silenciosa de entidades. Validar con Zod en los bordes y derivar tipos de los
  schemas, sin duplicarlos.
- No almacenar estado derivado que pueda calcularse al leer. Si rendimiento exige agregar,
  usar consulta agregada y un presupuesto de consultas verificado por test, nunca caché
  silenciosa.
- Formularios usan `Button` con `pending`/`pendingText` centralizado. Operaciones repetibles
  llevan `idempotencyKey`, regenerada si cambia el payload.

### 3.5 Shell, Windows, puertos y fallos externos

- Los scripts son cross-platform Node/pnpm, sin bashismos. Desde Git Bash, `gcloud` se invoca
  vía `cmd /c gcloud ...`.
- Los comandos se corren desde la raíz del repo con rutas relativas; nunca se prefijan con
  `cd ... &&`.
- Los puertos 4000/4001 y `pnpm dev:preview` son del dueño, contra `ayr_local`. El agente usa
  3000/3001 mediante `pnpm dev:local`; Playwright puede matar y levantar esos dos. Nunca usar
  `ayr_local_e2e` para `dev:preview`. Antes de matar por puerto, identificar el proceso.
- Ningún texto largo pasa por shell: nunca `node -e`, `python -c`, `echo` ni interpolación para
  escribir docs, código o mensajes multilínea. Si un heredoc fuera imprescindible, el
  delimitador va entre comillas simples (`<<'EOF'`) para desactivar expansión.
- Si un comando externo falla tres veces, documentar el bloqueo en `docs/PROGRESO.md` y seguir
  con lo que no dependa de él.

---

## 4. Git, ramas y commits

- Rama por ventana: `rf-s4`, `chore/agents`, `hotfix-401`… siempre desde `origin/main`.
- Worktree por sesión: `git worktree add ../ayr-steel-erp-<rama> <rama>`.
- **Conventional commits en español**: `feat(sales): …`, `fix(catalog): …`, `docs(progreso): …`.
- Commits chicos y temáticos; el handoff lista la secuencia al cierre.
- Al cerrar el worktree: eliminarlo junto con la rama local. La rama remota la borra el dueño.

---

## 5. Ciclo de sesión

Los pasos viven como skills en `.agents/skills/`. Codex y Antigravity las disparan por su
descripción o explícitamente con `$ayr-<nombre>`; no se usan custom prompts de Codex porque
están deprecados.

| Momento  | Skill          | Invocación explícita | Qué hace                                                         |
| -------- | -------------- | -------------------- | ---------------------------------------------------------------- |
| Arranque | `ayr-arranque` | `$ayr-arranque`      | Lee contexto, reporta estado y plan por milestones, espera OK    |
| Revisión | `ayr-revisor`  | `$ayr-revisor`       | Pase de revisión de código, por un agente que no escribió        |
| QA       | `ayr-qa`       | `$ayr-qa`            | Lint, typecheck, unitarios, E2E completo, clasificación de rojos |
| Cierre   | `ayr-cierre`   | `$ayr-cierre`        | Docs, `D-nnn`, handoff, guion UAT, commits sin push              |
| Handoff  | `ayr-handoff`  | `$ayr-handoff`       | Formato único de traspaso entre sesiones y agentes               |
| Ventana  | `ayr-ventana`  | `$ayr-ventana`       | Runbook de deploy con paradas de aprobación manual               |

**Arranque.** Nada de código antes del OK del dueño sobre el plan.

**Durante.** Milestones en orden estricto; se sacrifica desde el final, nunca del medio. Cada
decisión nueva se numera `D-nnn` en `docs/ARQUITECTURA.md` §0.2. Medir antes de afirmar: conteos
de consultas, tiempos y filas se reportan medidos, no estimados.

**Cierre.** Revisión independiente + QA + suite E2E completa **desde el worktree y con builds de
producción** (con dev builds la máquina local muere por OOM cerca del test 308), reportando
passed/failed/skipped y clasificando cada rojo como producto o infraestructura. Después:
`docs/ARQUITECTURA.md §0.2`, `docs/PROGRESO.md`, `docs/handoff/<sesion>.md`, guion UAT en
`docs/uat/<sesion>.md` cuando toca UI o flujo de negocio, y la rama de trabajo empujada para CI.

Para un spec Playwright suelto usar
`pnpm exec playwright test e2e/tests/<archivo>.spec.ts`. No usar
`pnpm e2e -- <archivo>`: Playwright ignora silenciosamente ese filtro posicional y ejecuta la
suite completa. `--grep` sí funciona por ser una opción.

Después del push de la rama de trabajo, verificar la CI de GitHub Actions antes de declarar la
sesión cerrada. Un merge o push a `main` sigue el punto de control de D-232.

---

## 6. Convenciones de código

- **Identificadores en inglés; UI, comentarios, commits y docs en español.**
- Validación con Zod en los bordes; tipos derivados, no duplicados.
- Nada de estado derivado almacenado cuando puede recalcularse al leer. Si por rendimiento hace
  falta agregar, se hace con consulta agregada y **presupuesto de consultas verificado por
  test**, no con caché silenciosa.
- Los formularios usan `Button` con `pending`/`pendingText` centralizado (hubo doble click de
  usuarios reales).
- Operaciones repetibles llevan `idempotencyKey`; la clave se regenera si cambia el payload.
- Fechas: `operationDate` para retroactividad, separado de `createdAt`.

---

## 7. Negocio, lo mínimo que hay que saber

- Precio: **margen sobre venta**, no markup: `costo ÷ (1 − margen) × 1.18`.
- La verdad interna es el valor **sin** IGV; la UI acepta y muestra precios **con** IGV.
- El kardex siempre en soles; compras en USD exigen TC histórico.
- Reservas por SKU/kg, no por bobina específica.
- Densidad es factor por acabado; `standardDensityFactor` es la merma estándar de 1%.
- `ProductBom` es exclusivo de drywall (D-122). UPVC es compra-reventa.
- Reventa de bobina: se vende entera por su saldo vigente de kardex, valorizada a `avgCostPen`;
  la venta cierra la bobina.
- Las planchas no son stock terminado: se producen desde bobina contra el pedido.
- En importaciones, el importe del Excel manda; la diferencia se absorbe como ajuste de redondeo.
- Colores comerciales, no códigos RAL: distintos RAL del mismo color comercial comparten SKU.

---

## 8. Entornos

| Entorno      | Datos                 | Notas                                                                                                                                                                                                      |
| ------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `production` | **reales**            | Solo comprobantes manuales por ahora; `PSE_ENABLED` sin definir (fail-closed).                                                                                                                             |
| `demo`       | copia de `production` | Entorno de UAT (D-227). Se restablece desde `production` con OK del dueño. Salidas externas apagadas por default: `R2_*`, `PSE_ENABLED`, `JOBS_ENABLED` (declaradas en `turbo.json#globalPassThroughEnv`). |
| `dev`        | sintéticos            | Docker local.                                                                                                                                                                                              |
| `ci`         | efímeros              | E2E contra Postgres de servicio en el runner; Neon `ci` solo para migraciones + smoke.                                                                                                                     |

Deuda de entorno conocida: drift de schema en `production` (defaults de `operation_date` en 5
tablas, 5 FK recreadas, 2 índices y un renombre) — `migrate diff` debe seguir coincidiendo
exacto en cada ventana.

---

## 9. Dónde vive la configuración de cada agente

| Archivo                           | Lo lee                  | Para qué                                        |
| --------------------------------- | ----------------------- | ----------------------------------------------- |
| `AGENTS.md` (raíz)                | Codex CLI y Antigravity | Reglas canónicas                                |
| `GEMINI.md`                       | Antigravity CLI 1.2.5   | Importa `AGENTS.md`; no contiene reglas propias |
| `.agents/skills/<skill>/SKILL.md` | Codex CLI y Antigravity | Procedimientos ejecutables                      |
| `.agents/rules/00-ayr.md`         | Antigravity IDE         | Puntero a `AGENTS.md`, sin duplicar contenido   |
| `.githooks/pre-push`              | git (todos)             | Bloqueo de pushes a `main` sin OK del dueño     |
| `docs/agentes/README.md`          | Personas y agentes      | Instalación, invocación y perfiles sugeridos    |

Perfiles sugeridos en `~/.codex/config.toml`: uno de grind (effort medio), uno de
diseño/diagnóstico (effort alto) y uno de solo lectura para revisión.

---

## 10. Qué NO hacer, resumido

- No empujar ni mergear a `main` sin el resumen y OK explícito de D-232; no usar `gh repo sync`
  ni borrar ramas protegidas.
- No tocar 4000/4001.
- No correr SQL contra prod ni imprimir credenciales.
- No inventar alcance ni "aprovechar y de paso arreglar" fuera del milestone.
- No importar historia pre-día-D.
- No firmar la propia revisión.
- No dejar procesos colgados ni worktrees huérfanos al cerrar.
- No afirmar que algo está verde sin la corrida que lo demuestre.
