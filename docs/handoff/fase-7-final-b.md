# Handoff — Sesión 7-final-B: el pedido de un comprobante importado — 2026-09-07

## 1. Resumen

Sesión corta y de una sola idea, la que pediste: **cada comprobante que entra por la
importación de ventas crea un pedido enlazado 1:1**, y un **toggle por documento** en la
previsualización decide si ese pedido es una **cáscara** (la venta ya se entregó, cero
efectos) o uno **vivo** (facturado y no entregado: reserva material y abre la orden en cola).
Una decisión nueva, **D-141**.

`pnpm turbo lint typecheck test build` en verde (266/266 unitarios), `pnpm format:check` y
`pnpm exec eslint e2e` verdes. La migración está aplicada a Neon `dev`. **Nada commiteado**:
falta tu revisión con el Excel real.

**Además, y esto no estaba en el alcance:** correr las suites afectadas destapó **9 fallas de
E2E que venían de la sesión anterior**, no de esta. Están las nueve arregladas (§4).

---

## 2. Hecho

### El toggle, y las dos mitades que abre (D-141)

En `/comprobantes` → **«Importar ventas (Excel)»**, cada comprobante de la previsualización
aparece con su **cabecera propia** y un desplegable de dos opciones
(`apps/web/src/components/imports/import-dialog.tsx`, componente `DocumentHeader`).

**(a) ENTREGADO — el default — pedido cáscara.**
Estado `FULFILLED`, `origin = IMPORTED`, líneas espejo del comprobante, fecha de emisión del
papel. **Cero efectos de inventario.**

- Método propio, `SalesOrdersService.createImportedShellInTx`
  (`apps/api/src/sales/sales-orders.service.ts`): no llama a `resolveSalesLines`, no llama a
  `createReservations`, no encola nada. **El bypass es estructural**, no un `if` dentro del
  camino normal.
- Y aun así se comprueba: `assertNoInventoryEffects` cuenta reservas, órdenes de producción,
  despachos y movimientos de kardex del pedido recién creado y **tira abajo la importación
  entera** si encuentra alguno. Hoy no puede encontrar ninguno; está para el día que alguien
  agregue un hook a la creación de pedidos sin acordarse de esta puerta (mismo criterio que
  D-052).

**(b) PENDIENTE — pedido vivo + OP automática.**
Estado `CONFIRMED`, `origin = IMPORTED`, por el **camino normal** (`createDirectInTx`, que es
el que crea las reservas y comprueba la invariante `disponible ≥ reservado`).

- Línea **a medida** → reserva **genérica** de materia prima por agregado (D-134).
- Línea **de catálogo** → reserva de producto terminado (D-054/D-127).
- Por cada línea a medida, el import **crea la OP en su estado inicial `DRAFT` (en cola)**,
  enlazada a la reserva y **sin bobina montada** — montar es tuyo, en planta (D-086).
  `RoofingProductionService.createFromReservationInTx`, en la **misma** transacción que el
  pedido.

### El enlace bidireccional, sin columna nueva

`fiscal_documents.sales_order_id` ya existía desde la Fase 5b. El documento apunta al pedido,
sus líneas apuntan a las líneas del pedido (así `orderProgress` muestra el pedido importado
facturado al 100 %, que es la verdad), y el detalle del pedido muestra el badge **«Importado»**
con el link al comprobante. El link inverso ya estaba.

### Validación en la previsualización

- **Agregado insuficiente** → la fila se marca con el faltante exacto y el documento **solo
  entra como ENTREGADO**. Lo mismo para una **línea de catálogo sin stock**: no se crea
  ninguna OP a stock automática (D-140), se marca y listo.
- **Dos líneas del mismo comprobante contra el mismo agregado se suman**, y si no alcanzan se
  marcan las dos.
- **Los largos son opcionales.** Ningún export de facturación desglosa las planchas, así que
  hay una columna `LARGOS` (`3.60x4, 5.00x2`): con ella el plan de corte de la OP nace
  completo, sin ella nace vacío y lo completa planta con `updatePlan` antes de rolar (D-084).
  Los kilos prometidos son los mismos en los dos casos.

### Reimportar (D-109 + D-141)

Archiva el documento **y anula su pedido cáscara**. Si ese pedido está **vivo** con reservas,
producción o despachos, **la reimportación del documento se bloquea entera** con el motivo y
el código del pedido — archivarlo habría dejado material prometido y producción en curso sin
nadie que los devuelva. El guardrail vive en `sales` (`archiveImportedOrderInTx`) y corre bajo
el mismo lock del número que ya toma `FiscalImportService`.

### Pulido de la cotización (lo que pediste aparte)

**Los solapes eran uno solo, con una causa única**: las celdas de la tabla son
`whitespace-nowrap` (heredado del componente `Table`, pensado para listados de una línea), así
que los renglones de ayuda de debajo de cada campo —la unidad, el kilo teórico, el precio de
lista, los kilos a reservar— no podían partirse y **se desbordaban pintando encima de la
columna vecina**. Se ve clarísimo en la captura «antes»: `≈27.5600 kg` sobre el precio,
`Lista: S/ 30.0000` sobre `Kg a reservar`.

Corregido en `sales-document-form.tsx` y en `cotizacion-detalle-view.tsx`, sin tocar
estructura, componentes ni lógica:

- `whitespace-normal` en las celdas con texto de ayuda; los renglones pasan a `block` debajo
  del campo. **Los solapes desaparecen en desktop y en mobile.**
- `min-w` en la tabla del formulario: en pantalla angosta ahora **desplaza** (el contenedor ya
  tenía `overflow-x-auto`) en vez de aplastar las columnas hasta que se desbordan.
- Números a la derecha y con `tabular-nums` (cantidad, precio, importe, totales, y las tres
  columnas de plata del detalle), que es la convención que ya usa el resto de la app.
- Totales en una rejilla de dos columnas, con el **Total** destacado; en el detalle, la tarjeta
  «Total (con IGV)» es la única en `text-xl`.
- Anchos rebalanceados (18/22/12/14/18/11/5) y `align-top` para que los campos de una misma
  fila queden a la misma altura.
- El aviso «Se fabrica contra el pedido (RF-31)» pasa de tres renglones a uno: la frase
  completa ya está arriba de la tabla y repetirla por fila hacía que cada línea de coberturas
  midiera cuatro renglones.

Las capturas antes/después (formulario y detalle, desktop y mobile) están en el reporte de
la sesión.

---

## 3. Decisiones tomadas

| ID        | Una línea                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-141** | Cada comprobante importado crea un pedido enlazado 1:1, y un toggle por documento decide si es una cáscara terminal o un pedido vivo con OP. |

Detalle largo en `docs/DECISIONES.md` (por qué el toggle es del documento, por qué el bypass
es estructural y aun así se comprueba, qué se hace con una línea de catálogo sin stock, y qué
frena la reimportación).

---

## 4. Bloqueos y pendientes

### Lo que encontré y no era de esta sesión (importante)

Correr las suites afectadas dejó **9 fallas**. Ninguna es del cambio de hoy: son specs que la
**sesión anterior** dejó desactualizados con su propio trabajo (todo sin commitear, así que CI
no lo había visto todavía). Las nueve están arregladas y verdes:

| Suite                           | Qué pasaba                                                                                                                                                                                                       | Arreglo                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `fase7-consolidada-subtipo` (5) | El spec entero seguía escrito para el modelo **anterior a D-134**: la cotización reservaba `PRODUCT` y el pedido una bobina concreta; un caso además reescribía una **receta de coberturas**, que D-122 eliminó. | Los cinco casos reescritos para el agregado. Dos se reemplazaron por la regla que prueban lo mismo en el modelo nuevo (§ abajo). |
| `fase7c` (2)                    | Desde D-138 hay **dos** botones «Importar…» en `/comprobantes` y el localizador `name: 'Importar'` resolvía a los dos.                                                                                           | Nombre completo: `'Importar planilla'`.                                                                                          |
| `fase6` (1)                     | El mensaje de D-140 cambió al resolverse la decisión («pendiente del dueño» ya no existe).                                                                                                                       | La aserción apunta a la salida real: «producí una orden a stock desde planta».                                                   |
| `fase5a-bordes` (1)             | **Flake, no defecto**: el token de acceso dura 15 min y ese archivo tardó 15.1 en la corrida combinada → 401 a mitad.                                                                                            | Corrido solo: **10/10 verde**. Es la razón por la que conviene correr las suites en tandas chicas.                               |

**Los dos casos del spec de subtipo que necesitaban una decisión de diseño**, y qué hice —
en los dos, la prueba nueva es **más fuerte** que la que reemplaza:

- _«si la bobina que había al cotizar ya no sirve, el pedido reserva la que sí está
  disponible»_: el mecanismo que probaba (elegir rollo al confirmar) lo retiró D-134. La regla
  de fondo —**decide el material vivo al confirmar, no el que había al cotizar**— sigue viva y
  ahora se prueba en **los dos sentidos**: cerrar la única bobina compatible deja el agregado
  en cero y la confirmación **se cae**; comprar otra lo repone y la misma cotización, sin
  tocarla, se confirma.
- _«dos líneas del mismo producto no eligen la misma bobina»_: ya no hay elección de bobina;
  con D-134 las dos líneas prometen contra el **mismo** agregado y **suman**. Se prueba que
  con una sola bobina el pedido **falla entero** (ninguna línea queda con media promesa) y que
  con dos entra, con las dos reservas sobre la misma spec.

### Lo que necesita acción tuya

- **Tu revisión local con el Excel real** — marcar tus pendientes de verdad y confirmar el
  flujo completo. Es lo único que falta antes del push (§5).
- **Detuve dos servidores de desarrollo tuyos** (:3000 y :3001, levantados 11:54) para poder
  correr los E2E: el API estaba corriendo desde `dist/main`, o sea código anterior a esta
  sesión. Los podés relevantar con `pnpm dev:demo`.

### Riesgo residual anotado

- **Pendiente parcial (media línea entregada) queda fuera de v1**, como acordamos. Exigiría
  partir la línea del pedido en dos con su reserva y su despacho parciales, y el archivo no
  trae con qué decidir dónde parte.
- **La OP importada arranca hoy**, no el día del comprobante: la corrida empieza ahora aunque
  la factura sea de hace un mes (D-124).
- Sigue en pie el aviso de la sesión anterior: **este despliegue no tiene un orden seguro** —
  las migraciones van en las dos direcciones a la vez—, así que `pnpm db:prod` y
  `pnpm deploy:api` van **seguidos y con nadie operando**.

---

## 5. Cómo verificar

```bash
pnpm turbo lint typecheck test build   # verde (266/266 unitarios)
pnpm format:check                      # verde
pnpm exec eslint e2e                   # verde
pnpm dev:demo                          # api :3000 + web :3001 contra la rama demo
```

### Tu revisión local, con tu Excel de ventas

1. `/comprobantes` → **«Importar ventas (Excel)»** → subí tu archivo.
2. En la previsualización, cada comprobante tiene su **cabecera con el toggle**. Dejá en
   **ENTREGADO** todo lo ya entregado (es el default) y poné en **PENDIENTE** los que todavía
   debés.
3. Un pendiente **a medida**: si tenés los largos, escribilos en la columna
   **«Largos (m x cant.)»** (`3.60x4, 5.00x2`); si no, dejala vacía.
4. Fijate en los avisos: cada línea pendiente dice cuántos kilos va a reservar y contra cuánto.
   Si el material no alcanza, la fila queda **marcada** y ese documento solo entra como
   entregado.
5. Confirmá. Después:
   - `/pedidos` → los entregados salen **«Atendido»** con el badge **«Importado»**, y su
     detalle **no tiene ninguna reserva**.
   - Los pendientes salen **«Confirmado»**, con su reserva de kilos y el link al comprobante.
   - `/planta` → cada línea a medida pendiente tiene ya **su orden en cola, sin bobina
     montada**. Montás vos la bobina que quieras del color y espesor.
6. Probá reimportar el mismo archivo: los entregados se archivan solos; el primero que tenga
   un pedido vivo **rechaza la reimportación de ese comprobante** diciéndote cuál es.

### Después de tu visto bueno

```bash
git add -A && git commit && git push          # CI corre la suite completa (D-123)
# Los dos seguidos y con nadie operando: no hay orden seguro (§4).
pnpm db:prod
pnpm deploy:api
pnpm smoke:prod                                # verificación de solo lectura (D-126)
```

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126): producción tiene datos reales.

### E2E de esta sesión

```bash
pnpm e2e fase7finalb-pedido-importado    # 3/3
pnpm e2e fase7-consolidada-subtipo       # 6/6 (reescrito para D-134/D-122)
pnpm e2e fase6 fase7c                    # 25/25 (localizador y mensaje corregidos)
pnpm e2e fase5a-bordes                   # 10/10
```

Corré **tandas chicas**: el token de acceso dura 15 minutos y un archivo que tarde más se cae
con un 401 a mitad, que es lo que pasó al juntar ocho suites en un comando.

---

## 6. Siguiente sesión

1. **Fase 8** (auditoría, reportes, UAT), que sigue pendiente según §3.7.
2. Si la carga real deja algo a la vista, el candidato natural es el **pendiente parcial**, que
   esta sesión dejó explícitamente fuera de v1.
3. `vercel login` sigue pendiente para dejar `pnpm deploy:web` operativo fuera de un push.
