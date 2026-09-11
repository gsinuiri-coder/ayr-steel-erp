# S11 — Fase 1: inspección de flujos en navegador (2026-09-11)

Recorrido de los cinco flujos del brief en `pnpm dev:local` (api `:3000` + web `:3001`,
Postgres Docker `ayr_local`), con Chrome real, a 2133 × 1050 px de viewport CSS
(ventana 1920 × 1032 con zoom del navegador al 90 %).

Cada hallazgo lleva su clasificación:

- **(a)** fix barato de UI — se puede hacer en esta sesión (bloque B3).
- **(b)** lógica o schema — **solo se documenta**, prohibido tocarlo acá; va a Fase 8.
- **(c)** fricción de flujo — se documenta con propuesta; algunos tienen una mitad (a).

Lo que se ejecutó de verdad, no solo se miró: COT-000054 creada → emitida → confirmación
rechazada por falta de materia prima; OP-000007 reportada y cerrada desde `/planta`;
DES-000001 despachado desde PED-000023. El resto de las pantallas se recorrió con datos
existentes.

---

## 0. Resumen ejecutivo

Dos hallazgos mandan sobre todos los demás:

1. **Toda la aplicación se está renderizando en Times New Roman** (T-01). No es una
   impresión: `getComputedStyle(document.documentElement).fontFamily` devuelve
   `"Times New Roman"` en todas las pantallas. La variable de la fuente nunca llega al
   elemento que la usa. Es un fix de dos líneas y cambia la lectura de cada pantalla del
   sistema — es, además, el punto de partida obligado de B1: no tiene sentido calibrar
   densidad tipográfica sobre una fuente que no es la que se va a usar.
2. **No se puede despachar con transporte ninguna línea que no se mida en kilos** (F2-01).
   El API exige un peso por línea que el formulario nunca pide. Reproducido de punta a
   punta. La suite E2E no lo ve porque despacha por API, no por la pantalla. Es (b): se
   documenta para Fase 8 y no se toca en esta sesión.

El resto se ordena abajo por alcance: primero lo transversal (que es donde está casi toda
la ganancia de densidad), después flujo por flujo.

---

## 1. Hallazgos transversales

### T-01 — (a) La app entera se renderiza en la fuente serif por defecto

**Qué pasa.** `apps/web/src/app/globals.css:10` declara, dentro de `@theme inline`:

```css
--font-sans: var(--font-sans);
```

que es una autorreferencia: no resuelve a nada. La fuente real la carga
`apps/web/src/app/layout.tsx` con `next/font/google` bajo el nombre `--font-geist-sans`, y
la aplica **en `<body>`** (`className={geistSans.variable}`). Pero quien consume la
variable es `html` (`globals.css:128`, `@apply font-sans`), donde `--font-geist-sans` ni
siquiera está definida. `font-family: var(--font-sans)` queda inválida y el navegador cae
a su fuente por defecto.

**Evidencia** (consola del navegador, cualquier pantalla de la app):

```js
getComputedStyle(document.documentElement).fontFamily; // '"Times New Roman"'
getComputedStyle(document.documentElement).getPropertyValue('--font-sans'); // ''
getComputedStyle(document.documentElement).getPropertyValue('--font-geist-sans'); // ''
```

**Propuesta.** Mover las variables de `next/font` al `<html>` (patrón estándar de Next) y
dar a `--font-sans` un valor real con su cadena de respaldo:

```css
--font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
```

**Por qué importa acá.** Geist es una grotesca con números tabulares y una altura de x más
alta que Times: a igual tamaño se lee mejor y ocupa menos alto de línea. Es la primera
palanca de B1 y la que hace que todo lo demás se pueda calibrar mirando lo que el dueño va
a ver.

### T-02 — (a) El toast tapa y bloquea la barra de acciones

**Qué pasa.** `apps/web/src/app/providers.tsx:18` monta `<Toaster position="top-right" …>`
y todas las pantallas de detalle ponen su barra de acciones arriba a la derecha. Los dos
ocupan el mismo rincón.

**Evidencia.** En `/cotizaciones/<id>` con un toast en pantalla:

```js
// centro de cada botón de la barra de acciones
document.elementFromPoint(cx, cy); // → LI.cn-toast  para «Confirmar y reservar», «Anular» y «Duplicar»
```

No es solo estorbo visual: el toast **intercepta el clic**. Durante la inspección costó
tres intentos confirmar una cotización por esto, y los toasts se apilan (dos a la vez
después de crear + emitir), así que la barra queda muerta más tiempo del que dura un
toast.

**Propuesta.** `position="bottom-right"`. No cambia el texto de ningún toast, así que no
toca los selectores de los specs.

### T-03 — (a) Densidad de las listas: la línea base medida

Medido con el primer `<tr>` de cada lista, normalizado a un viewport de 950 px de alto
(lo que deja una ventana maximizada a 1080p con el cromo del navegador):

| Lista           | Primera fila (px desde arriba) | Alto de fila | Filas visibles |
| --------------- | -----------------------------: | -----------: | -------------: |
| `/cotizaciones` |                            245 |         53.1 |       **13.3** |
| `/pedidos`      |                            245 |         53.1 |       **13.3** |
| `/bobinas`      |                            305 |         41.7 |       **15.5** |
| `/produccion`   |                            503 |         69.0 |        **6.5** |

De dónde sale cada pérdida:

- **Cabecera fija de 48 px** (`(app)/layout.tsx`) que solo dice «AYR Steel ERP» y repite el
  botón de menú.
- **`main` con `p-6 gap-6`** (24 px por lado, 24 px entre bloques).
- **Bloque de título**: `h1` de 24 px + subtítulo + fila de filtros, cada uno con su gap.
- **Celda de dos líneas** en cotizaciones/pedidos (nombre del cliente + documento), que
  sube la fila de ~34 a 53 px.
- **`/produccion`** paga además la tarjeta «Cola de producción» entera antes de la tabla:
  la primera fila arranca a 503 px.

**Objetivo B1** (≥ 50 % más filas): 20 / 20 / 23 / 10 respectivamente.

### T-04 — (a) La tira de cuatro tarjetas KPI, repetida en seis vistas

El mismo bloque `<div className="grid gap-4 md:grid-cols-4">` con cuatro `<Card>` de una
sola cifra aparece literalmente en:

- `cotizaciones/[id]/cotizacion-detalle-view.tsx:207`
- `pedidos/[id]/pedido-detalle-view.tsx:315`
- `despachos/[id]/despacho-detalle-view.tsx:194`
- `comprobantes/[id]/comprobante-detalle-view.tsx:718`
- `planta/roofing-order-panel.tsx:394` (variante con `gap-px`)
- `components/sales/sales-document-form.tsx:575`

Cada tarjeta mide ~76 px de alto para mostrar una fecha o un monto. Son ~50 px por pantalla
que se pueden recuperar con un componente compacto único (una tira de definiciones con
etiqueta chica arriba y cifra tabular abajo, separadores en vez de tarjetas).

**Propuesta.** Un `StatStrip` en `components/` y reemplazo mecánico en las seis vistas.
Beneficio doble: densidad y una sola definición de cómo se ve un dato de cabecera.

### T-05 — (a/c) Los badges de estado no siguen ningún criterio

Observado en un solo recorrido:

| Estado                                                 | Cómo se ve               |
| ------------------------------------------------------ | ------------------------ |
| `En producción`, `Confirmado`, `Activa`, `Despachado`  | píldora negra sólida     |
| `Consumida`                                            | píldora gris clara       |
| `Abierta`, `Cerrada`, `Recibida`, `Borrador` (compras) | píldora clara con borde  |
| `Borrador`, `Emitida` (cotizaciones)                   | texto plano, sin píldora |

Un estado bueno (`Activa`) y uno de trabajo (`En producción`) comparten el negro más fuerte
de la paleta; un estado terminal (`Consumida`) es el más apagado. No hay forma de aprender
la convención porque no hay convención.

Es el insumo directo de la **Fase 3**: los estados de dominio necesitan una escala
semántica única (neutro / en curso / cerrado / anulado) aplicada por token, no por vista.

### T-06 — (c) Rojo decorativo donde no hay error

`/cobranzas` pinta la tarjeta «Vencido» en rojo **siempre**, incluso cuando vale
`S/ 0.00` — que es exactamente la buena noticia. El brief reserva rojo/ámbar para
error/warning; este es el único uso decorativo encontrado en el recorrido, y es el caso más
claro de por qué la regla vale: hoy el rojo no significa nada.

**Propuesta (Fase 3).** El valor en rojo solo cuando es `> 0`; en cero, neutro.

### T-07 — (c) El menú lateral es más alto que la pantalla

Medido en `/inventario` con 987 px de viewport:

```js
sidebarContent.clientHeight; // 823
sidebarContent.scrollHeight; // 944
itemHeight; // 32  (× 23 ítems + 5 encabezados de grupo)
footerHeight; // 113
```

Ya a 987 px el menú scrollea y el grupo **Administración** queda cortado por el pie
(usuario + «Cerrar sesión»), sin ninguna pista visual de que hay más abajo. En una laptop
de 1366 × 768 el corte empieza mucho antes, alrededor de «Bobinas».

**Propuesta (B2).** Bajar el alto de ítem a 28 px y apretar el padding de grupo (≈ 800 px
de menú, entra completo a 1080p), y aprovechar que el `Sidebar` ya es `collapsible="icon"`
—el colapso existe y funciona, solo falta que aporte de verdad en pantallas chicas.

### T-08 — (c) El sort por columna llegó solo a cuatro listas

D-177 cubrió cotizaciones, pedidos, bobinas y producción. Quedaron sin ordenar por columna:
`/compras`, `/comprobantes`, `/despachos`, `/cobranzas` (las dos tablas) y `/kardex`. El
mecanismo ya existe (`lib/use-sort.ts` + `components/sortable-table-head.tsx`), así que
extenderlo es mecánico — pero es alcance nuevo, no densidad: queda anotado, no propuesto
para esta sesión.

### T-09 — (a) Las tablas llegan al filo de su tarjeta

En `/inventario` y `/kardex` la última columna (`Valorizado`, `Motivo / usuario`) termina
pegada al borde derecho del contenedor, y en kardex el texto se corta con `…` contra ese
mismo borde. Falta el respiro lateral que sí tienen las tablas dentro de `Card`.

---

## 2. Flujo 1 — Cotización → pedido → OP → montar bobina → reportar → cerrar

Recorrido completo. COT-000054 (METALMARK, Coberturas Aluzinc, 10 planchas × 3.00 m)
creada y emitida; la confirmación se rechazó correctamente por falta de materia prima.
OP-000007 (PL045ROJO, PED-000023) reportada y cerrada desde `/planta`, con su salida de
kardex y su entrada de producto terminado verificadas en `/kardex`.

### F1-01 — (a) `/planta` y `/produccion` comparten el mismo `<h1>`

Las dos pantallas se titulan **«Producción»**. En el menú son «Producción» (→ `/planta`) y
«Órdenes de producción» (→ `/produccion`). Quien llega por un link no tiene cómo saber en
cuál está.

**Propuesta.** `/planta` → «Terminal de planta» (que es como la nombra el propio subtítulo
de `/produccion`: «La captura del operario está en /planta»), `/produccion` → «Órdenes de
producción», alineando `<h1>`, `metadata.title` y el ítem del menú.

### F1-02 — (a) Los dos botones de cierre de orden ocupan el ancho completo

En `/planta`, «Guardar OP-000007» mide ~580 px y «Guardar y cerrar» ~720 px, uno al lado
del otro, de borde a borde de la tarjeta. El más irreversible de los dos es el más grande y
el más oscuro. Al costado, «Cambiar fecha de operación» queda como texto suelto pegado al
borde derecho.

**Propuesta.** Botones al ancho de su contenido, alineados a la derecha, con «Guardar y
cerrar» como primario y «Guardar» como secundario; «Cambiar fecha de operación» adentro del
bloque de reporte, que es a lo que pertenece.

### F1-03 — (a) Un «por» huérfano en la línea sin producto

En `/cotizaciones/nueva`, mientras la línea no tiene producto elegido, debajo del campo de
precio se imprime la palabra **«por»** sola, sin unidad. Al elegir producto pasa a ser
«por m» y tiene sentido. Es el sufijo armado antes de tener con qué completarlo.

### F1-04 — (c) El rechazo de la confirmación solo vive en el toast

Al confirmar sin materia prima, el API responde con un mensaje excelente:

> Línea 1: Bobina 0.30 mm ROJO tiene 0.000 kg disponibles (0.000 físicos menos 0.000 ya
> comprometidos) y el pedido necesita 89.606. Compra o abre una bobina de ese color y
> espesor antes de confirmar.

Pero cuando el toast se va, la pantalla vuelve a estar idéntica a antes: nada explica por
qué la cotización sigue emitida. Y el dato ya se sabía **al cotizar** — la propia línea
mostraba «0.000 kg disponibles — no alcanza» en rojo.

**Propuesta.** Que el detalle de la cotización muestre el faltante de materia prima como
aviso persistente (el `Alert` que ya usa para otras cosas) en vez de solo al chocar, y que
el botón de confirmar diga por qué no va a funcionar antes de intentarlo. Es (c) con mitad
(a): el dato ya viaja en el DTO que la pantalla recibe.

---

## 3. Flujo 2 — Despacho → comprobante → cobranza

### F2-01 — (b) **BLOQUEANTE**: con transporte, solo se pueden despachar líneas en kilos

**Qué pasa.** `apps/api/src/invoicing/dispatches.service.ts:243-250` exige `weightKg` por
línea cuando la modalidad no es recojo y la unidad de la línea no es `KGM`:

```ts
if (
  input.transferMode !== TransferMode.PICKUP &&
  item.weightKg === undefined &&
  target.unit !== Unit.KGM
) {
  throw new BadRequestException(
    `La línea ${orderItem.lineNumber} se despacha en ${target.unit}: indica el peso en kilos para la guía de remisión`,
  );
}
```

La regla es correcta y está bien razonada en el propio comentario (en una cobertura a
medida `reserveQty` son metros; heredarlo declararía 24.6 kg en la guía por 268 kg de
planchas). El problema es que **la pantalla nunca pide ese peso**:

- `grep -rn "weightKg" apps/web/src` no lo encuentra en
  `despachos/nuevo/nuevo-despacho-view.tsx`.
- El campo existe en el contrato: `packages/shared/src/schemas/invoicing.ts:637`,
  `weightKg` opcional por ítem.
- El detalle del despacho **ya lo muestra**: `despachos/[id]/despacho-detalle-view.tsx:303`.
- La tabla «Qué sale» del formulario tiene seis columnas (Producto, Material, Pedido, Ya
  despachado, Pendiente, A despachar) y un solo input, el de cantidad. No hay columna de
  peso ni scroll horizontal escondido (`scrollWidth === clientWidth`).

**Reproducción.** PED-000023, línea PL045ROJO (unidad `NIU`), modalidad «Transporte
privado (vehículo propio)», todos los demás campos completos → `POST /dispatches` devuelve
400 con el mensaje de arriba, **y no hay ningún campo en la pantalla donde escribir el
peso**. Cambiando la modalidad a «Recojo en mostrador (lo lleva el cliente)» el mismo
despacho pasa sin tocar nada más (DES-000001).

**Por qué la suite no lo vio.** Los E2E despachan por API:
`e2e/helpers/invoicing.ts:377,419` arman los ítems con `weightKg?: string` y lo mandan en
el payload. La pantalla nunca se ejerce en este punto.

**Alcance real.** Cualquier despacho con guía de remisión (privado o público) de una línea
en `NIU` o `MTR` — es decir, prácticamente todo lo que no sea venta de bobina por kilo.
Hoy la única salida desde la UI es declarar el despacho como recojo en mostrador, que es
mentira documental y además fuerza F2-03.

**Para Fase 8.** Agregar la columna de peso por línea en la tabla «Qué sale», con el valor
propuesto ya calculado (el formulario ya sabe proponer 268.817 kg para el total) y editable
con la báscula, igual que el peso bruto. **No se toca en esta sesión**: cambia el payload
que la pantalla manda al API.

### F2-02 — (a) Un botón deshabilitado y dos campos que parecen llenos y están vacíos

«Ubigeo de partida» y «Ubigeo de llegada» muestran `150101` y `150131` **en gris de
placeholder**: parecen valores razonables ya cargados, y están vacíos.

```js
// los dos inputs de ubigeo
{ value: "", placeholder: "150101" }
{ value: "", placeholder: "150131" }
```

`canSubmit` (`nuevo-despacho-view.tsx:226-236`) exige `/^\d{6}$/` en ambos, más dirección
de partida y llegada, peso bruto positivo y los cinco campos del conductor. El botón
«Despachar» queda gris sin decir qué falta, y los dos campos que faltan son justamente los
que parecen completos.

**Propuesta (barata).** Marcar los campos obligatorios, y que el botón deshabilitado diga
qué falta (título o texto de ayuda debajo). Los ubigeos, además, deberían venir con valor
por defecto real en vez de placeholder — el de partida es siempre el almacén.

Nota menor del mismo bloque: esos inputs no tienen `aria-label` ni `id` asociado al
`<label>`; el árbol de accesibilidad los identifica por su placeholder.

### F2-03 — (c) En recojo, el peso bruto que se escribió se descarta en silencio

Con «Recojo en mostrador», `dispatches.service.ts:254-259` fija el peso de cada línea en
cero a propósito (bien razonado: sin guía, copiar la cantidad escribiría «3 kg» por tres
planchas). Pero el formulario **sí pidió y aceptó** «Peso bruto total (kg) = 268.817», y el
despacho resultante muestra `Peso bruto 0.000 kg` y `Peso 0.000 kg` en la línea. El usuario
escribió un dato que el sistema tiró sin avisar.

**Propuesta.** Cuando la modalidad es recojo, deshabilitar el campo de peso bruto con una
nota de por qué (igual que ya se hace con «Vencimiento» cuando la condición es contado).

### F2-04 — (a) Selects que se encogen dentro de celdas enormes

En `/comprobantes/nuevo`, «Tipo» (~60 px) y «Condición de pago» (~70 px) viven en celdas de
un grid de tres columnas de ~400 px cada una; «Unidad» hace lo mismo en la fila de línea.
El resultado es una pantalla que se lee como un formulario a medio construir: controles
diminutos flotando en columnas vacías.

**Propuesta (B1/B3).** Que los `SelectTrigger` de formulario ocupen el ancho de su celda,
como los `Input`.

### F2-05 — cobranzas

Sin hallazgos propios más allá de T-06 (rojo en cero) y T-08 (sin sort). El agrupado por
cliente y el listado de comprobantes con saldo se leen bien y las filas ya son de una sola
línea.

---

## 4. Flujo 3 — Compra → ingreso de bobinas → kardex

La cadena se verificó sobre los datos existentes (10 compras, 7 bobinas) y sobre los
movimientos que generó la OP cerrada en esta sesión: `/kardex` muestra la salida de
`GIANCA-ALZ-ROJO-3002-0.45-5000-3` por 268.820 kg («Rolado de OP-000007: 10 × 6.00 m»), la
entrada de 10 u de `PL045ROJO` y la salida por el despacho DES-000001. La trazabilidad de
S9 funciona.

### F3-01 — (a) El texto de kardex se corta contra el borde

La columna «Motivo / usuario» es la última y se trunca con `…` pegada al filo del
contenedor (ver T-09). Es la columna que más se necesita leer entera cuando se audita un
movimiento.

**Propuesta.** Respiro lateral en la tabla, y el motivo completo en `title` (o el mismo
`InfoPopover` de D-178) para las filas largas.

### F3-02 — (b) La pestaña «Disponibles» filtra por saldo, no por estado

`/bobinas` → «Disponibles» manda `availability=available` + `statusNe=IN_THIRD_PARTY`
(`bobinas-view.tsx:91-94`), sin filtrar por estado. En la base local aparecen ahí tres
bobinas marcadas **«Cerrada»** con todo su peso como disponible:

```
GIANCA-ALZ-3020-0.34-3840-7       CLOSED  3840.000
GIANCA-ALZ-ROJO-3002-0.40-3840-4  CLOSED  3840.000
GIANCA-ALZ-ROJO-3002-0.45-3840-5  CLOSED  3840.000
```

Son datos de `ayr_local` anteriores a D-164, así que **no es prueba de un defecto en el
código de cierre**. Lo que sí es una pregunta de dominio: si una bobina cerrada con saldo
debe seguir apareciendo como disponible, o si «Disponibles» tendría que excluir `CLOSED`.
Queda para Fase 8, junto con la pregunta hermana de si puede existir una bobina `CLOSED`
con saldo después de D-164.

---

## 5. Flujo 4 — POS Mostrador

No se pudo ejercer una venta: después del despacho de esta sesión la base local quedó sin
producto terminado con saldo, y el mostrador solo vende lo que está en stock. Se inspeccionó
la pantalla y la caja.

### F4-01 — (a) El vacío inicial miente

Con el buscador todavía vacío, la pantalla ya dice **«No hay productos con saldo disponible
para esa búsqueda»**. No hubo búsqueda. El estado inicial debería invitar («Busca un
producto por código o nombre») y reservar ese mensaje para cuando una búsqueda real no
devuelva nada.

### F4-02 — CORREGIDO: el reparto del ancho está bien

**Lo que se anotó primero, y era falso.** «El carrito queda en una columna de ~270 px».
Salió de medir sobre una captura de 1568 px de ancho que representaba un viewport de
2133 px: los píxeles de la imagen se leyeron como píxeles CSS. El carrito es
`lg:grid-cols-[1fr_24rem]` (`pos-view.tsx:258`), o sea **384 px CSS**, que es un ancho
razonable para un panel de venta, y a 1366 px la pantalla no desborda
(`documentElement.scrollWidth - clientWidth === 0`, medido).

Queda anotado en vez de borrado porque es exactamente el error contra el que sirve medir:
una captura escalada no es una medida. Lo único cierto del hallazgo original es F4-01 —el
área de productos está vacía hasta que alguien busca—, y eso es un problema de estado
vacío, no de reparto de ancho.

---

## 6. Flujo 5 — Importador de cotizaciones

### F5-01 — (a) El selector de archivo sale sin estilo

El paso «1. El archivo» renderiza un `<input type="file">` nativo dentro de una caja con
borde: se lee «Seleccionar archivo Ningún archivo seleccionado» en la tipografía del
sistema, sin relación con el resto de la UI. Es la primera pantalla de un flujo que el
dueño usa con datos reales.

**Propuesta.** Un `Input` estilado + botón, o el patrón de dropzone que ya se usa en
`/bobinas/nueva-xml` (verificar cuál de los dos es).

### F5-02 — contexto ya documentado, sin hallazgo nuevo

Los tres pendientes del importador que ya están en `docs/PROGRESO.md` (el campo editable es
el unitario y no el importe; la edición de precio que rompe la coincidencia con el papel sin
avisar) siguen vigentes y **no** se vuelven a levantar acá para no duplicar la lista.

---

## 7. Qué entra en qué bloque de la Fase 2

**B1 — densidad y tipografía (no se sacrifica)**

- T-01 (fuente), T-03 (listas), T-04 (`StatStrip`), T-09 (respiro de tablas), F2-04
  (selects de formulario al ancho de su celda).

**B2 — robustez 1366–1920**

- T-07 (menú más alto que la pantalla) y la verificación de que ninguna tabla ni grid se
  rompe entre 1366 y 1920 con la ventana a media pantalla. (F4-02 se cayó al medirlo: ver
  arriba.)

**B3 — fixes baratos (a) de esta inspección**

- T-02 (toast a `bottom-right`), F1-01 (títulos de planta/producción), F1-02 (botones de
  cierre de orden), F1-03 («por» huérfano), F2-02 (obligatorios del despacho), F4-01 (vacío
  del mostrador), F5-01 (input de archivo).

**Fase 3 — color**

- T-05 (escala semántica de estados), T-06 (rojo decorativo en cobranzas).

**Fase 8 — no se toca en esta sesión**

- **F2-01** (peso por línea en el despacho: es el importante), F2-03 (peso descartado en
  recojo), F3-02 (qué significa «Disponible» para una bobina cerrada), T-08 (extender el
  sort a las listas que quedaron afuera), F1-04 (aviso persistente de materia prima
  faltante, si se decide que es más que UI).
