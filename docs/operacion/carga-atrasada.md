# Carga atrasada de operaciones

Cómo cargar de golpe semanas de operaciones con fecha atrasada (respuesta del dueño a A2-01, 20/10/2026). El cliente
trabajó por fuera desde mediados de octubre y va a cargar todo cuando vuelva a la app:

- **ventas:** siguen en el otro sistema de facturación y entran por el importador de cotizaciones;
- **compras:** se registran o importan con su fecha, desde sus comprobantes;
- **producción:** está en Excel.

Desde cc64 (D-705) todo eso entra con un solo plan de carga en Excel y dos comandos: `pnpm carga:revisar` lo revisa
contra la base sin escribir nada y `pnpm carga:ejecutar` lo carga por los servicios de la app. `pnpm carga:revertir`
deshace un lote (D-706). Lo único que sigue a mano es la producción de drywall.

## Cómo llenar el plan de carga

Pide la plantilla con `pnpm carga:revisar --plantilla plan-de-carga.xlsx`. Trae una hoja «Instrucciones» y una hoja por
tipo de operación. Los encabezados no se cambian. Las columnas que una fila no usa quedan vacías. Las fechas van como
fecha de Excel, en AAAA-MM-DD o en DD/MM/AAAA.

Necesitas tres fuentes: la exportación del sistema de facturación, el Excel de producción y los comprobantes de
compra. Los clientes y proveedores conviene que ya existan en la app (ver «Clientes nuevos», más abajo).

### Compras ← comprobantes de compra

Una fila por línea del comprobante. Las filas de un mismo comprobante repiten la cabecera. Las columnas son las del
importador de compras, más una:

| Columna                                                            | De dónde sale                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| TIPO DE COMPRA                                                     | BOBINAS, PRODUCTO TERMINADO o SERVICIO                                |
| LÍNEA DE NEGOCIO                                                   | ALUZINC, DRYWALL, UPVC o REVENTA                                      |
| TIPO DE COMPROBANTE, SERIE-NÚMERO, FECHA DE EMISIÓN                | el comprobante del proveedor                                          |
| RUC PROVEEDOR                                                      | el comprobante; el proveedor tiene que existir o estar en el padrón   |
| MONEDA, TIPO DE CAMBIO, CONDICIÓN DE PAGO, DÍAS DE CRÉDITO         | el comprobante                                                        |
| SKU, DESCRIPCIÓN, CANTIDAD, UNIDAD, PRECIO UNITARIO SIN IGV        | cada línea (producto terminado)                                       |
| CÓDIGO DE ACABADO, COLOR, ESPESOR MM, ANCHO MM, KG, CÓDIGO EXTERNO | cada bobina; el **código externo** es como se la nombra en Producción |
| **FECHA DE RECEPCIÓN**                                             | el día en que entró al almacén (la guía de remisión del proveedor)    |

### Ventas ← exportación del sistema de facturación

Se pega **tal cual** el export que ya lee el importador de cotizaciones: una fila por línea del comprobante, con
`F. EMISIÓN`, `SERIE - NÚMERO`, `CLIENTE` (RUC o DNI, guion, nombre), `CÓDIGO PRODUCTO`, `CANTIDAD`, `VALOR DE VENTA`,
`IGV` y `PRECIO DE VENTA`. Las notas de crédito del export se saltan solas, con aviso; también las «NOTA DE VENTA»,
igual que en el importador de cotizaciones. Al final van tres columnas opcionales:

| Columna           | Cuándo                                 | Qué va                                                                                            |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| LARGOS            | **obligatoria** en las líneas a medida | el plan de corte, en metros por piezas: `4.5x10; 3x8`. Tiene que sumar la CANTIDAD                |
| CONDICIÓN DE PAGO | opcional                               | CONTADO o CRÉDITO. Vacía: el plazo del cliente (con días de crédito, crédito; sin ellos, contado) |
| VENCIMIENTO       | opcional, solo en crédito              | la fecha de vencimiento del comprobante; vacía: emisión + días del cliente                        |

La condición y el vencimiento son del comprobante: se leen de su **primera fila**. Si las demás filas dicen otra cosa,
no cuentan.

### Producción ← Excel de producción

Una fila por parte.

| Columna         | Qué va                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| SERIE - NÚMERO  | la venta (el comprobante) de la que es la OP                                                                    |
| FECHA           | el día del parte                                                                                                |
| CÓDIGO PRODUCTO | el SKU vendido                                                                                                  |
| CANTIDAD        | planchas, o metros si es a medida o accesorio. En a medida se toman las piezas que faltan del plan, en su orden |
| CÓDIGO BOBINA   | el código de la bobina, o el código externo de una bobina de la hoja Compras                                    |
| KG CONSUMIDOS   | lo que consumió el parte de esa bobina                                                                          |

- **La OP se cierra sola con el parte que completa el plan (D-573).** Si el plan no se completa, queda abierta y el
  informe lo dice. Producir más de lo vendido es un error de la revisión: el cargador no puede.
- **Una bobina está en una sola OP abierta a la vez.** Si el Excel la usa en otra OP mientras la primera sigue abierta
  (no se completó su plan), la revisión lo marca como error: la app no baja una bobina con kg consumidos. Ordena los
  partes para que la OP anterior se cierre antes, o usa otra bobina.
- **Sin CÓDIGO BOBINA** la OP tiene que tener ya una bobina montada; la revisión lo avisa.

**Drywall se carga a mano.** Sus partes salen de flejes de un corte que el plan no trae. El cargador y la revisión
marcan esas filas como «se carga a mano» y no las ejecutan. En qué punto del orden:

1. corre `pnpm carga:ejecutar … --hasta pedidos`: entran las compras (las bobinas) y las ventas, y al confirmar los
   pedidos nacen las OP de drywall;
2. registra **a mano**, con su fecha, el corte (partido o tercerizado) y los partes y cierres de las OP de drywall;
3. corre otra vez `pnpm carga:ejecutar …` con el mismo lote: sigue con el resto de la producción, los despachos, los
   comprobantes y los cobros.

### Despachos ← guías de remisión o el registro de salidas

Una fila por producto despachado: `SERIE - NÚMERO`, `FECHA`, `CÓDIGO PRODUCTO` y `CANTIDAD`. Las filas de una misma
venta, fecha y destino van en un solo despacho.

| Columna                   | Qué va                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------- |
| MODALIDAD                 | RECOJO o ENTREGA. Vacía: se carga como recojo, y la revisión lo avisa fila por fila |
| DIRECCIÓN DESTINO, UBIGEO | obligatorias con ENTREGA (ubigeo de 6 dígitos)                                      |

Una entrega se registra con su destino real y sin datos de transporte: la guía con el vehículo y el conductor la emitió
el otro sistema. En el ERP figura como recojo, con la nota «entrega (guía del otro sistema)» (D-707).

### Cobros y Pagos ← estado de cuenta o recibos

- **Cobros:** `SERIE - NÚMERO` de la venta, `FECHA`, `MONTO`, `MEDIO DE PAGO` y `REFERENCIA`.
- **Pagos:** `RUC PROVEEDOR`, `SERIE-NÚMERO` de la compra, `FECHA`, `MONTO`, `MEDIO DE PAGO` y `REFERENCIA`.

Un medio de pago que la app no conoce se registra como «Otro», con aviso.

### Clientes nuevos

Un cliente de la hoja Ventas que no está en la app se da de alta **desde el padrón al cargar** (consulta externa), como
hace el importador de cotizaciones. La revisión lo avisa fila por fila. Si prefieres revisarlo antes, créalo a mano en
la app.

## Antes de cargar: `pnpm carga:revisar`

`pnpm carga:revisar --archivo plan-de-carga.xlsx [--fecha-carga AAAA-MM-DD]`. Contra producción hace falta además
`--branch production --confirm-production`. Es de solo lectura.

La revisión dice, sin escribir nada:

- qué salida dejaría un ítem en negativo en alguna fecha (D-652/D-662), con la primera fecha válida;
- cuántas filas recostearía cada movimiento y si alguno pasa el tope de 500;
- qué comprobante queda fuera de la ventana de emisión de 90 días, o cerca de ella;
- fechas futuras o anteriores al inicio de la carga histórica, SKU o bobinas que no existen, despachos o cobros de
  más;
- desde cc64: líneas a medida sin LARGOS, condición o vencimiento inválidos, entregas sin destino, bobinas usadas en
  dos OP abiertas, producción de más, partes de drywall («se carga a mano»), clientes nuevos y medios de pago
  desconocidos.

El informe queda en `local-data/carga-atrasada/`. Con errores, el comando termina en 2: no se carga hasta corregirlos.

## Orden de carga

Decisión del dueño (20/10/2026). El cargador lo sigue solo.

1. **Compras:** alta y recepción, con su fecha.
2. **Ventas:** importar las cotizaciones y confirmar los pedidos. La OP de lo que se fabrica nace al confirmar.
3. **Producción:** partes y cierres de OP, con su fecha de operación.
4. **Despachos**, con su fecha.
5. **Comprobantes manuales**, con la serie, el número y la fecha del otro sistema.
6. **Cobros y pagos.**

**Dentro de cada paso, de la fecha más antigua a la más nueva.** No cambia el resultado, pero sí cuánto se recostea: un
despacho del 15 cargado después de uno del 19 recostea todo lo posterior del producto (lo mostró el ensayo de cc63).

El Excel de saldos iniciales (cc62) va **al final de todo**, cuando el cliente vuelva a usar la app. Su fecha de corte
podrá moverse a ese día.

## Cargar con `pnpm carga:ejecutar`

1. **Revisa:** `pnpm carga:revisar --archivo plan.xlsx`. Con errores no se carga.
2. **Mira lo que haría:** `pnpm carga:ejecutar --archivo plan.xlsx --lote <nombre>`. Es un dry-run por defecto: muestra
   cuántas operaciones hay por paso y cuáles ya están hechas en ese lote. El lote es un nombre tuyo, por ejemplo
   `octubre-2026`.
3. **Carga:** el mismo comando con `--execute`. La primera vez corre antes la revisión: con un solo error no escribe
   nada. Carga en el orden de arriba y, dentro de cada paso, por fecha. Contra producción hace falta además
   `--branch production --confirm-production` y **el OK del dueño por nombre para ese lote** (D-460).
4. **Si se corta o falla:** se detiene en la primera fila que falle y deja un informe en `local-data/carga-atrasada/`
   con la fila, el motivo y lo hecho hasta ahí. Corrige el problema en la base (no en el archivo: la huella tiene que
   ser la misma) y vuelve a correr el mismo comando con el mismo lote. Sigue desde donde quedó y no duplica nada.
5. **Si el archivo tenía un error de datos:** revierte el lote, corrige el archivo y cárgalo con **otro** `--lote`. Un
   lote revertido no se vuelve a cargar.
6. **Al terminar:** si el informe dice que quedaron recosteos pendientes, corre `pnpm recosteo:pendientes` con la app
   sin usuarios.

Cada lote deja su registro en la auditoría (`backdated_load_batches`): la huella del archivo y una anotación por
operación con lo que creó. No hay tablas nuevas.

## Revertir con `pnpm carga:revertir`

`pnpm carga:revertir --lote <nombre>` (dry-run) y con `--execute`. Deshace lo que hizo el lote, de la última operación
a la primera, con las reversas de la app. Los pasos son:

1. revierte cobros y pagos;
2. anula los comprobantes;
3. revierte los despachos;
4. reabre las OP **que cerró ese mismo lote** (D-706) y revierte sus partes;
5. anula las OP, los pedidos, las cotizaciones y las compras.

- Lo que el lote encontró ya hecho (adoptado) no se toca.
- Si se corta, se vuelve a correr: salta lo que ya revirtió.
- **Lo cargado a mano no lo revierte.** Si hubo drywall cargado a mano, revierte primero a mano sus partes y su corte;
  si no, la reversa de las compras o de los pedidos se rechaza.
- Las reversas quedan fechadas **hoy** en el kardex (append-only, regla 8), no en la fecha de la operación.
- Un comprobante anulado conserva su número. Si se vuelve a cargar con otro lote, ese comprobante se reactiva a mano
  (D-373).

## Riesgos que hay que saber antes de la carga real

- **Ventana de 90 días de la emisión (D-072/D-210).** Un comprobante manual o una NC se pueden registrar hasta 90 días
  después de su emisión. Lo más antiguo de esta carga es del 14/10/2026: **se puede registrar hasta el 12/01/2027.**
  Pasado ese día, esos comprobantes ya no entran. El tope no se cambia (decisión del dueño). La revisión lo avisa 15
  días antes.
- **Montar o liberar una bobina queda con la fecha de hoy.** No toca el kardex, solo el evento de la bobina.
- **El pedido y la OP no llevan fecha de negocio.** Su fecha de confirmación es la real del día de la carga. El Panel
  y los reportes de venta leen la emisión del comprobante o de la cotización, así que sus cifras del mes no cambian. Las
  pantallas de planta van por estado, no por fecha.
- **Recosteos de más de 500 filas** quedan pendientes, con aviso en el log y en Inventario para ADMINISTRADOR. Se
  completan con `pnpm recosteo:pendientes` (dry-run y después `--execute`).
- **Salida de bobina antes de su ingreso (D-375):** una bobina no puede consumirse antes de su primera entrada. La
  revisión lo marca como negativo.

## Ensayo del cargador en demo (cc64, 21/10/2026)

- **Demo:** restablecida desde producción con el OK del dueño (D-227) y levantada con build de producción.
- **Plan:** el lote sintético de cc63 (30 compras, 150 ventas, 60 partes, 155 despachos, 150 comprobantes y 150
  cobros) en la plantilla de cc64, con LARGOS, MODALIDAD y 10 entregas. Sin datos reales en el repo.
- **Medición:** desde la PC a la rama `demo` de Neon. En producción la API está en Cloud Run, más cerca de la base.

**Lo que se probó:**

- **Corte y reanudación:** la primera corrida se cortó a mano a los 10 minutos. Al volver a correrla saltó lo hecho
  (152 operaciones) y siguió.
- **Parada en la fila que falla:** se detuvo en un parte que usaba una bobina montada en otra OP abierta, con la fila
  y el motivo. De ahí salió la regla de la revisión «una bobina en una sola OP abierta».
- **Reversa de un lote a medias:** 331 operaciones en 24 min (1426,6 s). Los reportes volvieron al céntimo a la foto
  de antes.
- **Carga completa del plan corregido:** 845 operaciones, 0 fallas, **1 h 47 min** (6415,4 s), lo mismo que la carga
  por la API de cc63.
- **Sin duplicados:** volver a correr el lote completo saltó las 845 operaciones en menos de un segundo.
- **Reversa del lote completo:** 845 operaciones en **1 h 9 min** (4159,0 s). Ventas y margen, cuentas por cobrar,
  inventario valorizado y `check:balances` volvieron al céntimo a la foto de antes, sin recosteos pendientes.

**Al final cuadraba todo al céntimo con cc63:**

- **Ventas y margen** del 14 al 20/10: S/ 120 178,00 sin IGV.
- **Cuentas por cobrar** del lote: S/ 12 564,64.
- **Kardex:** `check:balances` sin diferencias nuevas (las 2 de A2-05, que ya venían de producción).
- **Recosteos pendientes:** 0.

### Límites

- La revisión no simula el consumo de componentes de drywall por receta (`ProductBom`): solo la bobina indicada y el
  producto. El drywall se carga a mano.
- Los recosteos que estima la revisión son un piso: no cuenta los ajustes ya escritos ni la cascada fuera del lote.
- `pnpm recosteo:pendientes` bloquea los ítems que recostea mientras corre, también en dry-run: se corre sin usuarios en
  la app.
- La carga se corre sin usuarios en la app: toma bobinas, pedidos y OP del lote mientras avanza.
