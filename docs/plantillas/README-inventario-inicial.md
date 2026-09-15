# Carga de inventario inicial (D-206)

Herramienta de **arranque**, no de uso diario: cada fila del archivo da de alta una bobina que
el cliente ya tiene físicamente en su almacén, con el kardex abierto al costo y la fecha que
declares. Es una excepción única a D-150 (que eliminó todos los importadores directos) — el
detalle completo de por qué esta sí y las demás no está en `docs/ARQUITECTURA.md` §0.2, D-206.

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

## Qué NO hace esta herramienta

- No factura, no genera una compra ni aparece en reportes de compras — `FACTURA DE REFERENCIA`
  es solo texto libre.
- No crea acabados ni colores.
- No permite corregir una bobina ya importada: si el código está mal, hay que corregirla desde
  **Bobinas** (editar) como cualquier otra, o anularla si todavía no tuvo movimientos.
