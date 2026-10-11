# Revisión segundo modelo, cc46 corte C (49e85067..f41180d7)

Alcance: scripts/check-drift-objetos.mjs, scripts/check-drift-objetos.test.mjs, package.json. Solo lectura por SHA; no se ejecutó nada.

## Resumen

La estructura es sana: producción solo se lee por catálogo dentro de una transacción READ ONLY, la URL no va por argv ni se imprime, y el contenedor se borra en `finally`. El hallazgo serio es de cobertura: un trigger deshabilitado a mano en producción pasa sin diferencia. La normalización también es demasiado laxa y puede ocultar cambios reales. No hay P0.

## P1

1. check-drift-objetos.mjs:40-45 (consulta `trigger`). `pg_get_triggerdef` no incluye el estado de habilitación (`pg_trigger.tgenabled`: O/D/R/A). Si alguien hace `ALTER TABLE ... DISABLE TRIGGER` en producción (los triggers del kardex y de color de bobina son la protección principal), la definición es idéntica y la herramienta informa «ok». Es el drift más peligroso para el que se creó la herramienta. Corrección: añadir `t.tgenabled` a la def (p. ej. `pg_get_triggerdef(t.oid) || ' /*enabled=' || t.tgenabled || '*/'`). Igual con `indisvalid` en índices (un índice INVALID tras un CREATE INDEX CONCURRENTLY fallido sale con el mismo indexdef).

## P2

2. :67-70 `normalizeDef` quita todas las comillas dobles, pasa todo a minúsculas y colapsa espacios también dentro de literales. Falsos negativos: `CHECK (status = 'ACTIVE')` contra `'active'`, cambio de mayúsculas en un literal o en el cuerpo de una función, y `"Foo"` contra `foo` (identificadores distintos). La salida de `pg_get_*def` es determinista entre dos Postgres de la misma mayor, así que casi no hace falta normalizar. Corrección: solo `\r\n`→`\n`, trim y colapso de espacios; no minúsculas ni quitar comillas. Los tests (:27-33) fijan hoy ese comportamiento y deben cambiarse.
3. :30-31 `NOT_FROM_EXTENSION` filtra por `d.objid` sin `d.classid`. Los OID pueden coincidir entre catálogos; un objeto del negocio puede quedar excluido por colisión con un objeto de otra clase que sí es de una extensión (raro, pero silencioso). Corrección: añadir `AND d.classid = 'pg_proc'::regclass` (y pg_constraint, pg_trigger, pg_class para índices y vistas), pasando la clase como argumento.
4. :193-204 Espera de arranque frágil. `docker exec pg_isready` usa el socket Unix; durante el init de la imagen oficial responde «accepting connections» con el servidor temporal (sin TCP), por eso se añade un `waitMs(3000)` fijo. En una máquina lenta `migrate deploy` falla con P1001 y, al correr con `quiet: true`, solo se ve «Falló: pnpm exec prisma migrate deploy (código 1)». Corrección: comprobar por TCP (`pg_isready -h 127.0.0.1`; el servidor temporal no escucha TCP) o reintentar una conexión a 127.0.0.1:5441, y quitar el sleep fijo.
5. :129-147 `readCatalog` no fija `maxWait` (2 s por defecto en Prisma para obtener la conexión de la transacción). Con Neon con el cómputo suspendido el arranque en frío puede superarlo (P2028). Corrección: `{ maxWait: 30_000, timeout: 120_000 }`.

## P3

6. :132 No se verifica que la transacción quede READ ONLY. Corrección: tras el `SET`, leer `SHOW transaction_read_only` y abortar si no es `on`.
7. :192-214 `finally` no cubre SIGINT/SIGTERM; el contenedor queda hasta la siguiente corrida (el `rm -f` inicial lo cubre). El nombre y puerto fijos hacen que dos sesiones en paralelo se pisen (patrón ya visto con las bases de E2E). Corrección: manejador de SIGINT que borre el contenedor.
8. :206-210 Con `quiet: true` se pierde la causa del fallo de `migrate deploy` (una migración que no aplica sobre base vacía es un hallazgo útil). Corrección: mostrar las últimas líneas de stderr (la URL de referencia es local y sin secretos).
9. :35-39 Las CHECK de dominio tienen `conrelid = 0`; la clave sale `constraint -.nombre` y dos dominios con el mismo nombre de constraint colisionan. `indexCatalog` (:78-84) sobrescribe claves duplicadas en silencio (solo los conteos lo delatarían). Corrección: detectar duplicados y fallar o calificar con `contypid::regtype`.
10. `regclass::text` y `pg_get_*def` dependen del `search_path` de la sesión. Hoy ambos lados usan public; si el rol de producción tuviera otro habría falsos positivos masivos. Corrección: `SET LOCAL search_path = public` en la transacción de lectura.
11. Cobertura no declarada: vistas materializadas (`pg_views` no las lista), reglas, políticas RLS, enums/dominios, defaults de columna, triggers de evento, permisos y owner. El encabezado debería decirlo para que «ok» no se lea como «sin drift de objetos».
12. :241 `--out` sin valor → `resolve(cwd, undefined)` lanza TypeError tras imprimir el informe. Un error de ejecución y un drift terminan los dos en código 1; conviene distinguirlos (p. ej. 2 para error).
13. Tests: solo cubren funciones puras. No hay prueba de claves duplicadas, de sobrecargas (`f(integer)` contra `f(text)`), de cambio solo de estado del trigger, ni de la limpieza del contenedor ante fallo (se puede inyectar un `run` falso). La prueba de las consultas (:68-74) es una regex sensible a mayúsculas (`delete` en minúsculas no se detecta) y comprueba texto, no comportamiento. `test:scripts` sí recoge el archivo (`scripts/*.test.mjs`).

## Verificado sin hallazgos

- Credenciales: `neonConnectionString` usa `run(..., quiet: true)`; la URL de producción solo viaja en memoria hacia Prisma (`datasources`), nunca por argv ni en el informe ni en el JSON de `--out`. `run` filtra argumentos con secret/password/token en sus errores. La URL de referencia es local, sin contraseña (trust) y publicada solo en 127.0.0.1.
- Producción: las cinco consultas son SELECT sobre catálogo; no tocan tablas del negocio; todo va en una transacción con `SET TRANSACTION READ ONLY` antes de cualquier consulta; conexión directa (no pooled), compatible con SET.
- Filtros: `contype IN ('c','x')` excluye los NOT NULL que PG18 guarda como 'n'; `tgisinternal` excluye los triggers de FK; `prokind IN ('f','p')` evita el fallo de `pg_get_functiondef` en agregados; la firma en la clave resuelve sobrecargas de funciones; la consulta de vistas une por nombre y esquema.
- Versión: la mayor de producción se lee primero y define la imagen; hay doble comprobación de igualdad.
- Limpieza: `docker rm -f` previo y en `finally` (también si falla `migrate deploy` o la lectura); `--rm` como red; si `docker run` falla antes del `try` no queda contenedor.
- Windows: `run` pasa por `cmd.exe /d /s /c` con comillado; los argumentos de `docker run` no tienen caracteres especiales. `Atomics.wait` está permitido en el hilo principal de Node. El guardia `import.meta.url === pathToFileURL(argv[1])` funciona en Windows y evita ejecutar `main` al importar en tests.
- Solo informe: no escribe en ninguna base ni genera migraciones; no está en la CI.
