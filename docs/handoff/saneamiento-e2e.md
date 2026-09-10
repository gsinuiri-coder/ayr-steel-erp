# Handoff — Saneamiento E2E y deudas técnicas — 2026-09-10

## 1. Resumen

**`pnpm e2e` da verde pleno**: de **26 fallados** al empezar el día a **0**, en 234 casos. La
suite deja de depender de recursos externos, la base de pruebas deja de envejecer, y el badge
del padrón y el diálogo de cierre de bobina dejan de ser intestables.

`pnpm turbo lint typecheck test` en verde (**399/399** unitarios). Entorno **LOCAL** en toda la
sesión: **nada desplegado y sin push**. El commit de la ventana de deploy (`207bdf9`) sigue
pendiente y sale junto con estos.

**La mejora de velocidad de M1 no se pudo medir** — ver §4.

---

## 2. Hecho

### M0 — la corrida por defecto no depende de nada externo

| pieza             | qué                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Split `@pse`      | 12 casos que necesitan cupo de Nubefact, fuera de la corrida por defecto; `pnpm e2e:pse` los corre aparte |
| Causa del 409     | `reset-test-db.ts` pasa de 9 tablas escritas a mano a **45 enumeradas de `information_schema`**           |
| Stub del padrón   | `e2e/padron-stub.mjs` en `:3002`, vía `APIS_NET_PE_BASE_URL` (nueva)                                      |
| E2E badge padrón  | los dos lados —existe / no existe— en el mismo archivo y la misma corrida                                 |
| E2E diálogo D-164 | merma anormal y sobrante, por pantalla, con el `CLOSE_ADJUSTMENT` en el kardex                            |

**La lista de `@pse` salió de correr, no de leer**: se ejecutaron los tres archivos y se tomó a
los que fallan con «No puedes enviar mas de 50 documentos en en una cuenta DEMO».

Dos decisiones que valen más que el cambio:

- **El opt-in va por entorno y no por bandera.** Un `--grep` de la línea de comandos pisa a
  `grep` pero **no** a `grepInvert`: con bandera, `e2e:pse` habría corrido cero casos.
- **No se amplió `probePse`**, que era la alternativa obvia. La sonda ya saltea cuando no hay
  PSE atado o falta el RUC del receptor —_en este entorno no se puede llegar a una aceptación_—,
  pero enseñarle «…y tampoco si el servidor contestó que no hay cupo» sería saltear casos según
  **la respuesta que dio el servidor**, y esa misma condición taparía una regresión que hiciera
  fallar la emisión por cualquier otro motivo.

**El badge del padrón era intestable por una razón real**: la consulta sale del **API**, no del
navegador (D-158), así que `page.route()` nunca la veía.

### Lo que el reset destapó, que es la mitad del valor de la sesión

La primera corrida completa dio **10 rojos, y los diez eran del cambio**. La migración de la
Fase 5b sembraba **tres** datos iniciales —el cliente «público en general» (D-077), las cinco
series fiscales (D-072) y la fila de `invoicing_settings` (D-073)— y una migración corre **una
vez**: al vaciarlas, nada las repuso.

El síntoma no se parecía a la causa: «No hay una serie activa para emitir FACTURA» en diez casos
repartidos por cinco archivos que no hablan de series.

Los tres se mudaron al **seed**. **La regla, para lo que venga: un dato inicial que inserta una
migración tiene que estar también en el seed**, o desaparece en el primer reset y reaparece como
un fallo lejos de su causa. Queda escrita en `seed.ts`.

### M3 — selector de cliente, y el umbral a 20

El desplegable sin búsqueda de la cotización pasa a `SearchSelectField` (D-156), y el umbral
bajó de 50 a **20** por decisión del dueño tomada con el dato delante: producción tiene **49
clientes activos**, así que con 50 el vendedor quedaba a un cliente de distancia del buscador.

**M2 quedó fuera de la sesión**, por decisión del dueño.

---

## 3. Lo que la revisión encontró, y era real

Tres hallazgos de peso, los tres corregidos:

1. **El upsert del cliente genérico podía romper facturación en producción.** `update: { isSystem: true }` corre en **cada** `pnpm db:prod`. Si producción llega a tener un cliente real con DNI `00000000` —el relleno exacto de una importación sin documento— quedaba marcado como sistema: inmutable, y **el mostrador lo resolvería como «público en general»**, con sus boletas saliendo sin identificar al receptor. Ahora la marca solo se fuerza si el nombre coincide; si no, avisa y no toca nada.
2. **Le agrandé el radio de daño al reset sin agrandarle el guardrail.** De 9 tablas a 45, con la misma **lista negra** de antes — que dejaba pasar la rama Neon `dev`, justo lo que `apps/api/.env` apunta tras `pnpm env:local`. Ahora es **lista blanca**: Docker local o Neon `ci`, nada más. Una lista negra hay que acordarse de ampliarla; una lista blanca falla sola ante lo que no reconoce, que es el lado correcto para fallar cuando la operación es irreversible.
3. **M3 dejó una regresión visual en la pantalla que venía a mejorar.** El `<Label htmlFor>` apuntaba a un id que dejó de existir y el campo heredó un ancho fijo que truncaba el nombre. `SearchSelectField` acepta ahora `id` y `className`.

---

## 4. La medición de M1, y por qué el resultado es «no se pudo medir»

Perfil real de la suite: **no hay punto caliente**. El archivo más pesado es el 6.3 % del total,
el caso más caro 51.7 s, y **128 casos de 10–30 s se llevan el 71 %** del tiempo.

**Dos de las tres recomendaciones del informe del investigador no se sostienen**, y se
descartaron con números:

- **`storageState` para el login («ALTA, 10-15 min»)**: son **15 llamadas en 6 archivos**, no
  «198 tests» — el resto usa `adminApi()`, que es un POST. Techo real ≈ 1 minuto.
- **Los `setTimeout` fijos**: son polls de SUNAT (asíncrono de verdad) y viven en los dos tests
  que quedan saltados. Ahorro: cero.

El informe se escribió leyendo el código sin correrlo, y ahí está su error: estimó el login por
cuántos specs mencionan la palabra, no por cuántas veces se llama.

Lo que sí se hizo —`Promise.all` en las altas independientes de los tres helpers de setup, que
se montan **94 veces** entre todos los specs, y `purgeInvoicingTrail` leyendo en paralelo— es
correcto y no se deshace. Pero:

> **Cuatro corridas completas dieron 49.5 · 47.3 · 45.7 · 49.7 min** de suma de duraciones. El
> desvío entre corridas del **mismo** código es de ±4 minutos: **más grande que el efecto
> buscado.** Durante la sesión llegué a reportar «≈5 min, 9 %» comparando dos corridas sueltas;
> eso era leer ruido como señal, y queda corregido.

**La palanca grande sería paralelizar workers**, y ahí sí hay minutos de verdad. No se tocó: los
233 casos comparten una base y muchos dependen de saldos, correlativos y reservas globales.

---

## 5. Bloqueos y pendientes

### Necesita acción tuya

- **⛔ Rotar `neondb_owner`** — sigue pendiente de la ventana del 2026-09-10 (incidente de las
  11:54 UTC). Es lo más urgente de todo y no depende de nada más.
- **Vaciar los comprobantes de la cuenta demo del PSE.** Ya no ensucia la corrida, pero mientras
  esté llena **esos 12 casos no se están corriendo**, y son los del ciclo fiscal completo hasta
  la aceptación. Vaciarla y correr `pnpm e2e:pse`.
- **Verificar el web** de la ventana anterior en el navegador, si no se hizo.

### Anotado, no hecho

- **El tope de 200 del selector de clientes** sigue vivo: el umbral en 20 da buscador, no levanta
  el tope. Levantarlo es **buscar del lado del servidor** (`/customers` ya acepta `search`).
- **El selector de producto del formulario de ventas** sigue siendo un `Select` plano con 174
  productos — el mismo callejón que M3 cerró para clientes. Lo encontró la revisión.
- **Paralelizar workers de Playwright**, con su riesgo escrito arriba.
- **M2 (rangos dimensionales)**, fuera de esta sesión. Ojo con lo que se midió antes de
  descartarlo: en Drywall `width_mm` es el **ancho de la pieza terminada** (30–90 mm) y en
  Metallic Roofing el **ancho de la bobina** (1220 mm). Un rango único por columna es incorrecto
  por construcción; tienen que ser **por línea de negocio**.
- **El stub del padrón no distingue «está caído» de «no existe»**, así que la rama de
  `resolvePadronRefs` que aborta el archivo cuando el padrón responde en el preview y falla al
  confirmar sigue sin poder probarse. Haría falta un control en el stub.
- **`fase1` dio un flake** en el cambio de contraseña obligatorio (pasa al reintentar). Es la
  segunda vez que esa zona da un rojo que no lo es.

---

## 6. Cómo verificar

```bash
pnpm turbo lint typecheck test          # verde (399 unitarios)
pnpm exec eslint e2e
pnpm format:check

pnpm e2e        # 234 pasados, 0 fallados, 2 saltados (~50 min, ±4 entre corridas)
pnpm e2e:pse    # los 12 del PSE — antes hay que vaciar la cuenta demo de Nubefact
```

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126).

---

## 7. Siguiente sesión

1. **Rotar `neondb_owner`** y redesplegar el API. Primero y sin depender de nada.
2. **Vaciar el cupo del PSE demo** y correr `pnpm e2e:pse` hasta verde.
3. **Empujar** los cuatro commits pendientes (`207bdf9` + los de esta sesión) y confirmar CI.
4. **M2 — rangos dimensionales**, con la advertencia del ancho de Drywall arriba y midiendo
   producción antes de proponer.
5. **Fase 8 — auditoría, reportes y UAT**, según `docs/ARQUITECTURA.md` §3.7.
