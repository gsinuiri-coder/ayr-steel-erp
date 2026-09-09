# AYR Steel ERP — reglas operativas del agente

ERP web para una empresa peruana de transformación y venta de acero. Fuente de verdad del dominio y la arquitectura: `docs/ARQUITECTURA.md`. Este archivo solo tiene reglas operativas.

## Documentos (leer antes de programar)

- `docs/ARQUITECTURA.md` — requisitos (RF-nn), decisiones (§0.2, D-nnn), arquitectura (§3), fases (§3.7), preguntas abiertas con recomendación (§5).
- `docs/PROGRESO.md` — estado por fase y bloqueos. Actualizar al cerrar cada punto grande.
- `docs/DECISIONES.md` — contexto largo de decisiones cuando §0.2 no basta.
- `docs/ENTORNOS.md` — production, demo, dev y ci: para qué es cada una y qué se puede correr contra cada una.
- `docs/handoff/` — resúmenes de cierre de sesión (`/handoff <nombre>`).

## Idioma

- Identificadores de código (variables, funciones, columnas, rutas API, archivos) en **inglés**.
- UI, mensajes de error, comentarios, docs y commits en **español**.
- Commits: conventional commits en español. Ej.: `feat(auth): login con email y password`, `fix(users): no permitir desactivarse a sí mismo`.

## Stack (D-002..D-008)

- Monorepo `pnpm` + Turborepo: `apps/api` (NestJS 11, Prisma 6, pg-boss, config por Zod), `apps/web` (Next.js 15 App Router, Tailwind 4, shadcn/ui, TanStack Query, React Hook Form, Zod), `packages/shared` (schemas Zod, enums `Role`/`BusinessLine`, helper `Decimal`).
- DB: Neon Postgres, proyecto `ayr-steel-erp`. Ramas: `production` (prod, **datos reales desde 2026-09-07**), `demo` (ensayos y capacitación), `dev` (local), `ci` (tests, se resetea por corrida). **Nunca borrar ramas de Neon.** Detalle en `docs/ENTORNOS.md`.
- Hosting: API en Cloud Run `us-central1`; web en Vercel. El web llama al API por `/api/*` (rewrite de Next, D-015).
- Auth propia (D-010): argon2id, JWT de acceso corto + refresh en tabla `sessions`, cookies httpOnly.

## Reglas duras

1. **Decimal (D-003)**: dinero, kg y mm NUNCA se operan con `number`. Usar `Decimal`/`money()`/`kg()`/`mm()` de `@ayr/shared`. Columnas `NUMERIC` con escala explícita: dinero 4, kg 3, mm 2. Serializar como string.
2. **Kardex (§3.2)**: todo cambio de stock pasa por el módulo `inventory` como movimiento append-only en `inventory_movements`. Ningún módulo escribe stock directamente. Anular = movimiento inverso, nunca `DELETE`.
3. **Auditoría (RF-95)**: `audit_log` es append-only. Acciones críticas pasan por `AuditService.log`.
4. **Sesiones (RF-03)**: cambiar rol, desactivar o resetear contraseña llama a `AuthService.revokeAllSessions`.
5. **Secretos**: `.env.setup` tiene todas las credenciales. Nunca imprimirlo, nunca commitearlo, nunca copiar valores a código o docs. Los scripts lo leen con `scripts/lib.mjs#readEnvFile`.
   - **Una credencial jamás viaja por `argv`; siempre por el entorno del proceso hijo.** Nada de `--url <cadena de conexión>`, `--password`, `--token`: van en el objeto `env` de `spawnSync` y el comando las lee de ahí. Un argumento es visible en el título del proceso y —lo que de verdad pasó, D-128— **aparece impreso en el mensaje de error cuando el comando falla**.
   - Todo helper que lance un proceso compone su mensaje de error **sin repetir los argumentos**. `scripts/lib.mjs#run` ya filtra `secret|password|token`; un helper local que arme el mensaje con `args.join(' ')` no filtra nada, y esa diferencia fue exactamente el escape.
   - La contraseña del rol `neondb_owner` es **la misma en las cuatro ramas** de Neon: exponer la cadena de `dev` o de `demo` es exponer la de `production`.
6. **Git**: nunca `git push --force`. Commits pequeños por punto de alcance.
7. **Windows**: scripts cross-platform (Node/pnpm), sin bash-isms. `gcloud` se invoca vía `cmd /c gcloud ...` desde Git Bash.
8. **Comandos desde la raíz (D-063)**: nunca prefijar un comando con `cd ... &&`. Correr siempre desde la raíz del repo con rutas relativas (`grep -rn "x" apps/api/src`, no `cd apps/api && grep ...`). Un comando de diagnóstico (`grep`/`rg`/`ls`/`find`/`head`/`tail`/`wc`) **jamás** apunta a `.env*` ni a rutas que puedan expandirse a ellos: la regla dura 5 y el `deny` de `Read(**/.env*)` (D-062) no se esquivan por Bash.
9. **Nunca correr la suite E2E contra producción (D-126).** `pnpm e2e:prod` queda prohibido como rutina desde que producción tiene datos reales: crea compras, bobinas, órdenes y despachos que el kardex append-only no siempre puede deshacer. La verificación post-deploy es `pnpm smoke:prod` (solo lectura). La suite completa vive en local y en CI (rama `ci`). `pnpm prod:purge-e2e` queda solo para emergencias, y cada uso se documenta en `docs/PROGRESO.md`.
10. **Fecha de operación (D-124).** Todo hecho fechado del dominio —movimiento de kardex, bobina, corte, OP, reporte de piezas, despacho, cobranza, pago— lleva `operationDate` (día de negocio en Lima), por defecto hoy y editable solo por ADMINISTRADOR vía `OperationDateService.resolve`. `createdAt`/`at` no se tocan: son auditoría. Todo reporte, listado o agrupado por fecha lee `operationDate`, nunca el timestamp de grabación.
11. Si un comando externo falla 3 veces, documentar el bloqueo en `docs/PROGRESO.md` y seguir con lo que no dependa de él.
12. Dudas de diseño: aplicar la recomendación de `docs/ARQUITECTURA.md` §5 y registrar la decisión en §0.2. Preguntar al dueño solo si un servicio externo exige acción humana.
13. **Datos reales de un cliente/importación** (Excel, CSV, JSON de decisiones — clientes, RUCs, montos): nunca sueltos en la raíz del repo, aunque `.gitignore` los cubra. Viven en `local-data/` (ignorada por completo). Un script de un solo uso (reversa puntual, purge ad hoc) se escribe, corre y borra dentro de la misma sesión; si por algo tiene que sobrevivir a la sesión, va a `scripts/oneoff/` con fecha en el nombre — nunca queda suelto en `apps/api/prisma/` ni en la raíz.
14. **Los subítems de largo los decide la UNIDAD, nunca el subtipo (D-131).** `sellsByLength(product)` —`unit === MTR`— responde _¿esta línea necesita el detalle de largos?_, y vale para cualquier línea de negocio. `isMadeToMeasure(product)` —`roofingKind === A_MEDIDA`— responde _¿se fabrica contra pedido desde materia prima?_, y es exclusiva de Metallic Roofing. **Son dos preguntas distintas y las dos devuelven `boolean`, así que el compilador nunca avisa cuando se responde una con la otra.** Ya pasó dos veces: la primera dejó al mostrador vender material a medida; la segunda dejó pasar sin marca toda línea en `MTR` que no fuera `A_MEDIDA` en el importador de cotizaciones. Ninguna pregunta sobre subítems se responde con el subtipo. El centinela es `apps/api/src/sales/sales-lines.spec.ts`: si alguien define una en términos de la otra, se cae.
15. **Los puertos 4000/4001 son del dueño.** `pnpm dev:preview` levanta api `:4000` + web `:4001` contra `ayr_local` para que el dueño mire la app mientras el agente trabaja. **El agente nunca los usa, nunca los mata y nunca corre nada ahí**: su entorno es `pnpm dev:local` (`:3000`/`:3001`), que es también donde corre Playwright — y una corrida de la suite mata y relevanta esos dos. Antes de matar un proceso por puerto, mirar cuál es: matar el `:4001` del dueño le tira la sesión del navegador sin ningún aviso. `dev:preview` va **siempre** contra `ayr_local`, nunca contra `ayr_local_e2e`, que la suite vacía en cada corrida.

16. **Ningún texto largo pasa por la shell.** Nunca `node -e "..."`, `python -c`, `echo` ni interpolación de shell para escribir contenido de `docs/`, un bloque de código, un mensaje de commit de varias líneas ni nada que lleve adentro backticks, `$`, `!` o comillas. **El texto se escribe en un archivo** (con Write) y lo inserta un script que lo lee de ahí; si de verdad hace falta un heredoc, va con el delimitador **entre comillas simples** (`<<'EOF'`), que es lo único que apaga la expansión.
    - Lo que pasó (sesión Precios, 2026-09-09): un `node -e` con backticks en el texto se lo comió la shell, que **ejecutó lo que había adentro** y disparó un `pnpm e2e` accidental. La suite vacía `ayr_local_e2e` al arrancar, así que **borró la base a mitad de otra corrida que estaba en curso**. El comando falló al instante por un regex inválido y no llegó a correr un solo test, pero la corrida viva se cortó y hubo que relanzarla.
    - Por qué es una regla de forma y no de criterio: el daño no lo hace el comando que uno quiso correr, sino **otro** que la shell arma sola con pedazos del texto. Releer el texto no alcanza, porque hay que darse cuenta de que el texto también es código.

## Comandos

```
pnpm install                 # dependencias
pnpm env:local               # genera apps/api/.env y apps/web/.env.local (Neon rama dev)
pnpm dev                     # api :3000 + web :3001
pnpm build | lint | typecheck | test
pnpm db:migrate              # prisma migrate dev (rama dev)
pnpm db:deploy               # prisma migrate deploy (CI/prod)
pnpm db:seed                 # admin desde ADMIN_EMAIL/ADMIN_PASSWORD
pnpm dev:local                       # Postgres en Docker + migrate + seed + api+web, sin Neon (docs/ENTORNOS.md)
pnpm dev:preview                     # api :4000 + web :4001 contra ayr_local — puertos del DUEÑO (regla dura 15)
pnpm db:local reset|snapshot <n>|restore <n>   # operar el Postgres local (Docker)
pnpm e2e                     # Playwright, por defecto contra el Postgres local (Docker); en CI, Neon rama ci
pnpm env:demo | db:demo | dev:demo   # entorno de ensayo (rama Neon demo, D-125)
pnpm smoke:prod              # verificación post-deploy de SOLO LECTURA (D-126)
pnpm check:price-floor [--branch production|demo|dev|local|local-e2e]      # SKU bajo el piso de D-163, solo lectura
pnpm check:roofing-catalog [--branch production|demo|dev|local|local-e2e]  # coberturas mal cargadas (D-127, D-166), solo lectura
pnpm secrets:gh              # gh secret set desde .env.setup
pnpm deploy:api | deploy:web # Cloud Run / Vercel
pnpm monitors                # UptimeRobot
```

## Subagentes (`.claude/agents/`)

- `revisor`: lee el diff y reporta bugs/smells. No edita.
- `auditor-seguridad`: OWASP, secretos, dependencias. Puede pedir segunda opinión a `agy`.
- `qa`: escribe y ejecuta Playwright bajo `e2e/`.
  Usarlos al terminar cada punto grande; en paralelo cuando no dependan entre sí.

## Protocolo de cierre de sesión

1. `pnpm lint && pnpm typecheck && pnpm test` en verde.
2. Actualizar `docs/PROGRESO.md` (estado, bloqueos).
3. Nuevas decisiones → `docs/ARQUITECTURA.md` §0.2 (y `docs/DECISIONES.md` si necesitan contexto).
4. `/handoff <fase-o-tema>` → `docs/handoff/<nombre>.md`.
5. Commit y push a `main`. Verificar CI verde en GitHub Actions.
