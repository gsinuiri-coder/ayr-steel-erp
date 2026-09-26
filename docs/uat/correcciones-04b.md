# Guion UAT — Correcciones 04, tanda B: film de protección de la bobina (D-328)

Para correr en **demo** (copia de producción) o en producción después de la ventana, con datos
que el dueño elija. Cada paso dice qué mirar y qué tiene que salir. **Mirar y no pulsar** en
producción salvo los pasos marcados con ✍ (escriben datos; usarlos solo sobre una bobina de
prueba que el dueño elija).

## 1. Estados: Sellada → Abierta → Terminada

1. **Almacén → Bobinas.** La columna **Estado** dice **Sellada**, **Abierta** o **Terminada**
   (ya no «Cerrada»). La pestaña que antes era «Agotadas» se llama **Terminadas**.
2. El filtro **Selladas y abiertas** (junto a «Acabado») deja ver solo las selladas o solo las
   abiertas. Con **Solo abiertas** no aparece ninguna sellada, y al revés.
3. Abrir una bobina: el recuadro **Material** trae **Film de protección** (Sellada / Abierta) y
   más abajo la sección **Film de protección** con el historial: fecha, evento, causa, quién y
   motivo. Una bobina que nunca se abrió dice «Llegó con el film puesto y no se ha abierto
   todavía».
4. Una bobina **hija de un partido** o un **fleje de corte** figura **Abierta** con causa «Nació
   abierta» y **no** ofrece «Volver a sellar».

## 2. Abrir y volver a sellar a mano ✍

1. En una bobina **Sellada**, menú **⋯** → **Abrir bobina**. Escribir un motivo (opcional) y
   confirmar. El estado pasa a **Abierta**; el kardex **no** cambia (ni el saldo ni los
   movimientos) y el estado sigue siendo «vigente».
2. En esa bobina, **⋯** → **Volver a sellar**: pasa a **Sellada**. El historial muestra los dos
   eventos.
3. Abrirla, **registrar una merma** de 1 kg y volver a intentar **Volver a sellar**: el sistema
   lo rechaza y dice **«Ya salió material desde que se abrió (una merma del …)»**. **Anular la
   merma** y volver a intentar: ahora sí se puede.
4. **Terminar bobina** y **Reabrir bobina terminada** siguen siendo lo de siempre (pide cuántos
   kilos quedan; reabrir devuelve el ajuste): solo cambió el nombre.

## 3. Lo que abre la bobina solo

Todas estas operaciones sobre una bobina **Sellada** muestran antes de confirmar el aviso
**«Esta bobina está sellada: al continuar se abre»**:

1. **Producción → montar una bobina** en una orden de coberturas: en el selector, cada fila dice
   **Sellada** o **Abierta**; al montar una sellada aparece un paso aparte con el aviso y el botón
   **Abrir y montar**. Al montar varias a la vez, un solo paso para todas.
2. **Registrar merma**, **Partir** (en el detalle de la bobina) y **Enviar bobinas a corte**
   (Corte tercerizado → Nueva orden): el aviso está junto al botón de confirmar.
3. Después de cada una, la bobina figura **Abierta** y el historial dice la causa («Al montarla
   en una OP», «Al registrar una merma», «Al partirla», «Al enviarla a corte»).
4. **Vender una bobina entera** (venta directa) **no** toca el film.

## 4. Lo que la vuelve a sellar sola ✍

1. Montar una bobina sellada en una orden **sin reportar planchas** y luego **bajarla de la
   orden**: vuelve a **Sellada** (causa «Al liberarla de la OP sin reportes»).
2. Si la bobina se había abierto **a mano antes** de montarla, bajarla **no** la vuelve a sellar.
3. Enviar una bobina sellada a corte y **cancelar el envío** sin haber recibido nada: vuelve a
   **Sellada**.
4. **Revertir un partido** **no** vuelve a sellar la madre.

## 5. Reporte mensual de bobinas en dos tablas

1. **Reportes → Reporte mensual de bobinas.** Dos tablas: **Selladas** y **Abiertas**, cada una
   con su **Subtotal**, y arriba el **total general** (saldo inicio, peso de alta, saldo fin de
   mes y, para quien ve costos, valor).
2. El corte es **al último día del mes**: una bobina que se abrió el 5 de septiembre figura en
   **Selladas** en el reporte de agosto y en **Abiertas** en el de septiembre.
3. Las **terminadas** con saldo final 0 figuran en **Abiertas**.
4. El total general **cuadra**: subtotal Selladas + subtotal Abiertas = total general, y con la
   suma de las dos tablas de un mes se recupera el mismo total que daba el reporte anterior
   (antes de esta entrega, una sola tabla).

## 6. Compras

1. **Compras → Nueva compra de bobinas.** El formulario ya **no** tiene «Estado al alta».
2. Recibir la compra: la bobina nace **Sellada** (antes nacía «Cerrada»).

## 7. Después de la ventana: el backfill

El backfill (`pnpm backfill:film`) deduce el film de lo que ya pasó. **Antes de aplicarlo** se
revisa la lista del dry-run (`local-data/corr04b/film-dry-run-production.txt`); **después**:

1. **Bobinas** → contar por estado: **Selladas**, **Abiertas** y **Terminadas** (los números
   están en el handoff).
2. Las que tuvieron salidas de producción, merma, partido o corte figuran **Abiertas**, con
   «Deducida del historial» como causa y la fecha de la primera salida.
3. **Reporte mensual** de agosto y de septiembre: en dos tablas, con subtotales que suman el
   total del reporte de antes.
