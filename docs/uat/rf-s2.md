# UAT — RF-S2 (Auditoría)

Guion para que el dueño pruebe lo que esta sesión entregó, en lenguaje de negocio. Todos los
casos son en `demo` o `dev` — el visor es de solo lectura, así que no hay riesgo de tocar
datos de producción al mirarlo, pero conviene probar primero donde ya haya movimiento.

## 1. Solo un administrador ve la auditoría

**Qué probar:** que la pantalla nueva no se le aparece a nadie más.

1. Entrar con un usuario VENDEDOR o SUPERVISOR_PLANTA.
2. Revisar el menú lateral, sección **Administración**.

**Resultado esperado:** no hay ningún ítem "Auditoría" — la sección Administración
directamente no aparece para esos roles (ya pasaba antes con Usuarios y Márgenes). Si se
escribe la dirección `/auditoria` a mano, la pantalla dice "No tienes permiso para ver esta
sección" en vez de mostrar datos.

## 2. Una acción cualquiera queda a la vista

**Qué probar:** que auditar "toda escritura sensible" es cierto, no solo una promesa.

1. Con un ADMINISTRADOR, hacer cualquier cambio de los que ya se auditaban antes de esta
   sesión — por ejemplo, cambiar el rol de un usuario, anular una bobina, o registrar un pago
   a un proveedor.
2. Entrar a **Administración › Auditoría**.

**Resultado esperado:** el cambio aparece primero en la lista (más reciente arriba), con
fecha y hora, quién lo hizo, y qué tipo de dato tocó. No hace falta ningún filtro para verlo
— la pantalla abre mostrando los últimos 31 días.

## 3. El detalle se lee, no se adivina

**Qué probar:** que el "antes/después" de un cambio es legible y no un bloque de código.

1. Sobre la fila del caso 2 (o cualquier otra que tenga un cambio de un valor puntual, como un
   precio o un estado), mirar la columna "Detalle".

**Resultado esperado:** una lista corta de campo → antes → después, en texto plano. Ningún
JSON crudo. Si el evento no tiene ningún detalle adicional que mostrar, dice "Sin detalle
registrado" en vez de quedar vacío.

## 4. Filtrar por tipo de dato y por fecha

**Qué probar:** que los filtros realmente acotan la lista, no solo la decoran.

1. En **Auditoría**, elegir "Pedidos" en "Tipo de entidad".
2. Poner un rango de fechas de una sola semana, la que incluya el caso 2.

**Resultado esperado:** la lista queda solo con eventos de pedidos en esa semana. El campo
"ID de entidad" se habilita recién después de elegir un tipo — antes está deshabilitado.

## 5. Un cambio de precio de lista aparece con su propio detalle

**Qué probar:** que la auditoría general y el historial de precios de RF-S1 conviven sin
duplicarse a ciegas.

1. Cambiar el precio de lista de un producto (Catálogo, edición inline o carga masiva).
2. En **Auditoría**, filtrar por tipo "Productos".

**Resultado esperado:** aparece un evento "Cambio de precio de lista" con el valor antes y
después. Si ese mismo producto tuvo otro tipo de cambio general (por ejemplo se editó su
nombre), aparece como un evento aparte — son dos hechos distintos, no una sola fila que
esconde al otro.

## 6. Más de una página de resultados

**Qué probar:** que "Cargar más" trae la página siguiente sin perder ni repetir eventos.

1. Elegir un rango de fechas con bastante movimiento (o ampliar el rango a varios meses).
2. Llegar al fondo de la lista y click en "Cargar más" un par de veces.

**Resultado esperado:** cada click agrega filas nuevas al final, siempre en orden de más
reciente a más antiguo, sin que se repita ninguna fila ya mostrada. El botón desaparece
cuando no queda nada más.

## 7. Un inicio de sesión también queda registrado

**Qué probar:** que entrar al sistema deja rastro, sin que esta sesión haya tenido que
construir nada nuevo para eso.

1. Cerrar sesión y volver a entrar con cualquier usuario.
2. Como ADMINISTRADOR, ir a **Auditoría** y filtrar por fecha de hoy (sin filtro de tipo).

**Resultado esperado:** aparece un evento "Inicio de sesión" para ese usuario, con la fecha y
hora de recién.
