# Revisión de un segundo modelo (Sonnet) — no es una persona; el dueño cierra la revisión

**Objeto:** `docs/analisis/ux-recorrido-2026-09-28.md` y la fila D-367 de `docs/ARQUITECTURA.md` §0.2.
**Rama / worktree:** `docs/recorrido-ux`, `../ayr-ux` (sobre `bc0c331`). Contexto limpio: no leí ningún
handoff ni la autorrevisión paralela. **Solo lectura:** ni una sola escritura en producto ni en la base
`ayr_local_ux`; el único archivo de la entrega es este. La sesión de Playwright fue propia
(`estado-segundo-modelo.json`) y el usuario de prueba solo leyó.

**Método.** Web `:3001` contra `ayr_local_ux`, Chromium a 1366×768 (y 1366×640 para el barrido de alto).
Sondas propias `sm-*.mjs` en `local-data/c06/ux/` (ignorada por git): medidas de DOM, respuestas GET del
API que la propia pantalla pide, y lectura del código. Regla: una cifra sale del DOM o del API, no de una
captura. Tres advertencias de método, para no repetir los falsos positivos del informe:

- Chromium headless de Playwright lanza con `--hide-scrollbars`: **una barra horizontal no se ve en las
  capturas ni se mide** (`offsetHeight − clientHeight = 0`). Con `ignoreDefaultArgs: ['--hide-scrollbars']`
  la barra mide 10 px y se ve bajo la tabla (`local-data/c06/ux/capturas/sm-bobinas-scrollbar.png`).
- El web corre con `next dev`: aparece el indicador «N» de Next sobre el pie del menú en todas las capturas
  y los tiempos de carga (COT-4, PLA-5, FAC-5) salen inflados frente a un build de producción.
- El indicador «N» tapa «Administrador / Cerrar sesión»: es de desarrollo, no un hallazgo.

---

## P0 — cambia el rumbo

### P0-1. DES-1 es falso en su premisa, y la sesión P-05 (L, «necesita modelo de datos») se apoya en ella

El informe dice: «9 campos de transporte a mano en cada despacho… **Nada se recuerda ni se propone**» y
propone «datos guardados de almacén, vehículos y conductores; repetir el último», con esfuerzo **L** y
«necesita modelo de datos» (orden 13).

Ya existe, y **está decidido cómo debe ser** (D-078, línea `| D-078 |`): «el catálogo de vehículos y
conductores frecuentes **se difiere**; v1 captura texto libre y lo **autocompleta con los valores usados
en despachos anteriores** (`GET /dispatches/transport-suggestions`), sin tablas ni ABM nuevos».

Evidencia:

- `nuevo-despacho-view.tsx:97-121` consulta `/dispatches/transport-suggestions` y **precarga** dirección y
  ubigeo de partida con `origins[0]`; `:397-405`, `:496-503`, `:516-535` son `<input list>` + `<datalist>`
  para dirección de partida, placa y nombres del conductor, y elegir un conductor conocido rellena
  apellidos, tipo y número de documento y licencia (el comentario cita D-078).
- Reproducción: `node ../ayr-ux/local-data/c06/ux/ver.mjs /despachos/nuevo sm-des-nuevo` → «Dirección de
  partida» ya trae «Av. Industrial 1234, Ate» y «Ubigeo de partida» trae el **valor** `150103` (el
  placeholder es `150101`); «Placa» y «Nombres del conductor» salen como `combobox`.
- Por qué el informe lo vio vacío: la base de recorrido no tenía despachos previos; las sugerencias salen
  de los despachos ya guardados. Con un despacho en la base, el formulario se propone solo.

**Corregir.** Reencuadrar DES-1 como _descubribilidad_ del `datalist` (un `<datalist>` nativo no muestra
nada hasta que se enfoca y se borra el campo; no hay señal de que existan sugerencias) y como la excepción
legítima que sí falta: el destino (dirección de llegada) no se sugiere. Sacar «modelo de datos» y el **L**
de P-05, o presentarlo como una **reapertura explícita de D-078** que el dueño decide. DES-6 queda a
medias: en la **partida** el valor real ya se propone (se mide arriba); solo la **llegada** sigue con
placeholder.

---

## P1 — hallazgos o prioridades mal juzgados, conflictos con D-nnn, u omisiones grandes

### P1-1. CAT-1 es falso: el enlace abre **pestaña nueva** y el código lo dice

Informe: «¿No está el acabado o el color? Créalo en Acabados **saca al usuario del formulario y pierde lo
escrito**: el callejón que D-156 quiso evitar». Medida en el DOM (`sm-cat1.mjs`):
`<a href="/acabados" target="_blank" rel="noopener">`, y `purchase-form.tsx:1090` lo comenta: «Pestaña
nueva: salir de acá pierde la compra a medio cargar». Lo que sí queda: es un desvío (crear en otra
pestaña, volver, «volver a abrir el selector»), menos cómodo que el alta en línea de D-156. Pero no es el
callejón medido por D-156 (141 filas perdidas). **Corregir:** bajar CAT-1 a Baja, quitar «pierde lo
escrito», y sacarlo de P-12 (que hoy pide «decisión del dueño antes de tocar nada» en parte por él).

### P1-2. COT-10 es un falso positivo de la sonda

«Solo el botón "Elegir" es clicable; la fila entera no.» Con el diálogo **cargado** (esperar ~1.5 s: al
abrir muestra una fila de espera): `getComputedStyle(tr).cursor === 'pointer'` y un clic en la **primera
celda** cierra el diálogo y elige al cliente (`sm-cot.mjs`: «diálogo abierto: 0» tras el clic en `td`). La
primera pasada que hice, con el diálogo aún cargando, dio exactamente la conclusión del informe (`cursor:
auto`, diálogo abierto) — el mismo tipo de trampa que el informe ya reconoció con la lista de comprobantes.
**Corregir:** retirar COT-10 (y bajar el conteo a 53; Baja 25).

### P1-3. FAC-2 depende de un ajuste global que el informe no menciona (D-153/D-195)

`comprobante-detalle-view.tsx:440,631-632`: el botón destacado lo decide `invoicing_settings.manual_by_default`
(«un ajuste global solo decide cuál de los dos botones viene destacado; los dos siguen siempre a la vista»,
D-153; D-195 lo repite y crea `companion` **a propósito** para que los dos se vean). El interruptor está
en la tarjeta de contingencia (`contingency-card.tsx:90-201`). En `ayr_local_ux` el valor es el por defecto
(`false`, migración `20260908210000`), por eso salió «Emitir y enviar al PSE» azul; **el informe no
verificó cuál es el ajuste en producción**, que es lo que importa («vale hoy en producción»). Si el dueño
ya marcó «manual por defecto», FAC-2 desaparece en lo de la jerarquía. **Corregir:** decir que es
configurable, listar D-153/D-195 en §3.1, y dejar solo la parte de «razón visible» (que sí se reproduce:
`title` sin más, `comprobante-detalle-view.tsx:568`).

### P1-4. PLA-9 está mal diagnosticado, y en realidad es un bug de lógica que no figura en §5

Informe: «al cerrar OP-000001 (60 de 102 m producidos) pasa a "0 de 1 orden…" porque **la orden cerrada
sale de la cuenta**». Eso explica la **franja** de `/planta` (solo cuenta abiertas; D-190/D-160). Pero el
mismo defecto aparece donde **sí** entran las cerradas:

- Detalle del pedido (`/pedidos/cb5588f4…`, incluye cerradas por D-190): OP-000001, plancha **20 de 20
  producidas y cerrada**, muestra **«0.000 m de 60.000 m»**; OP-000002 muestra «42.000 m de 42.000 m».
- `/planta?historial=1`: «ML reportado / plan» del pedido con las dos órdenes cerradas dice
  **«42.000 m / 102.000 m»**.
- Causa medida en el API que la propia pantalla pide (`GET /api/production?status=…`, con
  `sm-net.mjs "/planta?historial=1" "api/production\?status"`): la OP de plancha (`productUnit: "NIU"`)
  trae `"piecesReported":20,"metersReported":null,"planMeters":"60.000"`; la de a medida (`MTR`) trae
  `"metersReported":"42.000"`. Los metros reportados de una plancha **valen `null`** y se suman como 0.

No es una decisión de diseño de «solo abiertas»: el pedido ve el 0 % en una orden completa y cerrada. Es
un cálculo, y afecta a **todo pedido con planchas de catálogo**. **Corregir:** (a) reclasificar PLA-9 de
`P-04 (UX, S)` a **posible bug de lógica** (nueva LOG-4: `metersReported` nulo en órdenes de plancha,
consumido por la franja de planta, el detalle del pedido y el historial); (b) dejar en PLA-9 solo la parte
UX de la franja. Mientras no se sepa el alcance, **no** sacar P-04 con PLA-9 dentro como si fuera una S de
copy.

### P1-5. §3.3 y §3.4 tienen un error de hechos sobre el importador de cotizaciones, y omiten el commit que cambió D-156

§3.3: «No crean producto (verificado): … el importador de cotizaciones (**D-150 lo retiró**)». **No lo
retiró:** D-150 eliminó los importadores _directos_; D-152 creó el importador de cotizaciones, que **sigue
vivo** (`/cotizaciones/importar`, «Importar cotizaciones», carga sin error en el barrido). Lo cierto es
otro y es más relevante para §3.4: D-156 se escribió **para ese importador** («junto a cada campo que
exige elegir de un maestro hay un botón crear… `CustomerDialog` y `ProductDialog`»), y **`78f679c`
(«feat(ventas): simplificar selectores y altas contextuales», 2026-09-18) quitó `ProductDialog` de
`cotizaciones/importar/importar-view.tsx` y de `express-create.tsx`** sin fila en §0.2
(`git show 78f679c | grep -n ProductDialog`). Hoy el importador de cotizaciones crea clientes pero no
productos, es decir, **D-156 ya estaba parcialmente derogada para productos por código, sin decisión**.
Eso cambia el análisis de §3.4: el informe dice que D-367 «solo muerde en un lugar» (importador de
compras) y que en las pantallas de venta «describe lo que son»; falta decir que en el **propio hogar de
D-156** la excepción ya se había aplicado de facto (y con qué costo para el callejón de SKU desconocido
que D-156 midió) y que D-367 la regulariza. Debe entrar como evidencia en D-367 (columna 3) o en §3.4.

Nota: esto no rompe la instrucción del dueño sobre la fecha (el commit es del 18-09, pero el dueño pidió
no inventar una fecha para la _instrucción del cliente_, y el informe correctamente no lo hace); solo
enriquece la evidencia. Que decida el dueño si D-367 cita el commit.

### P1-6. Omisión de peso: el ancho del menú lateral, y el colapso no se recuerda

El informe dice que el dolor «es de anchura», pero no menciona que el menú fijo ocupa **256 px de 1366**
(19 %), ni que se puede colapsar. Medidas (`sm-side.mjs`): `main` pasa de **1110 a 1318 px** al colapsarlo;
con el menú colapsado `/bobinas` **cabe** (1285 de 1284: ALM-1 desaparece salvo 1 px), mientras
`comprobantes/[id]` (2002/1286), `ventas-material` (1612/1284) y `auditoria` (1328/1284) siguen
desbordando. Además, el estado colapsado **no persiste** (`sm-side2.mjs`): tras recargar vuelve a 1110 px;
`sidebar_state` se escribe como cookie pero `sidebar.tsx:52` fija `defaultOpen = true` y nadie la lee. Hallazgo
nuevo (Media/S) y un cambio de alcance de P-02: el paquete de tablas debería partir de «¿qué recupera
colapsar por defecto a ≤1440?» antes de reordenar columnas. Al menos ALM-1 baja de Media a Baja.

### P1-7. El orden de §7 no es «por efecto en 1366×768»: la pantalla que más se usa está en el puesto 11

El encabezado de §7 dice «ordenadas por efecto sobre el uso diario en 1366×768»; §0 dice que cotizar «es la
pantalla que más se usa» y que P-03 tiene «el mayor efecto para el vendedor». Pero P-03 (COT-1, 2, 3, 5,
6, 10) va en el **11** y fuera de las sesiones A/B/C: ordena por costo, no por efecto. Recomiendo:

- Sacar de P-03 la parte barata a Sesión A: **pie fijo con «Crear cotización»** (S; lo único que hace falta
  para que la acción no quede en y=1004–1036 con dos líneas, medido) y COT-5/COT-6. Dejar la fila de una
  línea y el precio principal (COT-1/2/3) como la L que es.
- **PAN-1** («Fase 0: autenticación y usuarios…», texto falso en la primera pantalla de todos los roles;
  reproducido también para VENDEDOR) es de **una línea** y está en la Sesión C (#8); va en la A.
- `P-01` figura en §0 como «media/S» y en la tabla como **Baja**: alinear.

### P1-8. La justificación de P-04 contradice a D-179

§0 y §7 hablan de «pantalla de **operario**» y «se usa todo el día». D-179 (línea `| D-179 |`): «el operario
de planta **no usa la app y el supervisor ingresa todo, incluida producción**». El usuario de `/planta` es
el supervisor en un PC; no hay medición de frecuencia en el repo. **Corregir:** llamarla «pantalla de
producción del supervisor», quitar «todo el día» (o sustentarlo con un dato del dueño), y no usarlo para
subir su prioridad.

### P1-9. PLA-1 describe mal el mecanismo

«No muestra ningún botón: el acceso es el código `PED-…`, un enlace… que no parece entrada.» El código
(`pedido-list.tsx:80-95`) usa un enlace **estirado sobre toda la tarjeta** (`after:absolute after:inset-0`) con
`hover:bg-muted/40`: la **tarjeta entera** es el clic. Lo que falta es una señal de que lo es (chevron o
botón), no «el acceso es el código». Sigue siendo S/Baja-Media; que cambie la redacción para no mandar a
alguien a agrandar el código.

---

## P2 — matices, redacción, cifras

1. **COT-1 mide 224 px, no ~200** (fila 1: 151 + 73). Con dos líneas 1052 px (coincide). «Crear cotización»
   está en y=1004–1036, `position: static` (no hay pie fijo). Y 768 es el mejor caso: un Chrome real a
   1366×768 deja ~640 de viewport. Con `1366x640` el barrido marca además `bobinas/[id]` (730 px) y todas las
   marcas de alto se agravan: los «bajo el pliegue» son **más**, no menos. Decirlo en §1.
2. **Barra de scroll (FAC-1, ALM-1, REP-1, ADM-3, PLA-3).** «Sin señal de scroll» está inflado por
   `--hide-scrollbars`. En Chrome real de Windows hay barra (10 px medidos, visible) o la de superposición de
   Win11; y además la columna cortada al filo es una señal. Reformular: «señal débil». **ALM-1**: «quedan
   fuera ML teórico, Costo/kg y Estado» — ML teórico está **cortada** (1249–1402 con el filo en 1349), no
   fuera; Estado sí (1481–1558). **FAC-1**: fuera del todo son 8 columnas y Precio/kg está cortada 5 px;
   además «Base de costo» mide 272 px y «Línea» 323 px: estrechar esas dos recupera ~300 px sin rediseñar.
3. **ADM-3.** «Cada fila mide 117–160 px»: hoy 49–337 px (49 los inicios de sesión y cambios de clave,
   315–337 las altas de producto y los reportes de OP). Lo sólido: 50 filas = **7010 px** hoy. Reformular.
4. **§0/§8: «13 vs 6 pantallas marcadas»** mezcla marcas que no dependen de la resolución (`SIN H1` de
   `configuracion/reservas`, rótulos sin control, alto de compra) y **1 falso positivo + 2 de 12 px**
   que el propio informe reconoce. Distinguir «marcas por resolución» de «marcas totales». §8 dice «49
   pantallas» y la tabla «de 50»: el barrido tiene 50.
5. **PLA-8 (cierra sin confirmación).** Es D-159(d) por diseño («Guardar y cerrar»; destacado cuando el
   reporte cubre el plan) más D-191: el informe lo marca «¿intencional?» y aun así lo pone Media en una sesión
   de arreglo. Llevarlo a «decisión del dueño», no a S.
6. **COT-3 (cantidad deshabilitada).** `sales-document-form.tsx:1571-1577` documenta por qué es `readOnly`
   (D-083, D-116, D-161: la cantidad la manda el editor de largos y «editarla a mano abriría la puerta a
   decir otra cosa»). El «debería» del informe «editar la cantidad donde está la columna» choca con esa
   decisión; solo se sostiene la alternativa «explicar por qué no». También: en mi corrida el campo muestra
   `20` una vez escrito el largo; «vacía» solo es cierto antes de escribir. Placeholder «10»: confirmado
   (`:1793`).
7. **COT-4:** el estado de error dura **450–600 ms** (20 muestras cada 150 ms), no «el primer segundo»;
   sigue siendo real. **FAC-5:** 1.2 s con «Elige un cliente» (`sm-fac5.mjs`), medido sobre `next dev`.
8. **CAT-2 vs §3.1:** la tabla «Decisiones que este informe respeta» pone «Crear producto solo desde
   Catálogo — D-367»; mientras el importador de compras la contradiga, decir «regla aún no aplicada».
9. **D-367 y roles.** La fila dice «`POST /catalog`, ADMINISTRADOR»; correcto para el alta explícita, pero la
   creación automática del `BOB…` sucede al **recibir/crear compras de bobina**, que pueden hacer
   SUPERVISOR_PLANTA (controlador de compras, roles a nivel de clase). Si el dueño decide si D-367 alcanza a la
   automática, esto conviene en la pregunta.
10. **§3.3, «pendiente: bobinas/nueva-xml»** se resuelve: `nueva-xml-view.tsx` no crea nada; llama a
    `POST /purchases/xml/preview` y monta el `PurchaseForm` de compras (`defaultPurchaseValues`, `emptyItem`).
    Entra por el sitio 3 (creación automática) y por nada más.
11. **Estimaciones.** Sesión A «corta (S)»: P-06 toca los `aria-label` que usan al menos **5 specs E2E**
    (`Buscar una bobina para`, `Ejecutar el borrador y cerrar`, `Ítem del kardex`: 8 referencias) y
    `Producir PED`; P-01 pega en 2 aserciones de texto (`Elegí un ítem…`, `…aparecen acá`) — S sigue siendo
    creíble, pero con los specs dentro. **P-14/LOG-2 «M» probablemente es L:** hay que fijar una regla de
    redondeo (`Decimal`, D-003), decidir dónde nace 98.0001 (`38.5467` con IGV → `32.6667` sin IGV, ×3) y
    **corregir lo ya grabado** (comprobantes y cobranzas con residuo) sin SQL contra producción (AGENTS.md
    §3.3 y §3.1). «Empezar por leer producción en solo lectura»: producción se lee por las pantallas o por la
    CLI aprobada, con OK del dueño por comando (D-251), no «solo lectura» a secas.
12. **§5, LOG-1 y LOG-3 son la misma familia** (kg por plancha redondeado a 3 decimales antes de multiplicar:
    9.513 × 20 = 190.260 frente a 190.284 en la reserva). LOG-3 sale del «peso propuesto» que, según la propia
    ayuda del campo, «corrígelo con la báscula»: un peso editable. Fusionarlos y bajarlos (0.01 %); no son
    «Media».
13. **Falsos alarmas que no están en §1** y conviene anotar: el indicador «N» de `next dev` sobre el pie del
    menú (todas las capturas); el texto en inglés «Toggle Sidebar» es `sr-only` y el nombre accesible del
    botón es «Mostrar u ocultar menú» (correcto).
14. **`/inventario` y `/catalogo` abren en «Drywall»** (primera pestaña, vacía en esta base). No es hallazgo con
    datos reales, pero en `compras/nueva` **«Línea de negocio» viene preseleccionada en «Drywall»** con el
    color del valor (no de placeholder): un default silencioso de línea en una compra de coberturas. Media-Baja,
    a confirmar contra la primera línea de negocio de producción.
15. **Cobertura de §1 que no se ejerció:** el mostrador dice «Comprobantes en contingencia… Se envían solos en
    cuanto haya credenciales» con el PSE apagado (fail-closed); vale contrastarlo con lo que hace el sistema
    en producción y con D-153 (series propias del papel). No lo ejercí.

---

## Lo que el informe hizo bien (para no perderlo)

- **LOG-2 es real y material** (ver abajo) y está bien en el primer lugar.
- La numeración (54 hallazgos: COT 10, PLA 11, DES 7, FAC 8, CAT 2, ALM 2, REP 3, ADM 4, PAN 2, SES/ROL 3, TRA
  2), los conteos de severidad (**Media 28, Baja 26**) y que **todos** los IDs caen en alguna sesión de §7
  (comprobado uno a uno) son correctos.
- **§3.4/D-367 respetan la instrucción del dueño:** origen = instrucción del dueño del 2026-09-28, sin fecha
  inventada del 18-09; la razón del cliente **no** se inventa («queda pendiente de que el dueño la dicte»); el
  importador de compras se nombra como **conflicto vigente** con archivo y líneas
  (`importar-compras-view.tsx:897-911`; verificado: `ProductDialog` en `:902`); la relación con D-156 es
  explícita (excepción acotada al producto/SKU, no contradice el brazo 1, muerde en el brazo 2). El
  análisis del brazo 1 («el `ProductDialog` es un acto explícito dondequiera que esté») es correcto contra la
  letra de D-156. Lo que falta está en P1-5 (el error sobre D-150/D-152 y el commit `78f679c`) y el aviso de
  P2-9. La fila mantiene «Sin código», como pidió el dueño.
- El barrido de §3.3 se sostiene: las **dos** únicas escrituras de `product` en el API son
  `catalog.service.ts:221` (`tx.product.create`) y `sales/coil-sale-product.ts:226` (`tx.product.upsert`), y
  `ProductDialog` solo lo usan `catalogo-view.tsx` e `importar-compras-view.tsx`.
- **LOG-2 reproducido en lectura:** `GET /api/invoicing/receivables/summary` (pedido por la propia pantalla)
  devuelve `{"totalBalancePen":"0.0024","totalOverduePen":"0.0000","customerCount":1}` y
  `receivables` lista al cliente con `balancePen: "0.0024"` y `documentCount: 1`, mientras la UI muestra
  «Por cobrar S/ 0.00» / «Clientes 1» / «Comprobantes con saldo: F001-00001401, Total 3,923.50, Cobrado
  3,923.50, Saldo 0.00». El comprobante imprime `Valor unitario S/ 98.0001` (20 × 98.0001 = 1,960.002) y la
  auditoría `Total pen 3923.5024` frente a `Amount pen 3923.5000`. Causa: 115.64 / 3 = 38.5467 (4 decimales,
  con IGV) → 32.6667 sin IGV → × 3 = 98.0001. Aplica a toda plancha cuyo valor por metro no divide exacto:
  con largo 3.00 m eso es **casi todo el catálogo**, no un caso raro. La sección de bugs es real en su
  primer punto; LOG-1/LOG-3 son inconsistencias de redondeo de 0.01 %.

---

## Reproducidos y no reproducidos, por ID

**Reproducidos tal como se describen (medida en DOM/API salvo donde se indica «código» o «captura»):**
COT-1 (con matiz de 224 px), COT-2, COT-3 (con matiz D-083/D-161), COT-4, COT-5 (`scrollW` 334/207 y
244/207), COT-6 (código: `activeProducts` es `[]` sin línea; en vivo solo medí que el botón está
deshabilitado), COT-7 (captura 22, naranja), COT-9 (captura 22: aviso con enlace, sin redirección);
PLA-1 (con P1-9), PLA-2 (captura 35), PLA-3 (captura 37: «Mon…» cortada), PLA-4 (código), PLA-8 (código),
PLA-10 (código), PLA-11 (título «Producción», h1 «Historial de órdenes», menú «Órdenes de producción»);
DES-2, DES-3 (`htmlFor` 0 usos en las 18 celdas; 16/16 rótulos sin control; `combobox` sin nombre), DES-4,
DES-5, DES-7 (con DES-6 parcial); FAC-1 (2002 px en 1078; 8 columnas fuera y 1 cortada), FAC-3, FAC-4
(captura 57), FAC-5, FAC-6, FAC-2 (parcial, P1-3); CAT-2 (código); ALM-1 (con P2-2 y P1-6); ADM-1, ADM-2,
ADM-3 (con P2-3), ADM-4; PAN-1, PAN-2; SES-1 (las cuatro rutas pierden el query;
`/pedidos/<id>` conserva la ruta pero no hay query que perder); ROL-1 (VENDEDOR: 403 en
`/api/inventory/items/search?q=` y el diálogo dice «No hay ninguna opción registrada todavía»), ROL-2 (sin
`h1`; `/auditoria` y `/usuarios` para VENDEDOR); TRA-1 (17 pantallas), TRA-2 (`Elegí un ítem…`, `sin salir
de acá`); REP-1 (barrido: 1612 px en 1076, 6 columnas fuera); LOG-1, LOG-2, LOG-3 (visibles en las pantallas
y el API).

**Reproducidos como falsos o distintos:** **COT-10** (P1-2), **CAT-1** (P1-1), **DES-1** (P0-1),
**PLA-9** (P1-4), y la premisa de **FAC-2** (P1-3).

**No reproducidos / no ejercidos:** PLA-5 y PLA-6, PLA-7 (las OP están cerradas; solo código y capturas
36–41); COT-8, FAC-7, FAC-8, REP-2, REP-3, ALM-2 (redacción y detalles no medidos por mí); PLA-2 por
medida en vivo (razoné sobre la captura 35: las OP están cerradas); FAC-2 con el borrador vivo (el
comprobante ya está aceptado; leí el código y la captura 57); COT-9 en vivo. Tampoco toqué mostrador con
caja abierta, corte, drywall ni importadores con archivo, igual que el informe.

## Pantallas «solo por métricas» que recorrí

Detalle de bobina, detalle de compra, inventario, flejes, usuarios, acabados, POS, corte, panel, catálogo,
cobranzas. Aportan solo lo ya anotado (y P2-14/15); en la **bobina** y la **compra** no vi nada
relevante fuera de TRA-1 (`RF-15`, `RF-53` en los títulos de sección). Lo único no incluido y digno de
entrar: el **pedido** muestra «Fecha prometida: sin fecha» con un campo `dd/mm/yyyy` nativo debajo y sin rótulo
propio ni botón (`31-pedido-detalle`), de baja severidad.

## Resumen de conteos

P0: 1 · P1: 9 · P2: 15 (más la nota de aciertos y las listas de reproducción).

---

## Resolución del autor (2026-09-28)

Los puntos que aportaban un hecho nuevo se verificaron otra vez (COT-10 con una sonda propia, `metersReported`
contra `GET /api/production?status=CLOSED`, `78f679c` con `git show`, `defaultOpen` y el enlace estirado en el
código) y se resolvieron en `docs/analisis/ux-recorrido-2026-09-28.md`:

- **P0-1** (DES-1): tomado, como en la autorrevisión (P1-1).
- **P1-1** (CAT-1) y **P1-2** (COT-10): confirmados falsos; retirados (§1 lo dice).
- **P1-3** (FAC-2): tomado. **P1-4** (PLA-9): confirmado; es LOG-3 nuevo (P-16), y PLA-9 queda solo con la franja.
- **P1-5**: tomado (§3.3 y §3.4; el commit `78f679c` se cita como hecho del repo, sin atarlo a la ronda de feedback).
- **P1-6** (menú lateral): tomado como TRA-3; P-02 empieza por el menú. El detalle de la cookie `sidebar_state` no leída no se verificó; solo se afirma `defaultOpen = true` (`sidebar.tsx:52`).
- **P1-7** (orden de §7): tomado. Pie fijo de «Crear cotización», COT-5, COT-6 y PAN-1 pasan a la sesión A; las dos investigaciones de lógica van primero.
- **P1-8** (D-179): tomado. **P1-9** (PLA-1): tomado.
- **P2 tomados:** 1 (COT-1 224 px y viewport útil ~640), 2 (barra de scroll: «señal débil»; ALM-1 y FAC-1 con las columnas cortadas/fuera), 3 (ADM-3), 4, 5, 6, 7, 8, 10, 11 (specs y estimación de LOG-2), 12 (LOG-1/LOG-3 fusionados), 14 (CAT-4).
- **P2 no tomados:** 9 (quién puede disparar la creación automática del SKU: sin verificar en el controlador de compras), 13 (el `sr-only` de «Toggle Sidebar»), 15 (contingencia del mostrador: no se ejerció).
