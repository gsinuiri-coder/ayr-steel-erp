# Guion de demo: accesorios de cobertura (D-242)

## Qué se muestra

Que un accesorio —cumbrera, canaleta, tapajunta— se fabrica con las **mismas bobinas** de
coberturas y se vende por **metro lineal**, y que el sistema entiende cómo sale de la roladora:
cada pasada usa el ancho completo del rollo y devuelve `N = piso(ancho ÷ desarrollo)` piezas del
largo de la pasada.

La idea en una línea, por si hay que decirla sin pantalla: **el operario reporta pasadas, el
sistema calcula piezas, metros y kilos.**

## Entorno

|             |                                                                   |
| ----------- | ----------------------------------------------------------------- |
| Rama        | `acc-demo` (PR en **draft**, no mergeada)                         |
| Dónde corre | entorno demo — web `localhost:3001`, API `localhost:3000` (D-227) |
| Datos       | rama Neon `demo` + los datos que siembra el guion de abajo        |
| Producción  | **no se toca**                                                    |

### Antes de empezar (una vez)

1. **La migración la corre el dueño** (D-234), desde la raíz del worktree, con el entorno de la
   rama `demo` ya configurado fuera de la sesión:

   ```text
   pnpm --filter @ayr/api exec prisma migrate deploy
   ```

   Aplica las dos migraciones de D-242 (`20260922150000_d242_accesorio_enum` y
   `20260922150100_d242_accesorios_de_cobertura`). Son **aditivas**: una columna nullable, un
   valor de enum y dos CHECK. Ningún SKU existente cambia de forma.

2. Levantar la app contra `demo`:

   ```text
   pnpm dev:demo
   ```

3. Sembrar los datos de la demo (crea todo por HTTP, nunca por SQL). Las credenciales viajan
   por entorno, nunca por línea de comandos:

   ```text
   node scripts/oneoff/20260922-demo-accesorios.mjs
   ```

   Deja: color y acabado de demo, **dos SKU** (`DEMO-ACC-CUMB-300`, desarrollo 300 mm;
   `DEMO-ACC-CANA-400`, desarrollo 400 mm), una bobina de 1 200 mm × 0.30 mm con 1 500 kg, el
   cliente **CLIENTE DEMO ACCESORIOS** y un pedido de 36 ML con su orden ya en cola.

   Todo lleva el prefijo `DEMO-ACC` y el cliente está rotulado: la rama `demo` es copia de datos
   reales y nada de esto puede confundirse con un cliente o un SKU de verdad.

---

## 1. El SKU: qué hace distinto a un accesorio (2 min)

1. **Catálogo** → buscar `DEMO-ACC`. Están los dos accesorios, en **MTR**.
2. Abrir `DEMO-ACC-CUMB-300` con **Editar**. Mostrar:
   - el subtipo **Accesorio** (junto a «Plancha de catálogo» y «A medida»);
   - el campo **Desarrollo (mm)** = 300, que solo aparece en este subtipo.
3. Cambiar el desarrollo a **350** sin guardar y leer la línea que aparece debajo:
   _3 piezas por pasada con el ancho nominal · canto 150.00 mm (12.5 %) · el metro vendido
   cuenta 400.00 mm de ancho_.

   **Lo que hay que decir:** el canto no desaparece; se lo cobra el metro que se vende. Por eso
   lo que el pedido reserva y lo que la bobina pierde dan el mismo número.

4. Volver el desarrollo a **300** y cerrar sin guardar.

## 2. La venta: se cotiza por metro (2 min)

1. **Pedidos** → abrir el pedido de `CLIENTE DEMO ACCESORIOS`.
2. Mostrar la línea: **36.000 ML**, con el detalle **12 × 3.00 m**.
3. Mostrar la reserva: **25.688 kg** de bobina.

   **Lo que hay que decir:** 36 metros de cumbrera se llevan 25.7 kg, no los 103 kg que se
   llevarían 36 metros de plancha ancha. El sistema sabe que de cada pasada salen cuatro piezas.

## 3. La producción: se reporta en pasadas (5 min — **el corazón de la demo**)

1. **Producción** → entrar al pedido → pestaña de la orden.
2. **Montar la bobina.** En el selector, cada bobina muestra **cuántas piezas por pasada** da y
   los **ML de accesorio** que rinde su saldo.
3. Con la bobina montada aparece el aviso:
   _Accesorio: cargá el largo de cada pasada y cuántas pasadas. La bobina … da **4** piezas por
   pasada con un desarrollo de 300.00 mm._
   Y la columna del editor dice **Pasadas**, no «Planchas».
4. Cargar **largo 3.00 m, pasadas 3**. Antes de agregar, la línea de abajo muestra:
   `3 × 3.00 m (pasadas) → 12 × 3.00 m · 36.000 m · 25.689 kg teóricos`.

   **Lo que hay que decir:** el operario tipea lo que hizo —tres pasadas— y el sistema dice lo
   que salió: doce piezas, 36 metros, 25.7 kg.

5. Agregar al borrador y **ejecutar**.
6. Mostrar el resultado: el pedido pasa a tener sus 36 ML producidos, y el kardex de la bobina
   bajó exactamente los 25.7 kg que el pedido había prometido.

## 4. A stock, sin pedido detrás (3 min)

1. **Producción** → **Abrir una orden nueva** → tarjeta **Accesorios a stock**.
2. Elegir `DEMO-ACC-CANA-400`, **largo 3 m**, **9 piezas**. La línea de resumen dice
   _9 piezas de 3 m = 27.000 ML · con el ancho del catálogo, 3 pasadas_.
3. Crear, montar bobina y reportar **3 pasadas de 3 m** → 9 piezas, 27 ML.
4. Mostrar en **Inventario** que el saldo queda **disponible** (reservado 0): es stock de
   mostrador, no está prometido a nadie.

---

## Las tres preguntas para el cliente

Son las decisiones que se tomaron por defecto y que esta demo existe para confirmar. Conviene
hacerlas en voz alta y anotar la respuesta: cada una es una decisión `D-nnn` después.

1. **¿Cada pasada se reporta con su propio largo?** Hoy sí: largos distintos son pasadas
   separadas. Si en la práctica se corta una tira larga y después se subdivide, el reporte tiene
   que cambiar de forma.
2. **¿Los retazos se reportan como merma?** Hoy sí, por el camino que ya existe: el kilo
   declarado por reporte y la merma de despunte al cerrar. El canto lateral **no** se reporta
   aparte porque ya está dentro de los kilos que salen.
3. **¿Un pedido de accesorio debe tomar el stock que ya hay, o producir siempre?** Hoy **produce
   siempre**: la línea reserva materia prima y va a la cola, así que el saldo a stock se vende
   solo por mostrador. Es la pregunta que D-171 dejó abierta para las planchas y que ahora tiene
   caso real. Si la respuesta es «que lo tome», hay que decidir también qué pasa cuando alcanza
   para parte del pedido.

## Lo que esta demo **no** muestra

- No hay despacho ni comprobante del accesorio: el flujo comercial es el mismo que ya existe y
  no cambió con D-242.
- No hay precios por volumen ni listas por cliente: el accesorio usa el precio de lista normal.
- **Nada de esto está en producción.** La rama no se mergea hasta que el cliente valide.
