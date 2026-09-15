# Carga de inventario inicial (D-206)

Herramienta de **arranque**, no de uso diario: cada fila del archivo da de alta algo que el
cliente ya tiene físicamente en su almacén, con el kardex abierto al costo y la fecha que
declares. Es una excepción única a D-150 (que eliminó todos los importadores directos) — el
detalle completo de por qué esta sí y las demás no está en `docs/ARQUITECTURA.md` §0.2, D-206.

Dos modos, `--kind coils` (default) y `--kind products` (F8-S6a2), mismo comando y mismas reglas
de fondo, para dos clases de saldo distintas:

- **`coils`**: bobinas físicas de Drywall o Metallic Roofing (una fila = una bobina nueva, con su
  código RF-13 propio).
- **`products`**: stock por unidades de **cobertura UPVC y reventa** — las dos líneas donde el
  producto ya es compra-venta pura (D-091) y no hay bobina detrás. El resto de este documento
  describe primero `coils` y después `products` (ver «Productos (UPVC y reventa)» más abajo).

Reglas que importan antes de tocar nada:

- **Nunca actualiza una bobina que ya existe.** Cada fila crea una bobina nueva o se rechaza; no
  hay "modo actualización". Si el código de la fila ya está en la base, esa fila falla.
- **Todo o nada.** Si una sola fila del archivo tiene un error, no se importa ninguna — ni
  siquiera las que estaban bien. El reporte dice fila por fila qué falló.
- **Dry-run por defecto.** Sin `--execute` el comando lee el archivo, valida contra el catálogo
  y muestra el reporte, pero no escribe nada. Corré el dry-run las veces que haga falta hasta
  que el archivo salga limpio.
- **El acabado y el color tienen que existir ya en el catálogo** (Acabados/Colores). Esta
  herramienta no crea acabados ni colores — si el archivo trae uno que no existe, esa fila
  falla y dice cuál.

## Columnas del archivo (xlsx o csv)

| Columna                         | Obligatoria                      | Contenido                                                                                                                                                                                                                                                                                             |
| ------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CÓDIGO BOBINA`                 | Sí                               | El código con el que **el cliente** identifica la bobina en su propio inventario. No es el código RF-13 del sistema (ese lo genera la carga); es la referencia para reconciliar contra la lista física. No se puede repetir, ni dentro del archivo ni contra una bobina que ya exista.                |
| `ACABADO`                       | Sí                               | El código del acabado, tal como aparece en Acabados. Tiene que existir, estar activo y tener tipo/línea completos (D-203).                                                                                                                                                                            |
| `COLOR`                         | Solo si el acabado es prepintado | El nombre del color (tal como aparece en Colores). Tiene que coincidir con el color **del acabado** — el color de la bobina sale del acabado (D-203), esta columna es para que la fila se valide contra lo que vos escribiste, no para elegirlo aparte. Vacía si el acabado es natural o galvanizado. |
| `ESPESOR (MM)`                  | Sí                               | Decimal, en milímetros.                                                                                                                                                                                                                                                                               |
| `ANCHO (MM)`                    | Sí                               | Decimal, en milímetros.                                                                                                                                                                                                                                                                               |
| `KILOS INICIALES`               | Sí                               | Decimal, los kilos con los que abre el kardex.                                                                                                                                                                                                                                                        |
| `COSTO UNITARIO (S/KG SIN IGV)` | Sí                               | Costo por kilo, **sin IGV**, en la moneda de la columna `MONEDA`.                                                                                                                                                                                                                                     |
| `MONEDA`                        | Sí                               | `PEN` o `USD`.                                                                                                                                                                                                                                                                                        |
| `TIPO DE CAMBIO`                | Solo si `MONEDA` es `USD`        | El tipo de cambio de esa compra histórica. En soles, dejar vacío (siempre es 1).                                                                                                                                                                                                                      |
| `FACTURA DE REFERENCIA`         | No                               | Solo trazabilidad — no genera ninguna compra ni aparece en reportes de compras. Queda escrita en el kardex de la bobina.                                                                                                                                                                              |
| `FECHA DE REFERENCIA`           | No                               | `AAAA-MM-DD` o `DD/MM/AAAA`. Si se deja vacía, el kardex dice "fecha de carga" en vez de una fecha — no es la fecha de operación del movimiento (esa la fija `--operation-date` o el día en que se corre el comando), es solo el dato histórico de cuándo entró la bobina según el cliente.           |

## El archivo de ejemplo

`inventario-inicial-ejemplo.csv` (esta misma carpeta) trae 12 filas válidas — prepintados en
cuatro colores, un natural, un galvanizado, costos en soles y en dólares, con y sin factura de
referencia — y 3 filas **deliberadamente inválidas** al final, para ver el reporte de errores en
acción antes de tocar datos reales:

- `INVALIDO-ACABADO-INEXISTENTE`: el acabado `EJ-NOEXISTE` no está en ningún catálogo.
- `INVALIDO-COLOR-NO-COINCIDE`: usa el acabado `EJ-ROJO` pero declara color `Azul`.
- `INVALIDO-SIN-COSTO`: no trae costo unitario.

### Antes de ensayarlo

El archivo referencia seis acabados de ejemplo (`EJ-ROJO`, `EJ-AZUL`, `EJ-VERDE`, `EJ-BLANCO`,
`EJ-NATURAL`, `EJ-GALV`) que no existen en ninguna base real — hay que crearlos primero en
**Acabados** (línea Coberturas Aluzinc), contra los colores de ejemplo que ya trae el seed
(Rojo, Azul, Verde, Blanco):

| Código       | Tipo        | Color  | Línea              |
| ------------ | ----------- | ------ | ------------------ |
| `EJ-ROJO`    | Prepintado  | Rojo   | Coberturas Aluzinc |
| `EJ-AZUL`    | Prepintado  | Azul   | Coberturas Aluzinc |
| `EJ-VERDE`   | Prepintado  | Verde  | Coberturas Aluzinc |
| `EJ-BLANCO`  | Prepintado  | Blanco | Coberturas Aluzinc |
| `EJ-NATURAL` | Natural     | —      | Coberturas Aluzinc |
| `EJ-GALV`    | Galvanizado | —      | Coberturas Aluzinc |

Con eso, el dry-run del archivo de ejemplo muestra 12 filas OK y 3 con error — es exactamente lo
que hay que ver antes de ensayar con el archivo real del cliente.

## Cómo correr el comando

```
# Dry-run (no escribe nada) contra el Postgres local
pnpm import:initial-inventory --file docs/plantillas/inventario-inicial-ejemplo.csv --branch local

# Ejecutar de verdad contra local, una vez que el dry-run sale limpio
pnpm import:initial-inventory --file docs/plantillas/inventario-inicial-ejemplo.csv --branch local --execute

# Contra la rama de ensayo con el cliente
pnpm import:initial-inventory --file "Inventario cliente.xlsx" --branch demo --execute

# Contra producción (la carga real, una sola vez, en la ventana V-4)
pnpm import:initial-inventory --file "Inventario cliente.xlsx" --branch production --execute --confirm-production
```

`--branch` acepta `local`, `local-e2e`, `dev`, `demo` o `production` (por defecto `local`).
Contra `production`, `--execute` exige además `--confirm-production` — sin ese flag no se
ejecuta nada, aunque el resto de los flags estén completos.

## Cómo leer el reporte

Cada fila sale con su código y, si falló, la lista de motivos:

```
  fila 1 (BOB-2026-001): OK → SALDO-EJROJO-0.35-2450.5-1
  fila 13 (INVALIDO-ACABADO-INEXISTENTE):
      - ACABADO "EJ-NOEXISTE": no existe en el catálogo. Créalo en Acabados antes de importar...
```

`OK → <código>` es el código RF-13 que le tocó a la bobina en el sistema — el `CÓDIGO BOBINA`
del archivo queda guardado aparte, como referencia del cliente (visible en el detalle de la
bobina y en su kardex, columna "Motivo"). Al final, un resumen dice cuántas filas pasaron y
cuántas no; si hay una sola con error, la línea "No se importó nada" confirma que el archivo
completo se rechazó — corregí las filas marcadas y volvé a correr el dry-run.

## Qué NO hace esta herramienta (bobinas)

- No factura, no genera una compra ni aparece en reportes de compras — `FACTURA DE REFERENCIA`
  es solo texto libre.
- No crea acabados ni colores.
- No permite corregir una bobina ya importada: si el código está mal, hay que corregirla desde
  **Bobinas** (editar) como cualquier otra, o anularla si todavía no tuvo movimientos.

---

## Productos (UPVC y reventa) — F8-S6a2

`--kind products` da de alta el saldo inicial de un producto de catálogo que se compra y se
revende tal cual — cobertura UPVC (línea `Coberturas (UPVC)`) y reventa (línea `Reventa`). Cada
fila **suma unidades a un SKU que ya existe**: no crea productos, no crea líneas de negocio y
nunca toca un producto de fabricación propia (Drywall, Metallic Roofing) — eso lo decide el
mismo campo `source` del producto (`PURCHASED` vs `MANUFACTURED`), nunca el SKU ni su texto.

Reglas propias de este modo, además de las generales de arriba (todo o nada, dry-run por
defecto):

- **El SKU tiene que existir ya en el Catálogo**, estar activo, ser de la línea UPVC o Reventa, y
  su `source` tiene que ser `Comprado` (`PURCHASED`). Un SKU de Drywall o Metallic Roofing, o uno
  `Fabricado`, se rechaza con el motivo puntual.
- **Nunca actualiza un producto con historial.** Si el SKU ya tiene algún movimiento de kardex
  (de cualquier origen, no solo de esta herramienta), la fila se rechaza: esto es solo para el
  arranque, antes de que el producto tenga movimiento real.
- **El mismo SKU puede repetirse en el archivo** (a diferencia de `CÓDIGO BOBINA` en bobinas): son
  unidades fungibles, así que dos filas del mismo SKU con costos distintos son dos entradas que
  promedian, igual que dos facturas distintas de compra del mismo producto.

### Columnas del archivo

| Columna                    | Obligatoria               | Contenido                                                                                                     |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SKU PRODUCTO`             | Sí                        | El SKU tal como aparece en Catálogo. Tiene que existir, estar activo, ser de línea UPVC/Reventa y `Comprado`. |
| `UNIDADES`                 | Sí                        | Decimal mayor a cero, en la unidad del producto (`NIU`, `MTR`, etc. — la que ya tiene el SKU en Catálogo).    |
| `COSTO UNITARIO (SIN IGV)` | Sí                        | Costo por unidad, **sin IGV**, en la moneda de la columna `MONEDA`.                                           |
| `MONEDA`                   | Sí                        | `PEN` o `USD`.                                                                                                |
| `TIPO DE CAMBIO`           | Solo si `MONEDA` es `USD` | El tipo de cambio de esa compra histórica. En soles, dejar vacío (siempre es 1).                              |
| `FACTURA DE REFERENCIA`    | No                        | Solo trazabilidad, queda escrita en el kardex — no genera ninguna compra.                                     |
| `FECHA DE REFERENCIA`      | No                        | `AAAA-MM-DD` o `DD/MM/AAAA`. Vacía → el kardex dice "fecha de carga".                                         |

### El archivo de ejemplo

`inventario-inicial-productos-ejemplo.csv` (esta misma carpeta) trae 8 filas válidas — tres SKU
de UPVC y cuatro de reventa, en soles y en dólares, con y sin factura de referencia, y una
segunda factura para un mismo SKU (para ver el promedio ponderado) — y 3 filas **deliberadamente
inválidas** al final:

- `INVALIDO-SKU-INEXISTENTE`: no está en ningún catálogo.
- `EJ-UPVC-BLANCO` con `0` unidades: la cantidad tiene que ser mayor a cero.
- `EJ-PERFIL-FABRICADO`: existe, pero es de Drywall — fuera de las líneas compra-reventa (UPVC,
  Reventa) que alcanza esta herramienta. Un SKU fabricado **dentro** de UPVC/Reventa se rechaza
  igual, con el motivo puntual ("es un producto fabricado").

### Antes de ensayarlo

El archivo referencia ocho SKU de ejemplo que no existen en ninguna base real — hay que crearlos
primero en **Catálogo**:

| SKU                   | Nombre                        | Línea             | Unidad | Origen    |
| --------------------- | ----------------------------- | ----------------- | ------ | --------- |
| `EJ-UPVC-BLANCO`      | Cobertura UPVC blanca         | Coberturas (UPVC) | `NIU`  | Comprado  |
| `EJ-UPVC-GRIS`        | Cobertura UPVC gris           | Coberturas (UPVC) | `NIU`  | Comprado  |
| `EJ-UPVC-TEJA`        | Cobertura UPVC teja           | Coberturas (UPVC) | `NIU`  | Comprado  |
| `EJ-REVENTA-TORNILLO` | Tornillo autorroscante        | Reventa           | `NIU`  | Comprado  |
| `EJ-REVENTA-SELLADOR` | Sellador de silicona          | Reventa           | `NIU`  | Comprado  |
| `EJ-REVENTA-CLAVO`    | Clavo de acero                | Reventa           | `NIU`  | Comprado  |
| `EJ-REVENTA-CINTA`    | Cinta para juntas             | Reventa           | `NIU`  | Comprado  |
| `EJ-PERFIL-FABRICADO` | Perfil (solo para el rechazo) | Drywall           | `NIU`  | Fabricado |

Con eso, el dry-run del archivo de ejemplo muestra 8 filas OK y 3 con error.

### Cómo correr el comando

```
# Dry-run (no escribe nada) contra el Postgres local
pnpm import:initial-inventory --file docs/plantillas/inventario-inicial-productos-ejemplo.csv --kind products --branch local

# Ejecutar de verdad contra local, una vez que el dry-run sale limpio
pnpm import:initial-inventory --file docs/plantillas/inventario-inicial-productos-ejemplo.csv --kind products --branch local --execute

# Contra producción (la carga real, una sola vez, en la ventana V-4)
pnpm import:initial-inventory --file "Productos cliente.xlsx" --kind products --branch production --execute --confirm-production
```

### Qué NO hace esta herramienta (productos)

- No crea productos ni líneas de negocio.
- No factura, no genera una compra ni aparece en reportes de compras.
- No toca un producto de fabricación propia (Drywall, Metallic Roofing): eso es lo que existe la
  carga de bobinas y la producción para hacer.
- No permite corregir una fila ya importada: si el costo o la cantidad están mal, se ajusta desde
  **Inventario** (ajuste manual) como cualquier otro movimiento.
