# Ventana cc43 — E2E en 2 shards, ratificación de D-592..D-595 y demo apagada

2026-10-10, sesión atendida. Ventana suspendida (D-533). Sin migraciones, sin SQL contra
producción, sin deploy: no cambia el runtime. D-592 a D-595 ratificadas por el dueño; D-596 nueva,
ratificada por el dueño al cierre.

## CI nueva (D-596)

| Job                                          | Qué corre                                                                        | Límite |
| -------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| `base` — Drift y kardex contra la base       | `check:drift` (una sola vez) y `test:db`, con su Postgres                        | 20 min |
| `e2e-shard` — E2E Playwright, shard i/2      | `pnpm e2e --shard=i/2`, matrix 1..2, cada uno con su Postgres, migraciones, seed | 30 min |
| `e2e` — E2E Playwright (Postgres del runner) | Agregado con el nombre de siempre: verde solo si `base` y los dos shards lo son  | 5 min  |
| `smoke-neon`                                 | Sin cambios: corre una vez                                                       | 45 min |

- **Check requerido de `main`:** `main` no tiene protección de rama ni rulesets (la API de GitHub
  da 404 y `[]`), así que ningún PR queda esperando un check viejo. Igual el agregado conserva el
  nombre «E2E Playwright (Postgres del runner)» por si se agrega la protección. Corre con
  `always()`: un shard rojo o cancelado lo deja rojo, nunca «skipped».
- **Reparto:** Playwright reparte archivos enteros (`fullyParallel: false`) por cantidad de tests,
  no por duración. Shard 1: 308 tests en 80 archivos; shard 2: 301 en 85 (609 en 165).
- **Dependencias entre specs:** ninguna encontrada. Los specs crean sus propios datos (números
  fijos solo en comentarios, sin imports entre specs, sin `serial` entre archivos); las dos
  revisiones muestrearon lo mismo y la primera corrida dio verde.
- **Correlativos fiscales:** los dos shards emiten contra la misma cuenta demo de Nubefact.
  `e2e-fiscal-offset.ts` suma la mitad del rango al shard 2 (`E2E_SHARD`); sin la variable, la base
  es la de siempre. Es el único cambio en `apps/` (con un comentario de `jest.db.config.js`):
  herramientas de prueba, fuera del runtime.
  **`git diff --quiet dfbc6bff origin/main -- apps …` va a dar exit 1 por esos dos archivos**; no
  es desalineación de runtime. La próxima pieza que despliegue la API lo vuelve a alinear.

## Duración

| Corrida                            | Shard 1    | Shard 2     | `base`     | Check `e2e` verde a los           |
| ---------------------------------- | ---------- | ----------- | ---------- | --------------------------------- |
| Antes: run 38101351095 (job único) | —          | —           | —          | 34 min 42 s (39 min 11 s en #170) |
| Run 38105190424 (`e00e0905`)       | 10 min 7 s | 15 min 27 s | 8 min 21 s | 15 min 34 s                       |
| Run 38107486823 (`2c5afc12`)       | 12 min 8 s | 16 min 37 s | 8 min 9 s  | 16 min 44 s                       |

Los tests solos: shard 1 8 min 15 s y 9 min 54 s, shard 2 13 min 6 s y 14 min 12 s; `test:db`
7 min 37 s y 7 min 31 s. Ningún shard pasa de 25 min, así que no se rebalanceó ni se subió a 3.
La corrida siguiente, sobre el commit de estas medidas, queda en el PR #171.

**`smoke-neon` puede ser ahora el camino más largo de la CI:** 36 min 56 s en la primera corrida y
11 min 47 s en la segunda (límite 45). Depende de la latencia del runner a Neon (D-201) y quedó
fuera del alcance de cc43.

## Demo

El `pnpm dev:demo` de cc38 (API 3100, web 3101, desde el checkout principal, con código anterior)
se apagó matando su árbol de procesos; 3100/3101 ya no escuchan y la preview del dueño (4000/4001)
siguió arriba. La rama Neon `demo` y sus datos no se tocaron; no tiene la migración de cc41
(D-591): antes de usarla se restablece desde `production` con OK del dueño (D-227). Anotado en
`docs/ENTORNOS.md`.

## Revisión

Autorrevisión y segundo modelo (`docs/revision/cc43-segundo-modelo.md`). Los dos marcaron el mismo
riesgo de correlativos (P1 en el segundo modelo), corregido. Los demás:

- **Referencias viejas a «el job `e2e`»:** corregidas en `ENTORNOS.md`, `drift-schema.md`,
  `jest.db.config.js` y D-593. La entrada histórica de cc42 en `PROGRESO.md` se deja como estaba.
- **`always()` frente a `!cancelled()`:** se queda `always()`. Una corrida reemplazada se ve en
  rojo, pero con `!cancelled()` un shard cancelado a mano dejaría el agregado «skipped».
- **Secretos de más en `base`:** se quedan, el mismo entorno que tenía `test:db` dentro del E2E.
  Quitarlos cambiaría el entorno de los db-spec sin medirlo.
- **Reparto por cantidad de tests:** medido arriba.

## Para la próxima sesión

- D-596 ratificada por el dueño el 2026-10-10.
- El reparto está desparejo (shard 2 tarda unos 5 min más). Si un shard pasa de 25 min, subir la
  matrix a 3: `e2e-fiscal-offset.ts` hoy acepta solo `E2E_SHARD` 1 o 2 y hay que ampliar el paso.
