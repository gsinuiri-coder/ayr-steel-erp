# Carga atrasada de operaciones

Cómo cargar de golpe semanas de operaciones con fecha atrasada (respuesta del dueño a A2-01, 20/10/2026). El cliente
trabajó por fuera desde mediados de octubre y va a cargar todo cuando vuelva a la app:

- **ventas:** siguen en el otro sistema de facturación y entran por el importador de cotizaciones;
- **compras:** se registran o importan con su fecha, desde sus comprobantes;
- **producción:** está en Excel y se registra a mano en la app con fecha atrasada.

## Antes de cargar: `pnpm carga:revisar`

1. Pide la plantilla: `pnpm carga:revisar --plantilla plan-de-carga.xlsx`. Trae una hoja de instrucciones y una hoja
   por tipo de operación.
2. Llena el plan.
   - **Compras:** las columnas del importador de compras, más `FECHA DE RECEPCIÓN`. Una bobina nueva se nombra por su
     `CÓDIGO EXTERNO`.
   - **Ventas:** el export del sistema de facturación, tal cual (el mismo archivo que lee el importador de
     cotizaciones). La `SERIE - NÚMERO` es también la del comprobante manual.
   - **Producción:** por venta (`SERIE - NÚMERO`), con la fecha del parte, el producto y su cantidad, la bobina y los kg
     consumidos.
   - **Despachos y Cobros:** por venta.
   - **Pagos:** por compra (RUC y `SERIE-NÚMERO`).
3. Revísalo contra la base: `pnpm carga:revisar --archivo plan-de-carga.xlsx [--fecha-carga AAAA-MM-DD]`. Contra
   producción hace falta además `--branch production --confirm-production`. Es de solo lectura.

La revisión dice, sin escribir nada:

- qué salida dejaría un ítem en negativo en alguna fecha (D-652/D-662), con la primera fecha válida;
- cuántas filas recostearía cada movimiento y si alguno pasa el tope de 500;
- qué comprobante queda fuera de la ventana de emisión de 90 días, o cerca de ella;
- fechas futuras o anteriores al inicio de la carga histórica, SKU o bobinas que no existen, despachos o cobros de
  más.

El informe queda en `local-data/carga-atrasada/`. Con errores, el comando termina en 2: no se carga hasta corregirlos.

## Orden de carga

Decisión del dueño (20/10/2026).

1. **Compras:** alta y recepción, con su fecha.
2. **Ventas:** importar las cotizaciones y confirmar los pedidos. La OP de lo que se fabrica nace al confirmar.
3. **Producción:** partes y cierres de OP, con su fecha de operación (la retrofecha actual).
4. **Despachos**, con su fecha.
5. **Comprobantes manuales**, con la serie, el número y la fecha del otro sistema.
6. **Cobros y pagos.**

La reventa (lo que se compra y se vende sin fabricar) puede ir en cualquier punto después de las compras.

**Dentro de cada paso, de la fecha más antigua a la más nueva.** No cambia el resultado, pero sí cuánto se recostea: un
despacho del 15 cargado después de uno del 19 recostea todo lo posterior del producto (lo mostró el ensayo).

El Excel de saldos iniciales (cc62) va **al final de todo**, cuando el cliente vuelva a usar la app. Su fecha de corte
podrá moverse a ese día.

## Riesgos que hay que saber antes de la carga real

- **Ventana de 90 días de la emisión (D-072/D-210).** Un comprobante manual o una NC se pueden registrar hasta 90 días
  después de su emisión. Lo más antiguo de esta carga es del 14/10/2026: **se puede registrar hasta el 12/01/2027.**
  Pasado ese día, esos comprobantes ya no entran. El tope no se cambia (decisión del dueño). La revisión lo avisa 15
  días antes.
- **Montar o liberar una bobina queda con la fecha de hoy.** No toca el kardex, solo el evento de la bobina.
- **El pedido no lleva fecha de negocio.** Su fecha de confirmación es la real del día de la carga. Los reportes de
  venta leen la emisión del comprobante, así que no cambia las cifras.
- **Recosteos de más de 500 filas** quedan pendientes, con aviso en el log y en Inventario para ADMINISTRADOR. Se
  completan con `pnpm recosteo:pendientes` (dry-run y después `--execute`).
- **Salida de bobina antes de su ingreso (D-375):** una bobina no puede consumirse antes de su primera entrada. La
  revisión lo marca como negativo.

## Ensayo en demo (cc63, 20/10/2026)

- **Demo:** restablecida desde producción con el OK del dueño (D-227) y levantada con build de producción, desacoplada
  de Claude Code.
- **Lote sintético:** 30 compras (20 de reventa y 10 de bobinas), 150 ventas (100 de reventa y 50 de planchas), 60
  partes, 150 despachos, 150 comprobantes manuales y 150 cobros.
- **Fechas:** el volumen de unas 4 semanas comprimido entre el 14/10 y el 20/10, porque no se pueden usar fechas
  futuras.
- **Origen:** se cargó por la API, sin datos reales en el repo.
- **Medición:** desde la PC a la rama `demo` de Neon. En producción la API está en Cloud Run, más cerca de la base, así
  que estos tiempos son una cota alta.

**Revisión previa (`carga:revisar`):** 355 movimientos de kardex, 0 negativos y 0 errores. Dio 272 recosteos con un
máximo de 81 filas, ninguno cerca del tope. Los recosteos venían de cargar los despachos en el orden de las ventas y no
por fecha: de ahí la regla «de la fecha más antigua a la más nueva».

**Carga real, en el orden documentado:** 0 rechazos.

| Paso                                | Llamadas | Tiempo total | Promedio | Máximo |
| ----------------------------------- | -------- | ------------ | -------- | ------ |
| Compras (alta y recepción)          | 60       | 3 min        | 3,0 s    | 5,5 s  |
| Ventas: importar (3 archivos de 50) | 6        | 6 min        | 62 s     | 130 s  |
| Ventas: confirmar                   | 150      | 20,5 min     | 8,2 s    | 16,3 s |
| Producción: montar bobina           | 52       | 7 min        | 7,9 s    | 13,1 s |
| Producción: parte                   | 10       | 2 min        | 13,6 s   | 16,5 s |
| Producción: parte y cierre          | 51       | 15 min       | 18,1 s   | 28,2 s |
| Despachos                           | 150      | 17,5 min     | 7,0 s    | 16,4 s |
| Comprobantes (borrador y registro)  | 300      | 24,5 min     | 4,9 s    | 16,7 s |
| Cobros                              | 150      | 9 min        | 3,6 s    | 8,7 s  |

El sistema procesó todo en **1 h 45 min de tiempo de máquina**. Ninguna operación del día pasó de 30 s. La más cercana
fue el parte con cierre (28 s), cuyo tope es 60 s.

**Al final cuadraba todo al céntimo:**

- **Ventas y margen** del 14 al 20/10: S/ 120 178,00 sin IGV, que es lo facturado (S/ 141 810,04) ÷ 1,18. Los 150
  comprobantes tienen costo.
- **Cuentas por cobrar:** S/ 12 564,64, igual a lo facturado menos lo cobrado.
- **Inventario valorizado:** S/ 514 983,36, igual a la suma de los saldos.
- **Kardex:** `check:balances` da todos los saldos iguales en cantidad. Las únicas diferencias de valor son los S/ 0,31
  de 2 bobinas que ya venían de producción (A2-05).
- **Recosteos pendientes:** 0.

**Encontrado en el ensayo:** el cierre de una OP con fecha atrasada se rechazaba aunque se hubiera confirmado la
retrofecha (D-701, corregido). Sin esa corrección, la carga de producción se trababa.

**Recosteo a escala (RC-02):** un ítem con 100, 250 y 490 filas posteriores se recostea en línea en 2,9 s, 3,1 s y
3,3 s. Un pendiente de 1000 filas se completa con `recosteo:pendientes` en 3,3 s.

### Esfuerzo de la carga a mano

Pasos por venta en la pantalla:

- **Reventa:** confirmar la cotización, despachar, crear el comprobante y registrar su número, cobrar. Son unos 4–5
  minutos.
- **Plancha:** además, montar la bobina y registrar los partes con su cierre. Son unos 7–8 minutos.
- **Compra:** alta con sus líneas y recepción, unos 4 minutos. Con el importador de compras es menos.

Para el volumen del ensayo (≈ 4 semanas): 100 × 4,5 + 50 × 7,5 + 30 × 4 ≈ **945 minutos, unas 16 horas de trabajo**,
a las que se suman las esperas de la pantalla. Es pesado y propenso a errores de orden. **Propuesta para una pieza
siguiente:** un cargador que ejecute el mismo plan de carga (`pnpm carga:ejecutar`). Correría primero `carga:revisar`,
cargaría paso a paso por los servicios de dominio y en el orden documentado, retomaría desde donde quedó y dejaría
cada fila enlazada con lo que creó. El formato del archivo ya está pensado para eso.

### Límites de la revisión

- No simula el consumo de componentes de drywall por receta (`ProductBom`): solo la bobina indicada y el producto.
- Los recosteos que estima son un piso: no cuenta los ajustes ya escritos ni la cascada fuera del lote.
- `pnpm recosteo:pendientes` bloquea los ítems que recostea mientras corre, también en dry-run: se corre sin usuarios en
  la app.
