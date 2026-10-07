# cc31 · Pieza de UX — especificación aprobada

Aprobada por el dueño entre el 06 y el 07/10/2026. Solo web (`apps/web`). Sin cambios de API, sin migraciones, sin cambios de regla de negocio.

## Cómo leer esto

- `tableros/*.dc.html` son los dibujos aprobados. Son HTML con estilos en línea: se pueden abrir en el navegador o leer como texto. La etiqueta `<x-dc>` y `support.js` son del lienzo; ignóralas.
- **El tablero manda en disposición y jerarquía. Este documento manda en reglas y alcance.** Si se contradicen, vale este documento.
- Los tableros usan datos de muestra y colores en hex. En el código se usan los tokens de `globals.css` y los componentes de shadcn/ui que ya existen; no se copian los hex ni los estilos en línea.
- Si un elemento dibujado necesita un dato que el API no entrega hoy, **se omite** y se anota en el informe de cierre. No se inventa el dato ni se toca el API.

## 0. Reglas transversales

### Tipografía

- Geist y Geist Mono se quedan.
- Tamaño mínimo 12 px (hoy hay ayudas y etiquetas de estado a 11 px).
- Texto secundario un tono más oscuro que el actual `muted-foreground` (referencia #5c5c5c), comprobando contraste AA sobre blanco y sobre `muted`.
- Columnas numéricas con cifras de ancho fijo (`tabular-nums`).
- Título de página a 20 px.
- Monoespaciada solo para códigos, placas y números de documento.
- El cuerpo sigue a 13 px. Las pantallas de planta no se tocan en esta pieza.

### Números (solo lo que se muestra; la base y los cálculos no cambian)

- Metros: 2 decimales; el tercero solo si no es cero (12.00 m, 4.205 m).
- Kilos en listas, formularios y reportes: 2 decimales (4,027.44 kg).
- Kilos en kardex y detalle de bobina: 3 decimales, con la parte decimal en gris.
- Unidades: sin cambio.
- Campos: aceptan lo que se escriba; al salir muestran el formato anterior. Lo que se envía al API no pierde precisión.
- Los totales se calculan con los valores completos y se redondean al final.
- Excel conserva 3 decimales. Los PDF los genera el API: no se tocan.
- Todo pasa por `lib/format.ts`; se eliminan los `toFixed` y `toLocaleString` sueltos. Se agrega un formateador único de fecha y hora (Lima) y se reemplazan las cuatro copias.

### Textos

- Ningún código interno a la vista (RF-nn, D-nnn, §n, ccNN) en subtítulos, títulos de sección, etiquetas, ayudas, diálogos ni tooltips. Se quita el código y se deja la frase.
- Trato de tú en todo. Corregir voseo («Elegí» → «Elige») y «acá» → «aquí».
- Nada en inglés a la vista ni para lector de pantalla («Close» → «Cerrar», «Toggle Sidebar», «draft»).
- Colores de estado por un solo mapa (`components/status-tone.ts`): la etiqueta de estado de planta y «Prioridad» pasan por él; «vencido» usa un solo color. Los nombres de los estados no cambian.

## 1. Formulario de cotización y sus pares

Tableros: `Main`, `Selector`.

- Aplica a `components/sales/sales-document-form.tsx` en sus cuatro usos: nueva cotización, pedido directo, editar cotización y agregar ítems.
- Fuera: la búsqueda de producto unificada entre líneas de negocio si exige un endpoint nuevo. El selector se implementa hasta donde lleguen los endpoints actuales.
- Es el corte de mayor riesgo: no cambia cálculo de precios, pisos, reservas ni validaciones; solo disposición, textos y ayudas.

## 2. Menú lateral, barra superior e «Ir a»

Tableros: `MenuC`, `Barra`, `Comando`.

- Menú C (cambios mínimos sobre el actual). Los contadores del menú solo donde el API ya entrega la cifra; los demás se omiten.
- Barra superior: ruta (grupo / lista / código), que reemplaza al botón «Volver», y la etiqueta «Demo · datos de prueba» cuando el ambiente es demo.
- «Ir a» (Ctrl K): pantallas y acciones de crear, filtradas por rol. Buscar un documento por código solo si alcanza con los endpoints de lista actuales.
- Enlazar «Cambiar contraseña» desde el menú de usuario (hoy no se llega desde la app).

## 3. Panel

Tableros: `PanelAdmin`, `PanelRoles`.

- Quitar el saludo «Fase 0: autenticación y usuarios…».
- Las tarjetas del vendedor llevan a su lista filtrada.
- Se omite lo que pida API nuevo (quién debe vencido, planta hoy para el administrador, lista de cotizaciones del vendedor).

## 4. Páginas de detalle

Tableros: `Plantilla`, `PedidoE`.
Orden fijo: ruta, cabecera, resumen, etapas, secciones, sección vacía.

- Cabecera: código y estado a la izquierda. A la derecha, siempre en este orden: Historial, «Más opciones», un solo botón principal. Lo que anula o revierte va al final del menú, en rojo.
- Resumen: franja gris con cuatro o cinco datos; el total a la derecha.
- Etapas: solo en documentos con recorrido.
- Secciones: banda gris sólida con título, contador, resumen corto y la acción de la sección; debajo, la tabla sin marco. La sección vacía se muestra igual, con contador en 0 y una línea que dice qué falta.
- Alcance: pedido, cotización, comprobante, bobina y despacho. Compra, corte y orden de producción quedan para después.

## 5. Listas y tablas

Tablero: `Tablas`.

- Título con el filtro activo, «Más opciones» y un botón principal.
- La unidad va en el encabezado («Total (S/)»), no en cada celda. Vacío con palabra («Sin emitir»), no con raya.
- Pie con cuántas filas se ven y la suma de la columna de importe.
- Fila de 38 px en listas y 34 px dentro de secciones.
- Correcciones sin API:
  - Estado de error propio donde hoy falta (comprobantes, despachos, cobranzas, Mostrador, caja).
  - Filtros en la URL en proveedores, corte, flejes, inventario, auditoría y la pestaña de línea del catálogo.
  - Un solo patrón de filtro de estado; «Solo con saldo» como chip.
  - Comprobar en navegador si el encabezado fijo funciona y corregirlo.

## 6. Formularios y diálogos

Tableros: `Formularios`, `DespachoPropuesta`, `DespachoErrores`.

### Campo

- Lo obligatorio no lleva marca; se marca lo opcional («· opcional»).
- La unidad va dentro del campo. El ejemplo va debajo, nunca como texto fantasma dentro del campo.
- El error va debajo del campo, en una frase que dice qué corregir.
- Listas largas siempre con búsqueda.

### Formulario de página (modelo: Nuevo despacho)

- Secciones con banda gris. Lo que decide el documento va primero.
- Barra fija abajo. El botón principal no se apaga: si falta algo, la barra lo dice a la izquierda con enlaces a cada campo; al pulsar con faltantes no envía, marca los campos y los lista.
- Bloque «Qué va a pasar» con cifras antes de la barra.
- Nuevo despacho en concreto: «Qué sale» en segundo lugar; cantidades llenadas con lo pendiente y botón para vaciarlas; fila de total; se quita la columna «Material»; modalidad en tres botones; Observaciones en sección propia, visible también en recojo; dirección de llegada como lista de las guardadas del cliente; franja de resumen al elegir el pedido.
- Aviso de cambios sin guardar también en nuevo comprobante, nueva orden de corte y los importadores.

### Diálogo de operación (modelo: Registrar merma)

- Título con el verbo y el documento. Bloque fijo «Qué va a pasar» con cifras. El botón repite el título; en rojo si saca inventario o anula.
- Motivo como lista más detalle opcional, empezando por merma y anulación. Lo que viaja al API sigue siendo el texto de hoy.
- Con algo escrito, un clic afuera no cierra.
- Enter confirma en el diálogo de motivo.

### Defectos concretos

- Comprobante: una línea libre con descripción vacía hoy pasa.
- Compra: cambiar «Tipo de compra» borra las líneas sin avisar.
- Producto: cobertura nueva queda con unidad vacía; precio de lista sin IGV en el diálogo y con IGV en la celda.
- Cliente y proveedor: correo sin validar; mensaje en inglés en días de crédito.
- Proveedor: el código corto se bloquea al editar.
- Tipo de cambio: sobrescribe sin avisar; fecha en formato ISO.
- Coma decimal aceptada en todos los campos numéricos, no solo en el cierre de bobina.
- Desactivar usuario, cliente o proveedor pide confirmación.

### Orden de trabajo

1. Componentes comunes y textos.
2. Formularios de página: despacho, compra, corte, nuevo comprobante.
3. Diálogos.

## 7. Ingreso

Tableros: `LoginA`, `LoginEstados`, `LoginCambio`.

- Tarjeta centrada con sello AYR, «Mostrar» en la contraseña, aviso de Bloq Mayús.
- Estados con texto propio: credenciales incorrectas, sesión vencida (dice a dónde vuelves), demasiados intentos, usuario desactivado, enviando.
- «¿Olvidaste tu contraseña? Pídele una temporal al administrador.» Solo texto.
- Primer ingreso a pantalla completa, sin menú: «Elige tu contraseña», reglas que se marcan al escribir, enlace para salir.
- Aviso de demo en el ingreso.
- Fuera: «Recordarme», ingreso con Google, recuperación por correo.

## 8. Avisos

Tableros: `AvisosCampana`, `AvisosMensajes`, `AvisosEstados`.

- Campana en la barra superior: lista de pendientes calculada al momento con los endpoints actuales, por rol; cada fila lleva a su lista filtrada. Sin «leído», sin historial, sin tabla nueva. Se actualiza cada minuto.
  - Candidatos: comprobantes sin aceptar, pedidos con faltante, bobinas por terminarse, precios bajo el piso, pedidos listos, reservas temporales y cotizaciones por vencer. Entra el que tenga endpoint; el vendedor ve solo lo suyo si el API ya lo filtra.
- Mensajes: el éxito dura 6 s y trae el paso siguiente; el error se queda hasta cerrarlo y dice el motivo; la advertencia va en amarillo (variante nueva de `Alert` y de mensaje). Un solo ayudante para armar el mensaje de error.
- Red y servidor: «El servidor no respondió» en vez de «Error 500» o «Failed to fetch»; franja «Sin conexión».
- Listas: tres estados distintos (todavía no hay nada, el filtro no encuentra nada, falló la carga con «Reintentar»), con un componente común.
- Páginas propias de «No encontramos esa página» y «Esta pantalla tuvo un problema» (`not-found.tsx`, `error.tsx`, `global-error.tsx`).

## Fuera de la pieza

- Producir una OP y tamaños de las pantallas de planta.
- Reportes (falta dibujarlos y aprobarlos).
- Auditoría.
- PDF, atajo a la guía, impresión.
- Buscar despachos por código (pide API).
- Avisos de hechos puntuales con «leído» (pide migración).
- IA.
