# UAT: RF-S4a — Reportes de costeo y ventas

## Objetivo

Verificar que los dos reportes nuevos son **solo del administrador**, que sus números salen del
kardex y no de otra parte, y que cuando un costo no se puede cruzar con la venta del rango el
reporte lo **declara** en vez de estimarlo.

Esta es además la **primera lectura de estos reportes contra datos reales**: la sesión fue
código y CI, así que los puntos 4 y 5 son tanto prueba como descubrimiento.

## Entorno

- Rama `rf-s4a` (PR #9). Sin migración: la ventana es API → merge → web.
- Actores: Administrador, un Vendedor, un Supervisor de planta.

## 1. Permisos (5 min)

1. Entrar como **Vendedor**. En el menú lateral, sección Administración, **no** deben aparecer
   «Inventario valorizado» ni «Ventas y margen».
2. Escribir a mano `/reportes/inventario-valorizado`. Debe salir «No tienes permiso para ver
   esta sección».
3. Repetir los dos pasos como **Supervisor de planta**: mismo resultado. Es intencional — estos
   dos reportes no enmascaran costos, se cierran enteros (D-244).
4. Entrar como **Administrador**: los dos ítems están en el menú y las dos pantallas abren.

## 2. Inventario valorizado (10 min)

1. Abrir `/reportes/inventario-valorizado`. La fecha de corte del subtítulo debe ser **hoy**.
2. Las bobinas están agrupadas por **línea / espesor / color**. Las galvanizadas (sin color)
   forman su propio grupo, rotulado «Sin color».
3. Hacer clic en un grupo: se despliegan sus bobinas, cada una enlazada a su ficha. Abrir una y
   comprobar que el saldo que muestra la ficha es el mismo que el del reporte.
4. **Cuadre contra el kardex**: elegir una bobina, abrir su kardex (`/kardex`) y comprobar que
   el saldo valorizado del último movimiento coincide con el «Valor» de esa fila.
5. Sumar a mano la columna «Total» de la tabla de totales por línea: debe dar exactamente el
   «Total general» de la última fila y el de la tira de arriba.
6. **Anomalía a reportar si aparece:** una bobina con saldo cuyo estado **no** sea «Abierta».
   D-164 liquida el remanente al cerrar, así que no debería existir ninguna; el reporte la
   muestra en vez de esconderla justamente para que se vea. Si sale alguna, anotar su código.

## 3. Ventas y margen (15 min)

1. Abrir `/reportes/ventas-margen`. Por defecto trae del día 1 del mes en curso a hoy.
2. Poner un rango que incluya ventas conocidas y comprobar contra `/comprobantes`:
   - la venta de cada comprobante es su **subtotal sin IGV**, no el total;
   - una nota de crédito aparece **en negativo**;
   - los borradores y los anulados **no** aparecen.
3. Desplegar un pedido: sus comprobantes cuelgan debajo. Algunos van a tener la columna
   «Costo» en blanco — es lo esperado cuando el despacho de ese comprobante no fue declarado
   (D-205). El costo del **pedido** sí está.
4. Poner el rango de un solo día en el que se haya despachado y facturado algo: la fila debe
   decir «Completo» y el margen tiene que ser `venta − costo`.

## 4. Lo que hay que anotar y traer de vuelta

Estos tres números no se conocen todavía y salen de la primera corrida real:

1. **Cuántos pedidos caen en «No comparable»** con el rango del mes pasado completo, y cuánta
   venta se llevan (el texto de esa sección lo dice literal).
2. **Cuántos pedidos salen con «Costo parcial»** — el aviso de arriba lo cuenta.
3. **Cuántos comprobantes tienen el costo en blanco.** Si son casi todos, es lo esperado:
   `Dispatch.invoiceId` solo se llena desde D-213 y en el mostrador.

## 5. Excel (5 min)

1. En cada pantalla, «Descargar Excel».
2. Abrir el archivo del inventario y **sumar con el mouse** la columna «Valor» de la hoja
   «Bobinas por grupo». Tiene que dar el total de la hoja «Totales». Si en vez de sumar Excel
   no ofrece total, los montos llegaron como texto y es un defecto.
3. En el archivo de ventas, la hoja «Por pedido» **no** debe contener los pedidos de la hoja
   «Facturación parcial»: sumar la columna de venta de la primera tiene que dar el total del
   rango.

## Criterio de aceptación

- Los puntos 1, 2, 3 y 5 pasan tal como están escritos.
- El punto 4 no tiene resultado correcto ni incorrecto: los tres números se anotan y vuelven al
  handoff. Si alguno sorprende, se decide antes de la ventana.
