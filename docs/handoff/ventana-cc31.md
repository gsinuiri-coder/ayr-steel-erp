# Ventana cc31 — Mejoras de UX (seis cortes, solo `apps/web`)

## Resumen

- Sesión desatendida del 7 de octubre de 2026, de 02:20 a 07:00 de Lima. El dueño avisó que el
  cliente no usaba la app ese día, así que el merge y el despliegue quedaron abiertos hasta las
  07:00 del jueves 8. Sin API, sin migraciones y sin SQL. Las horas van en Lima, calculadas con
  Node porque Git Bash ignora `TZ`.
- Fuente de verdad:
  - `docs/handoff/ventanas/cc31-ux-especificacion.md`, copia de `local-data/cc31-ux/ESPEC.md`;
  - los tableros de `local-data/cc31-ux/tableros/`, que no se suben al repo.
- Un PR por corte, encadenados. La vuelta atrás es promover el despliegue anterior en Vercel y
  revertir el PR.

| Corte              | PR   | `main`     | Vercel (prod) | Vuelta atrás            | Verificación en producción                                |
| ------------------ | ---- | ---------- | ------------- | ----------------------- | --------------------------------------------------------- |
| 1 Base             | #124 | `5fda071f` | 6907064391    | 6902941524 (`dbfd6d7c`) | ingreso, Panel, /pedidos, /clientes, /bobinas             |
| 2 Marco            | #125 | `bc0d8b38` | 6907692122    | 6907064391              | ingreso, Panel, /pedidos, /comprobantes, tipo de cambio   |
| 3 Detalle y listas | #126 | `2c76fc25` | 6908516921    | 6907692122              | ingreso, Panel, /pedidos, /cotizaciones, /comprobantes    |
| 4 Panel            | #127 | `67ed4ad2` | 6908858577    | 6908516921              | ingreso, Panel, /cotizaciones                             |
| 5 Formularios      | #128 | `08e3bbdb` | 6908933579    | 6908858577              | ingreso, Panel, /despachos/nuevo, /compras/nueva          |
| 6 Cotización       | #129 | —          | —             | —                       | **sin merge**: terminó a las 07:07, después de la ventana |

En los cinco cortes desplegados la consola salió sin errores. La verificación usó un admin efímero
y Playwright contra `https://v2.mareliac.pe`, nunca `e2e:prod`.

## Cómo entró cada corte

- **Cortes 1 a 3:** CI completa en verde: lint, typecheck y unit; E2E en el Postgres del runner;
  smoke Neon ci.
- **Corte 4:** entró con lint, unit y E2E en verde, pero su smoke Neon ci repetido seguía corriendo
  (lo cancelaron dos veces los PR en paralelo, por el grupo `neon-ci-branch`). Lo cubría el smoke
  verde del #128, que contiene todo el código del #127. Se hizo así para entrar antes de las 07:00.
- **Corte 5:** CI completa en verde en `3ffc1dd9`. La integración con `main` tuvo un conflicto en el
  formulario de contraseña, resuelto en `02da3f80` con la versión del corte 5. El árbol quedó
  idéntico al probado (lo confirmó `git diff --quiet`).
- **SonarCloud:** «el análisis falló» del lado del servidor en varios PR. No es un check requerido.
  Lo anoté como infraestructura.

## Decisiones provisionales (D-480..D-501)

Están en `docs/ARQUITECTURA.md` §0.2. Todas son provisionales y esperan la revisión del dueño.
D-496..D-501 son del corte 6 y solo valen si el #129 entra.

## Omisiones por falta de dato del API

- Campana: «bobinas por terminarse» y la antigüedad del comprobante más viejo sin aceptar.
- «Ir a» y la página 404: buscar documentos por código.
- Ambiente demo: el web lo lee de `AYR_ENVIRONMENT` en el servidor de Next.
- Corte 6:
  - «RUC activo · N cotizaciones vigentes»;
  - «Enter en el último largo agrega otro»;
  - «Material que compromete al confirmar» agrupado;
  - los filtros «Todas» y «Bobina completa» del selector;
  - que «Agregar línea» abra el buscador.

## P3 abiertos

- **Corte 1:** `lib/download.ts` sigue diciendo «error 500» en descargas fallidas; el diálogo de
  confirmar mezcla precisiones.
- **Corte 2:**
  - la campana no se invalida al despachar o emitir (hasta 60 s de desfase);
  - el 429 del ingreso pierde la cuenta regresiva al recargar;
  - «sesión vencida» también sale tras una revocación;
  - el ARIA del combobox de «Ir a»;
  - los plurales fijos en los contadores.
- **Corte 6, según las revisiones:**
  - «Lista» se muestra a 2 decimales mientras el precio sembrado tiene 4;
  - la suma de importes por línea puede diferir S/ 0.01 del total redondeado una vez (D-377);
  - el nombre `listPriceWithIgv` está repetido;
  - ↑ en la primera fila del selector no vuelve al buscador.

## Para la siguiente sesión

- **#129 (corte 6):** revisarlo y desplegarlo en una ventana. Las P2 de las dos revisiones están
  corregidas en la rama (ver `docs/revision/cc31-c6-segundo-modelo.md`).
- **Riesgo:** es el corte de mayor riesgo. Las revisiones confirmaron que no cambian el payload, los
  pisos, las validaciones ni el habilitado del botón. Sí agrega tres comportamientos:
  - elegir un producto de otra línea cambia la línea de la fila;
  - «Usar X» rellena el mínimo;
  - el foco pasa a la cantidad.
    Los tres tienen spec propio.
- **UAT de los seis cortes:** en `docs/uat/cc31.md`.
- **Primer ingreso:** «Guardar y entrar» ahora hace una carga completa del Panel. Antes, el cambio de
  marco se comía la navegación y el usuario nuevo quedaba en «Cambiar contraseña». Ese defecto
  estuvo en producción desde el corte 2 hasta el corte 5.
