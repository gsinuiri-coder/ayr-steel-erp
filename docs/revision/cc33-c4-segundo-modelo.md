# Revisión de segundo modelo — cc33 corte 4

Modelo: Sonnet, contexto limpio. Commit `10283096` (`origin/cc33-c4`). Revisión por lectura; no
corrió tests. Sin P0.

## Hallazgos

- **P1-1.** El Excel de la lista de comprobantes (`fiscal-documents-xlsx.ts:31`) seguía diciendo
  «Contado» para un crédito sin vencimiento, contra la pantalla.
- **P2-1.** `PURCHASE_NUMBER_PATTERN` aceptaba números sin letras ni dígitos (`-`, `//`).
- **P2-2.** El choque con una compra vieja con ceros se comprueba sin bloqueo: dos altas
  concurrentes `12` y `012` contra una `00012` vieja pasarían las dos. Exige dato viejo y
  concurrencia: el riesgo es bajo.
- **P2-3.** Quitar ceros a números alfanuméricos (`0A12` → `A12`, `007/1` → `7/1`) cambia el número
  del papel. Hay que confirmar si aplica solo a números de dígitos.
- **P2-4.** El XML rechaza ahora `E001-1.234` o un número con espacio. Es lo que pide B8.
- **P3-1.** Editar una recibida enviando por API el mismo número con ceros lo reescribe sin ellos.
- **P3-2.** `isCalendarDate` no pone rango de años (igual que `operationDateSchema`).
- **P3-3.** Los formularios web validan solo el formato de la fecha.

## Verificado sin hallazgos

- Las fechas de ventas y de comprobantes usan schemas locales que no se tocaron.
- `parseCalendarDate` rechaza `2026-09-31` también en cotizaciones e inventario inicial, que es lo
  buscado.
- La transformación de `documentNumberSchema` es segura con `.optional()`.
- `splitDocumentNumber` es coherente.
- `creditWithoutDueCount` es correcto.
- No hay efectos fuera de compras.

## Qué se hizo con cada hallazgo

| Hallazgo | Resolución                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1     | Corregido: `noDueDateLabel(d.paymentTerms)` y un test de la columna.                                                                                                                                |
| P2-1     | Corregido: el patrón exige al menos una letra o un dígito.                                                                                                                                          |
| P2-2     | Aceptado y registrado (D-538). Hoy hay 9 compras vivas con ceros y ningún choque; nada vuelve a escribir números con ceros. Un advisory lock sería un camino de bloqueo nuevo fuera de la regla 17. |
| P2-3     | Corregido (D-538, provisional): los ceros se quitan solo si el número es todo dígitos. Es lo que menos cambia y es el ejemplo del dueño (`F001-00012` = `F001-12`).                                 |
| P2-4     | Sin cambio: es la decisión B8 («si no puede leer el número, lo rechaza»).                                                                                                                           |
| P3-1     | Sin cambio: solo por API, y es una edición explícita del número.                                                                                                                                    |
| P3-2     | Sin cambio (no es una regresión).                                                                                                                                                                   |
| P3-3     | Sin cambio: los campos son `<input type="date">`, que no dejan escribir un día inexistente; el servidor rechaza con su mensaje.                                                                     |
