# cc59 — revisión de segundo modelo (límite de login por IP firmada)

Alcance: `git diff origin/main...HEAD` (un commit, 6bbf8c5d). Lectura estática de código y specs; no se corrieron db-specs. Es un modelo, no una persona: no cierra la revisión (AGENTS.md §2).

Veredicto: sin P0. Dos P1 (elusión del límite por mayúsculas o barra final en la ruta; regex de versión en deploy-api), tres P2 y varios P3.

## P1

### P1-1. El límite por IP se elude llamando `/api/Auth/login` (otras mayúsculas o barra final)

- `apps/web/src/lib/client-ip-signature.ts` (`path !== 'auth/login'`) y `apps/web/src/app/api/[...path]/route.ts` (`path.join('/')` y destino `API_URL/<path>`).
- Escenario: la web firma solo si `path.join('/') === 'auth/login'`, comparación exacta y sensible a mayúsculas. El proxy reenvía la ruta tal cual. Express/Nest enrutan sin distinguir mayúsculas ni barra final (`main.ts` no activa `caseSensitive` ni `strict`). Entonces `POST /api/Auth/Login` (o `/api/auth/login/`) llega al controlador de login con las tres cabeceras borradas: el API ve `absent`, no cuenta ni aplica el límite por IP. El atacante hace password spraying sin tope por IP, justo lo que la pieza quería cerrar; solo queda el throttler por correo. El spec web solo prueba `customers` y `auth/login`.
- Arreglo: no decidir por la ruta. Firmar en toda petición cuando haya secreto e IP (el API solo lee las cabeceras en el login y el HMAC cuesta microsegundos). Si se prefiere acotar, normalizar con `toLowerCase()` y quitar barras finales antes de comparar. Sumar al spec los casos `Auth/login`, `auth/login/` y `AUTH/LOGIN`. Conviene comprobar a mano contra el API real que esas variantes enrutan al login.

### P1-2. `deploy-api.mjs`: la regex `/^[1-9]d*$/` rechaza versiones de secreto >= 10 (preexistente, pero la rotación de esta pieza la vuelve operativa)

- `scripts/deploy-api.mjs` líneas 45, 64 y 210. Falta la barra: es `d*`, no `\d*` (confirmado byte a byte). `"1"`…`"9"` pasan; `"10"` no (el `0` no es la letra `d`).
- Escenario: cada rotación con `client-ip-secret.mjs` agrega una versión. En la décima versión de cualquier secreto de `SECRET_NAMES` el deploy falla con «No se pudo resolver la versión habilitada», y `SECRET_VERSION_<N>=10` tampoco se acepta. Con el deploy bloqueado no se puede sacar un hotfix sin editar el script. Hoy no rompe el primer deploy (la versión es 1).
- Arreglo: `/^[1-9]\d*$/` en las tres líneas.

## P2

### P2-1. IP compartida (oficina/NAT): 20 fallos de cualquiera bloquean a todos 15 min, incluida la contraseña correcta

- `auth.service.ts`, bloque `ipKey` al inicio de `login`: el conteo va antes de verificar la contraseña y el 429 sale antes de leer el usuario (el test lo afirma). La ventana es deslizante y un acierto no reinicia. Con una sola salida a internet, 20 fallos acumulados de varios colegas dejan a toda la oficina sin entrar, admins incluidos; un atacante en la misma red (Wi-Fi de visitas) hace DoS dirigido con 20 intentos cada 15 min. Desde otra IP no hay efecto: un atacante externo solo se bloquea a sí mismo.
- Es política (D-693), no bug de código. Debe ratificarla el dueño con esta consecuencia. Mitigaciones: subir el tope para IP compartida; no contar los fallos de un correo cuyo último login correcto vino de esa misma IP; documentar cómo se levanta (hoy solo esperar: `audit_log` es append-only y no hay botón).

### P2-2. IPv6: se cuenta por dirección /128

- `client-ip.ts` (`isIP`) y `loginIpKey`. Quien tiene un /64 rota direcciones y obtiene un contador nuevo por intento. Arreglo: para IPv6 normalizar a /64 al firmar o al hashear; normalizar también la forma (minúsculas, `::ffff:a.b.c.d` -> IPv4) para que una misma conexión no tenga dos claves.

### P2-3. Conteo y registro no atómicos, y falla abierta

- `auth.service.ts`: `count` -> `argon2.verify` -> `audit.log`. Intentos concurrentes leen el mismo conteo y pasan todos: el tope de 20 es blando bajo ráfaga paralela (acotado por el throttler por correo y la latencia de argon2, no duro). `audit.log` traga los errores (`audit.service.ts`), así que si la escritura falla el límite cae abierto en silencio. Coherente con D-219 (registro informativo fuera de transacción; el contador del invariante sube a 6, razonable), pero hay que documentar que es de mejor esfuerzo.

## P3

- P3-1. Confianza en cabeceras de Vercel. No lo pude verificar contra el entorno. (a) Confirmar que `v2.mareliac.pe` apunta directo a Vercel y no detrás de otro CDN/proxy: detrás de Cloudflare `x-real-ip` sería la IP del CDN, todos compartirían contador y P2-1 se agrava. (b) El fallback a `x-forwarded-for` (`clientIpOf`) es falseable si el despliegue deja de ser Vercel (`next start`, local): el navegador elige su IP y se firma. Considerar condicionarlo a `process.env.VERCEL`. UAT sugerido: dos fallos desde dos redes y comprobar dos claves distintas en `audit_log`.
- P3-2. Repetición dentro de 60 s: no explotable (solo reutiliza la IP del propio atacante; no puede obtener firmas de otras). La firma no liga método/ruta/cuerpo: sin impacto porque solo el login la lee.
- P3-3. Tiempo constante correcto (`timingSafeEqual` tras igualar longitudes; solo se filtra la longitud, que es pública). `one()` toma la primera cabecera si vienen duplicadas; seguro. `Headers.delete` es insensible a mayúsculas, así que el borrado de las tres cabeceras del navegador es correcto.
- P3-4. `isIP` de Node acepta IPv6 con zona (`fe80::1%eth0`); inocuo, sin prueba.
- P3-5. `audit_log` crece con una fila `auth.login.failed.ip` por cada fallo con IP verificada (se duplica el ritmo de filas de fallos). El índice `(entity, entity_id, at)` existe, así que el `count` es barato, y el volumen lo acota el propio límite. No hay purga (append-only). Aceptable.
- P3-6. Visor de auditoría: `login_ip` no está en `audit-entity-refs.ts`, así que `entityDisplay` muestra el hash de 43 caracteres como código de entidad, con actor nulo. No expone la IP (hash con secreto) pero es ruido; añadir un rótulo o filtrarlo del listado por defecto.
- P3-7. Esquema: `min(32)` frente a los 43 caracteres generados, cumple. La web no valida la longitud de `AYR_CLIENT_IP_SECRET`; un secreto distinto entre web y API solo se nota como `bad-signature` en el log.
- P3-8. Rotación: bien razonada (mientras difieran, el API ignora la IP y queda el límite por correo; los contadores se reinician porque cambia `loginIpKey`). Efecto: rotar vacía el límite por IP, y cada login en el intervalo deja un `warn` `bad-signature`. En `preview` de Vercel la variable existe pero el API de producción tiene otro entorno: todo cae a ese caso, aceptable.
- P3-9. `scripts/client-ip-secret.mjs` no imprime el valor en ningún camino: stdin a gcloud con `quiet: true` (y el filtro de `secret|password|token` de `run`), JSON al API de Vercel, errores solo con código de estado y `error.code`. Menores: (a) si Secret Manager se actualiza y Vercel falla quedan los dos lados desalineados; avisarlo en el `throw`; (b) `JSON.parse` del `auth.json` sin `try`: un archivo corrupto lanza un `SyntaxError` que puede citar trozos del contenido (token); envolver y relanzar sin el mensaje original; (c) `upsert=true` al pasar una variable previa no sensible a `sensitive`: confirmar que no la duplica; (d) `add-iam-policy-binding` puede pedir `--condition` en modo no interactivo si el secreto ya tiene condiciones: probarlo.
- P3-10. Registro: los mensajes no llevan IP ni secreto, correcto. `IP del cliente verificada` a nivel `log` en cada login correcto es ruido; bajarlo a `debug`.

## Sobre las pruebas

- `client-ip.spec.ts` y `client-ip-signature.spec.ts` prueban firma, vencimiento, ausencia y el vector común: bien. No cubren variantes de ruta (P1-1), `x-forwarded-for` con varios valores o con espacios, ni cabeceras duplicadas.
- `auth-login-ip.spec.ts` usa un `prisma` simulado: prueba el orden (429 antes de leer el usuario, ventana, un acierto no escribe, sin IP verificada no cuenta), no el uso real del índice ni el conteo entre instancias; eso corresponde a `login-ip.db-spec.ts`, que no corrí. El test de ventana comprueba el argumento `gt` del `count`, no el comportamiento con reloj.
- No hay prueba del controlador (`req.headers` -> `verifyClientIp` -> servicio); el caso «llamada directa con IP declarada y sin firma no cuenta» solo está cubierto en la unidad.

## Acciones antes del deploy

1. Corregir P1-1 (firmar siempre o normalizar la ruta) con su caso en el spec web.
2. Corregir la regex de P1-2.
3. Ratificar con el dueño P2-1 (tope y oficina) y anotarlo en la D-693.
4. P2-2 (IPv6 /64) recomendable; el resto, a criterio.

## Respuesta del autor (cc59)

- **P1-1 (la ruta exacta se esquiva con mayúsculas o barra final): corregido.** La web firma la IP en
  **toda** petición cuando hay secreto, sin elegir por ruta. El API solo la usa en el login.
- **P1-2 (regex de versiones de `deploy-api.mjs`): corregido.** Era `/^[1-9]\d*$/` sin la barra
  (una versión 10 o mayor no pasaba). Ya existía; con la rotación se volvía operativo.
- **P2 (IP compartida de oficina, cuenta antes de la contraseña):** es la política del brief (D-693) y
  se le marca al dueño para ratificar.
- **P2 (IPv6 por /128): corregido.** IPv6 se cuenta por su /64 (`ipBucket`), y la IPv4 mapeada como
  IPv4.
- **P2 (conteo no atómico):** se acepta. El tope es blando ante ráfagas en paralelo; el límite por
  correo sigue por delante.
- **P3:** «IP verificada» pasa a `debug`. El visor de auditoría muestra el hash como código: se anota.
  El script no imprime el valor ni el token; si falla Vercel después de Secret Manager, se vuelve a
  correr y los dos quedan con el mismo valor nuevo.
