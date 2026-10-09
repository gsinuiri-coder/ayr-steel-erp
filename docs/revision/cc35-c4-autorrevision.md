# Autorrevisión (no es un pase cruzado)

**Entrega:** cc35, corte 4 — accesorio en el modelo M (D-559, provisional).
**Diff:** `origin/cc35-c3...origin/cc35-c4` (HEAD `19dc8c23`).
**Revisor:** subagente que no leyó el handoff de implementación. Esto es una lista de riesgos, no
una aprobación.
**Corrido:** `pnpm --filter @ayr/web exec vitest run src/lib/accessory-blocks.spec.ts` → 4/4 verdes.
No se corrieron E2E ni servidores.

Las líneas citadas son de `apps/web/src/app/(app)/planta/produce-accessory.tsx` salvo que se diga
otra cosa.

---

## P1

### P1-1. La clave por contenido se reutiliza después de un éxito: un segundo parte idéntico se pierde en silencio

- **Dónde:** `keys` (l. 117), `keyFor` (l. 141-149), `bodyOf` (l. 165). El mapa
  huella → clave nunca se vacía después de un 2xx.
- **Servidor:** `report()` reclama la clave con `claimIdempotencyKey(tx, 'roofing-report', …)`; si
  ya existe devuelve `claimed: false` y la transacción termina **sin efecto**, pero responde 200
  con la orden (`apps/api/src/production/roofing-production.service.ts` ~l. 992;
  `apps/api/src/common/idempotency.ts`).
- **Escenario:** misma sesión de pantalla, misma fecha. El supervisor registra 10 m de la bobina A
  (sin piezas ni kilos). Más tarde, en la misma bobina, registra otros 10 m. El cuerpo es
  idéntico → misma clave → el API responde 200 sin crear nada. La pantalla dice «producción
  registrada» y borra el bloque. Con metros redondos y una bobina por orden, es fácil que pase.
- **Arreglo:** borrar la huella del mapa en cuanto el POST responde bien (la clave solo debe
  sobrevivir a un reintento tras error o corte de red). Mejor aún: generar la clave al editar el
  bloque y guardarla junto con el bloque (ver P1-2).

### P1-2. Un refresco o un cambio de orden a mitad de la serie duplica partes

- **Dónde:** `sendReports` (l. 169-202). Los bloques enviados se sacan de `edits` (y por el
  efecto de l. 104-106, de `localStorage`) **recién al terminar todo el bucle y la relectura**
  (l. 192-199). Las claves viven solo en memoria (`useRef`, l. 117).
- **Escenarios:**
  1. Tres bobinas. El bloque 1 se registra; mientras viaja el 2, el supervisor recarga (F5) o se
     cae el navegador. `localStorage` sigue con los tres bloques. Al volver, «Registrar» manda otra
     vez el bloque 1 con una clave nueva → parte duplicado en kardex.
  2. Lo mismo al cambiar de pestaña de orden mientras «Registrando…»: el panel tiene
     `key={active.orderId}` y se desmonta; el bucle **sigue mandando** los bloques restantes (la
     promesa no se cancela) pero el `setEdits` final cae sobre un componente desmontado, así que
     `localStorage` conserva todo lo ya enviado. Al volver a la orden, los bloques reaparecen y se
     pueden volver a registrar. Los botones del panel están deshabilitados con `busy`, pero el
     selector de órdenes (`OrderPicker`) no.
  3. Corte de red con el parte ya grabado en el servidor + recarga antes de reintentar → la clave
     se perdió → duplicado (el reintento sin recargar sí está cubierto).
- **Arreglo:** escribir `localStorage` de forma síncrona dentro del bucle, quitando cada bloque
  apenas su POST responde bien (no esperar a la relectura para el almacenamiento; la relectura
  solo gobierna lo que se pinta). Guardar la clave de idempotencia en el propio bloque guardado,
  regenerándola al cambiar su contenido. Opcional: cortar el bucle con un `AbortController` al
  desmontar.

---

## P2

### P2-1. «Registrar producción» también registra el último bloque llenado solo

- **Dónde:** l. 122-133 (relleno), l. 173 y l. 275 (`sendReports(blocks)` incluye el bloque
  derivado), l. 297 (el aviso «No hay nada escrito» no salta porque el derivado cuenta).
- **Escenario A:** dos bobinas montadas, el operario terminó la A y sigue con la B. Escribe 40 m en
  A y pulsa «Registrar producción» para guardar su avance: también se manda un parte por lo que
  falta del pedido en la B, que todavía no se produjo.
- **Escenario B:** una sola bobina, nada escrito; un clic en «Registrar producción» registra el
  pedido completo.
- **Nota:** es el mismo comportamiento de `ProduceBlocks.persistAll` (el último derivado se guarda
  en el borrador), así que es coherente con el modelo M; pero en el accesorio no hay borrador
  intermedio: va directo a kardex. **Recomendación (decisión del dueño):** en «Registrar
  producción» no mandar el bloque derivado salvo que el usuario lo haya tocado; el relleno
  automático solo entra en «Registrar y cerrar».

### P2-2. «Registrar y cerrar» graba los bloques anteriores antes de mostrar «Qué va a pasar»

- **Dónde:** l. 269-273. `sendReports(before)` se ejecuta y **después** se pide la vista previa
  del último + cierre. «Volver» (l. 544-547) no deshace lo ya registrado, y la vista previa solo
  describe el último parte y el cierre.
- **Escenario:** tres bobinas; el supervisor pulsa «Registrar y cerrar» para _ver_ qué va a
  pasar, ve algo que no le gusta y vuelve: las bobinas 1 y 2 ya salieron del kardex.
- D-559 lo dice («no es todo o nada entre bloques»), pero la pantalla no avisa. **Arreglo mínimo:**
  un toast o una línea en el resumen («Ya se registraron las bobinas 1 y 2») y texto en el botón o
  la nota de la barra. Si el dueño espera la vista previa antes de cualquier escritura, hace falta
  otro diseño (vista previa del conjunto).

### P2-3. «Bajar» desaparece en la última bobina recién montada

- **Dónde:** l. 385. Condición `consumedKg == 0 && b.edit.meters.trim() === ''`. En el último
  bloque derivado `meters` trae el relleno, así que el botón no aparece mientras falte algo del
  pedido.
- **Escenario:** se monta por error una bobina (queda última, se llena sola): no hay «Bajar». Hay
  que vaciar a mano el campo de metros para que aparezca. En `ProduceBlocks` (l. 586-590) el
  derivado no lo impide, y el panel viejo lo ofrecía siempre que `consumedKg == 0`.
- **Arreglo:** usar `b.derived || edit vacío` en la condición (o no mirar los metros del bloque
  derivado).

### P2-4. Los avisos de materia prima se pierden al registrar

- **Dónde:** l. 175-178 descarta la respuesta del POST; l. 277 llama `onUpdated(null)` → el panel
  hace `onNotes({ pool: [], … })`. El panel anterior pintaba `updated.rawMaterialWarnings` después
  de cada reporte (D-154).
- **Arreglo:** guardar la última respuesta de la serie y pasarla a `onUpdated`.

### P2-5. Cerrar sin reportar más ya no permite declarar los kilos consumidos (D-089)

- **Dónde:** `apps/web/src/lib/accessory-blocks.ts`, rama `meters === null && consumedKg !== ''`
  → error «Escribe los metros de esta bobina antes de sus kilos»; `closeBody` (l. 205-209) no
  manda `consumedKg`.
- **Escenario:** todo el pedido se registró en días anteriores sin kilos; al final se pesa la
  bobina y se quiere cerrar declarando el consumo real (despunte). El último bloque está vacío
  (no falta nada) y escribir kilos en él queda bloqueado. Solo queda cerrar con despunte cero (o
  con los kilos que se hayan declarado parte por parte).
- D-558 retiró ese campo para cobertura a medida y plancha, no para el accesorio. **Decisión del
  dueño:** o se acepta (y se registra en D-559), o con el último bloque sin metros los kilos viajan
  como `consumedKg` del cierre suelto.

### P2-6. La casilla y el motivo de tolerancia no sobreviven a un refresco

- **Dónde:** `overrides` (l. 108) vive solo en memoria; `edits` sí va a `localStorage`.
- La ESPEC pide que un refresco no pierda lo escrito; el detalle del motivo es texto escrito. Tras
  recargar, la casilla vuelve vacía y «Registrar» queda bloqueado hasta repetirla. **Arreglo:**
  guardar `overrides` en el mismo registro del almacenamiento.

---

## P3

1. **Errores viejos después de un éxito.** `errors` (l. 109) se limpia solo al editar ese bloque
   (l. 137). Si el bloque 2 falló y en el segundo intento entra bien sin editarlo, el mensaje rojo
   del rechazo anterior queda pintado (l. 355) aunque el parte ya está registrado. Limpiar el
   error de cada bobina enviada.
2. **El último bloque deja de seguir a los demás al tocarlo.** Escribir piezas o kilos en el
   último derivado guarda `{ ...b.edit }` con los metros del relleno de ese momento (l. 130-132,
   417/431/453); si después se cambian los anteriores, el último ya no se recalcula y el cuadre
   pasa del pedido (lo rechazará el tope del plan, D-146, en el último bloque). `ProduceBlocks`
   resuelve esto en `editBlock`.
3. **Bloque con solo piezas se ignora en silencio.** `accessoryBlock` no marca error con piezas y
   sin metros; `sendReports` lo salta (l. 173) y el cierre suelto lo descarta. Marcar error como se
   hace con los kilos.
4. **`localStorage` sin limpieza ni validación.** Quedan entradas de bobinas bajadas y de órdenes
   cerradas desde otro lado o anuladas (nunca se borran); la clave no depende del usuario (dos
   supervisores en el mismo equipo ven lo del otro); `JSON.parse` sin validar la forma (l. 60): un
   valor dañado hace fallar `edit.meters.trim()` y tira el panel. Validar con Zod y descartar lo
   que no sea de una bobina montada.
5. **La relectura depende del orden de tareas de TanStack.** En el cierre, `previewClose.mutateAsync()`
   (l. 272) usa el `mutationFn` del último render confirmado; hoy es coherente (orden vieja y
   bloques viejos) porque las notificaciones del caché salen por `setTimeout`, pero el comentario de
   l. 193-194 promete más de lo que el código garantiza. En «Registrar» hay un cuadro intermedio con
   la orden vieja y los bloques ya quitados (relleno inflado un instante). Calcular el cuerpo del
   cierre con datos explícitos (la orden devuelta por el último POST) en vez de depender del render.
6. **«Teórico» usa la geometría de la primera bobina** (l. 317-321): con bobinas de ancho o espesor
   distintos, el número no es el de ninguna.
7. **Sin estado de espera en «Registrar y cerrar»** mientras se mandan los bloques anteriores: solo
   `previewClose.isPending` lo pinta (l. 576); durante `sendReports` ambos botones quedan apagados
   sin texto.
8. **Retrofecha a mitad de la serie:** si el rechazo `BACKDATE_OUT_OF_ORDER` llega con algún bloque
   ya enviado (l. 181), se pinta como error del bloque y no abre el diálogo; hace falta otro clic
   para que aparezca. Funciona, pero confunde.

---

## Tests

- **Unitarios** (`accessory-blocks.spec.ts`): cubren relleno, kilos, despunte y formato. No cubren
  exceso de tolerancia, bloque con solo piezas, ni que el relleno con otros bloques mayores al
  pedido dé cero (sí el caso `12 > 10`).
- **E2E `planta-modelo-m-cc35`, caso accesorio:** prueba la banda, el relleno, la recarga y
  «Registrar y cerrar» con dos bobinas. No prueba:
  - «Registrar producción» solo (el camino de P2-1 y el de la relectura que motivó l. 192-199);
  - un rechazo a mitad de la serie (lo enviado queda, lo demás sigue escrito);
  - que `localStorage` quede vacío tras cerrar;
  - que no se dupliquen partes (P1-1/P1-2).
- **E2E `tolerancia-accesorio-d389`:** se quitó la aserción de que la casilla vale solo para el
  exceso marcado (cambiar kilos hace desaparecer el aviso y volver lo trae). La lógica sigue en
  `overrideInput(…, excess)`, pero ya no hay un E2E que la pruebe en el accesorio.

## Lo que se miró y está bien

- Las rutas y campos coinciden con el API: `meters`, `piecesCount` (solo con metros), `consumedKg`
  del parte, `closeReason` en `report-and-close`, `reason` en `close`.
- El cierre confirma exactamente lo de la vista previa (`pendingClose`, l. 236-252), y el
  reintento tras un error del cierre reusa la misma clave.
- El panel queda montado por orden (`key={active.orderId}` en `planta-view.tsx`), así que no se
  mezclan bloques de dos órdenes en memoria.
- `stateOf` ya no marca «Sin plan» a un accesorio.
- La casilla de tolerancia queda atada al exceso (`forExcessKg`), así que no se arrastra a otro
  exceso distinto.

## Qué se hizo con los hallazgos (autor, cc35)

- **P1 la clave de idempotencia se reusaba** (un segundo parte idéntico se perdía): la clave vive ahora **con lo escrito del bloque** (en el navegador, D-559); se genera al mandar y se descarta al cambiar el contenido o al registrarse. Un reintento tras recargar reusa la misma; un parte nuevo con las mismas cifras lleva otra.
- **P1 partes duplicados tras un F5 o un cambio de orden a mitad de la serie**: cada bloque queda marcado como registrado en el almacenamiento apenas su parte responde, y no se vuelve a mandar; al cargar, los marcados se descartan (la orden releída ya los trae).
- **P2 «Bajar» en el último bloque lleno solo**: vuelve a estar mientras la bobina no roló.
- **P2 avisos del agregado**: se muestran los del último parte registrado.
- **P2 «Registrar producción» manda también el último bloque lleno solo**: es la regla de la ESPEC («el último se llena solo con lo que falta») y la pantalla lo muestra antes de registrar; igual en coberturas. Queda escrito en D-559.
- **P2 «Registrar y cerrar» graba los bloques anteriores antes de la vista previa**: es la consecuencia de D-559 (sin borrador del servidor para metros) y está escrito ahí.
- **P2 kilos de toda la corrida al cerrar (D-089)**: los kg consumidos de cada bloque los reemplazan, igual que en coberturas (ESPEC §1); el despunte cae en su bobina (cc34).
- **P2/P3 sin cambio**: la casilla de tolerancia no se guarda en el navegador; la clave del almacenamiento no incluye al usuario (es un equipo de planta); «Teórico» con la primera bobina.
