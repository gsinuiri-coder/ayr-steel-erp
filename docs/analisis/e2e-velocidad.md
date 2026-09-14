# Análisis de Velocidad de Suite E2E

> **Estimaciones por lectura de código, sin medir** — ver
> [`f8-r1-rendimiento.md`](f8-r1-rendimiento.md) y D-201 para lo medido. Ideas vigentes para el
> backlog de reducir consultas por test: `storageState` en login, seeds en `beforeAll`.

## 1. Top 5 Specs más lentos (Medición / Estimación)

Basado en el análisis de tiempos de timeout (`test.setTimeout`), cantidad de tests y carga de datos dentro del código, los 5 specs más lentos y pesados son:

1. **`fase2b.spec.ts`** (~64 KB, 14 tests, timeout de 2.5 min/test).
2. **`fase4-bordes.spec.ts`** (~45 KB, 11 tests, timeout de 4.0 min/test).
3. **`fase5a-bordes.spec.ts`** (~50 KB, ~15 tests).
4. **`fase4.spec.ts`** (~23 KB, timeout de 3.0 min/test).
5. **`fase3.spec.ts`** (~34 KB, timeout de 2.5 min/test).

_(Nota: En ejecución secuencial `fullyParallel: false` con 1 worker, estos archivos toman la mayor parte del tiempo total)._

## 2. Causas identificadas por Spec / Patrón

### A. Seeds repetidos por test

- **Dónde ocurre:** `fase2b.spec.ts`, `fase2a.spec.ts`, `fase3.spec.ts`, entre otros.
- **Detalle:** Se invocan helpers como `createSupplier`, `createFinish`, y `createUser` _dentro_ de la función de cada test individual, en vez de aprovechar `test.beforeAll`.
- **Impacto:** Si un spec tiene 14 tests, inserta 14 veces la misma data estática que podría compartirse, sumando cientos de queries innecesarias.

### B. Arranque de app / Login reiterado

- **Dónde ocurre:** Prácticamente en toda la suite (`fase1.spec.ts`, `fase2b.spec.ts`, `fase7c.spec.ts`, etc.).
- **Detalle:** Cada test invoca `loginAndSetPassword(page, ...)` para autenticar al usuario manejando la interfaz de Next.js de forma manual.
- **Impacto:** La carga de la página de login, tipeo y redirección consume entre 2-5 segundos puros por test. En 198 tests, esto acumula **más de 10 minutos** solo iniciando sesión.

### C. Serialización innecesaria (bucles secuenciales)

- **Dónde ocurre:** Archivos de helpers como `e2e/helpers/invoicing.ts` (línea 915) y en scripts de test como `fase7b.spec.ts`.
- **Detalle:** Bucles del tipo `for (const x of items) { await hacerAlgo(x); }` para operaciones de limpieza, reversas o validación en lote.
- **Impacto:** Las peticiones a la API o DB ocurren de 1 en 1, incrementando el tiempo linealmente, en vez de mandarse en paralelo con `Promise.all()`.

### D. Waits fijos

- **Dónde ocurre:** `fase7b.spec.ts` (ej: `await new Promise(resolve => setTimeout(resolve, 5_000));`).
- **Detalle:** Tiempos de espera determinísticos en vez de esperas por eventos de aserción (`waitForResponse` o `expect(loc).toBeVisible()`).
- **Impacto:** Fuerza un retraso incondicional de 5 segundos, incluso si la UI o red completaron la acción en 0.5s.

## 3. Plan Priorizado para Futura Sesión

| Prioridad | Mejora Propuesta                                                                                                                             | Ganancia Estimada                                       | Riesgo                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| **1**     | **Implementar `storageState` de Playwright para Login** <br> (Autenticar por API una sola vez y usar estado guardado para inyectar cookies). | **ALTA** (ahorraría ~10-15 min del total global)        | **BAJO** (no altera flujo de la app)                         |
| **2**     | **Refactor de Seeds a `test.beforeAll`** <br> (Crear proveedores, usuarios, materiales estáticos 1 vez por bloque y limpiar al final).       | **ALTA** (reduciría el overhead por test drásticamente) | **MEDIO** (puede causar fuga de estado si no se limpia bien) |
| **3**     | **Paralelizar Bucles con `Promise.all` en Helpers** <br> (Modificar `invoicing.ts`, `production.ts`, etc.).                                  | **MEDIA** (mejora tiempos de setup y teardown)          | **BAJO**                                                     |
| **4**     | **Sustituir `setTimeout` Fijos por assertions dinámicos** <br> (En `fase7b.spec.ts` y similares).                                            | **BAJA/MEDIA**                                          | **BAJO**                                                     |
