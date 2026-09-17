# UAT — RF-S3 (Hardening: búsqueda, card sin-stock, PITR)

Pensado para correr en el entorno `demo` (D-227, copia de `production` con salidas externas
apagadas). Cada caso dice qué mirar y qué se espera. Ningún caso escribe algo que no se pueda
deshacer; los que crean un registro de prueba lo dicen explícitamente.

## Antes de empezar

- Entrar como ADMINISTRADOR. Algunos casos (M4) son solo para ese rol.
- Tener a mano un cliente y un producto activos de `demo` para los casos de búsqueda (no
  hace falta crear nada nuevo).

## Caso 1 — Buscar un cliente en una cotización nueva (M1)

1. Ir a **Cotizaciones → Nueva**.
2. Hacer clic en el campo **Cliente**, sin escribir nada todavía.
   - **Esperado:** el modal ya muestra algunas filas (los primeros clientes activos,
     alfabético) — no hace falta escribir para ver algo.
3. Escribir un solo carácter de un nombre conocido.
   - **Esperado:** el modal dice "Escribe al menos 2 caracteres para buscar." — no muestra
     ninguna fila mientras el texto tenga solo ese carácter.
4. Completar hasta 2-3 caracteres de un nombre o RUC real.
   - **Esperado:** aparecen resultados en menos de un segundo, ordenados con las coincidencias
     que empiezan igual primero.
5. Elegir un cliente y confirmar que el campo lo muestra.

**No pasa (regresión a vigilar):** que el campo se quede cargando indefinidamente, que muestre
"Ninguna opción coincide" con un cliente que sabemos que existe, o que la lista tarde
notoriamente más de un segundo.

## Caso 2 — Buscar un producto en el picker con stock (M1)

1. En la misma cotización, elegir una línea de negocio.
2. Hacer clic en el campo **Producto**.
3. Escribir el SKU o el nombre de un producto activo conocido (al menos 2 caracteres).
   - **Esperado:** aparece con su disponible al lado, igual que antes de esta ventana — lo
     único que cambió es que ya no hace falta que el catálogo entero esté cargado de
     antemano.
4. Elegirlo y confirmar que la línea lo muestra.

## Caso 3 — Editar un pedido viejo: el cliente se ve sin buscar nada (M1, hidratación)

1. Abrir un pedido cualquiera ya existente (**Pedidos**, elegir uno de la lista).
2. Si es ADMINISTRADOR, abrir **Más acciones → Cambiar cliente**.
   - **Esperado:** el campo "Cliente nuevo" empieza vacío (es un cliente _nuevo_, no el
     actual — eso es lo correcto), y buscando el cliente actual por su propio nombre **no**
     aparece como opción (no tiene sentido "cambiarlo" por el mismo).
3. Cerrar sin guardar nada.

## Caso 4 — Tarjeta "Cotizaciones sin stock disponible" (M2, sigue igual por fuera)

1. Ir al **Panel**.
2. Si hay alguna cotización emitida cuyo material no alcanza hoy, tiene que aparecer acá con
   el mismo detalle de siempre (SKU, línea, cuánto falta).
   - **Esperado:** ningún cambio visible respecto de antes de esta ventana — M2 cambió cómo
     se calcula por dentro (más rápido con muchas cotizaciones a la vez), no qué muestra.
3. Si no hay ninguna cotización con faltante en `demo` en este momento, este caso queda sin
   verificar visualmente; alcanza con que el Panel cargue sin error.

## Caso 5 — Tarjeta "SKUs con lista bajo piso" (M4, sacrificable — nueva)

Solo ADMINISTRADOR.

1. Ir al **Panel**.
2. Si algún SKU activo con precio de lista cargado queda por debajo del piso de D-163,
   aparece una tarjeta nueva "SKUs con lista bajo piso" con el conteo.
   - **Esperado:** cada fila muestra el SKU, el precio de lista y el mínimo, los dos con
     IGV.
3. Hacer clic en una fila.
   - **Esperado:** navega a **Catálogo**, abre la línea de negocio de ese SKU y resalta su
     fila (fondo ámbar tenue), sin necesidad de buscarlo a mano.
4. Si `demo` no tiene ningún SKU por debajo del piso, la tarjeta no aparece — eso también es
   correcto (la tarjeta ES el aviso, no aparece cuando no hay nada que avisar).

**Aviso conocido:** si nadie cargó todavía precios de lista reales en `demo`/`production`
(D-224 lo deja anotado), esta tarjeta puede no tener nada que mostrar — no es un defecto,
es que falta el dato de entrada.

## Caso 6 — Nada de esto rompe lo que ya funcionaba

1. Crear una cotización completa de punta a punta (cliente, línea, producto, cantidad,
   precio) y guardarla.
2. Editar un pedido existente (cambiar cantidad de una línea, si el rol lo permite).
3. Confirmar que ninguno de los dos flujos se ve distinto de antes de esta ventana, salvo los
   selectores de cliente/producto (Casos 1-2).

## Qué reportar

Para cada caso: **pasa** / **no pasa** (con captura si no pasa) / **no se pudo verificar**
(y por qué — por ejemplo, "no hay SKU bajo piso en demo hoy"). No hace falta más detalle que
eso; el guion ya dice qué se espera en cada paso.
