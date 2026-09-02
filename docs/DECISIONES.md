# Decisiones de arquitectura (formato largo)

> Espejo de `ARQUITECTURA.md` §0.2. Aquí solo van las decisiones que necesitan contexto adicional (alternativas evaluadas, consecuencias). La tabla corta de §0.2 sigue siendo la fuente de verdad del listado.

## D-015 — El web consume el API por rewrite same-origin (`/api/*`)

**Fecha:** 2026-09-02

**Contexto.** D-010 fija cookies httpOnly para access/refresh. Web (Vercel) y API (Cloud Run) viven en dominios distintos. Cookies de terceros con `SameSite=None` dependen del navegador y Safari/Chrome las restringen cada vez más; además obligan a CORS con credenciales en cada request.

**Decisión.** `apps/web/next.config.ts` define `rewrites: /api/:path* → ${API_URL}/:path*`. El navegador solo habla con su propio origen; Next reenvía al API y pasa las cabeceras `Set-Cookie` de vuelta. Las cookies del API no fijan `domain` y usan `SameSite=Lax`. El API igual habilita CORS para `WEB_ORIGIN` (útil para herramientas y para llamar directo en desarrollo).

**Consecuencias.** Un salto extra por request (Vercel → Cloud Run). Server Components de Next llaman al API directo por `API_URL` reenviando la cookie de la petición entrante. Playwright local usa la misma ruta `/api/*`.

## D-016 — Rama de producción de Neon se llama `production`

**Fecha:** 2026-09-02

D-005 decía `main`. El proyecto Neon ya venía creado con la rama por defecto `production`; renombrarla no aporta nada y cambiar la rama por defecto es una operación manual. Se mantiene `production` como prod y se documenta. `dev` y `ci` cuelgan de `production`.

## D-017 — Versiones fijadas en Fase 0

**Fecha:** 2026-09-02

NestJS 11.2 (existe 12 pero el alcance pide 11), Next 15.5 (existe 16), Prisma 6.19 (7 cambia a `prisma.config.ts` + driver adapters; se migrará cuando haya un motivo), TypeScript 5.9 (7 es el port a Go y no todo el tooling lo soporta), ESLint 9 flat config, Zod 3.25 (API v3; `zod/v4` disponible en el mismo paquete), Jest 29 con ts-jest (encaja con el template de NestJS; Vitest queda para el web si algún día hace falta). Versiones exactas, sin `^`, para que dos instalaciones den lo mismo.
