# AUTORREVISIÓN — no vale como pase independiente

Revisión de `docs/analisis/ux-recorrido-2026-09-28.md` y de la fila D-367 de `docs/ARQUITECTURA.md` §0.2.
La escribe un subagente nuevo del mismo modelo que hizo el trabajo, sin haber leído ningún handoff. Es una
lista de riesgos, no una aprobación. Rama `docs/recorrido-ux` (desde `main` = bc0c331). Solo lectura sobre el
producto.

**Método.** Cada hallazgo se contrastó con el código (`apps/web/src`, `apps/api/src`, `packages/shared`), con
las decisiones D-nnn de §0.2 y con `local-data/c06/ux/barrido-*.json`. Además cargué `/despachos/nuevo` en la
app viva (sesión propia, `estado-autorrevision.json`, 1366×768) para comprobar DES-1/DES-6. Efectos colaterales
de esa mirada, todos en `local-data/` (ignorada) o en la base `ayr_local_ux`: un archivo de sesión, una captura
(`autorrev-despacho-1366x768.png`) y una sesión/refresh token del login en la base local. Nada más se escribió.

**Veredicto corto.** El informe es sólido en lo medido (desbordes de tabla, alturas, referencias `RF-`, rótulos
sin control) y honesto en sus límites. **No hay P0.** Pero **tres hallazgos están mal juzgados** (DES-1/DES-6,
CAT-1, FAC-2), **uno de los dos «bugs de lógica» está sobredimensionado y con la decisión que ya lo cubre sin
citar** (LOG-2), **otro tiene la causa a la vista y no es la sesión «M» que se propone** (LOG-1/LOG-3), y el
barrido de §3.3 **omite dos hechos que pertenecen a D-367/P-12**. Cuatro de las quince sesiones propuestas
(P-05, P-08, P-12, P-14/P-15) cambian de tamaño o de contenido.

---

## P0 — materialmente engañoso

Ninguno. Ningún error del informe, por sí solo, manda al dueño a una sesión equivocada sin que otra lectura lo
detecte; los P1 de abajo sí cambian prioridad y alcance.

---

## P1 — hallazgo mal juzgado, mal clasificado, omitido, o decisión en conflicto

### P1-1. DES-1 y DES-6 son falsos en lo esencial: el despacho **sí** recuerda y propone (D-078)

- **Afirmación del informe:** «9 campos de transporte a mano en cada despacho… **Nada se recuerda ni se
  propone.**»; propone «datos guardados de almacén, vehículos y conductores; repetir el último» (P-05,
  esfuerzo **L**, «necesita modelo de datos»). DES-6: «placeholders `150101`/`150131`… **parecen valores
  cargados**… debería: campos con valor real por defecto (partida = almacén)».
- **Código:** `nuevo-despacho-view.tsx:97-100` consulta `GET /dispatches/transport-suggestions`
  (`dispatches.service.ts:1150-1203`: últimos 200 despachos → vehículos, conductores, transportistas, orígenes).
  `nuevo-despacho-view.tsx:115-121` **propone la partida más usada** (dirección y ubigeo de partida) al abrir el
  formulario. Los `datalist` de placa (`:499`), conductor (`:530`, y elegir un conductor rellena apellidos,
  documento y licencia, `:519-527`) y transportista (`:598`, rellena la razón social) están cableados.
- **En vivo** (base `ayr_local_ux`, que ya tiene DES-000001): `/despachos/nuevo` abre con «Dirección de partida»
  = `Av. Industrial 1234, Ate` y «Ubigeo de partida» = `150103`; el `150101` solo se ve como placeholder cuando
  el campo está vacío. Es decir, el hallazgo salió de mirar el formulario **con la base vacía** (el primer
  despacho) y no se volvió a mirar después de crear el primero.
- **D-078** (2026-09-04, decisión del dueño) ya dice exactamente esto: «El catálogo de vehículos y conductores
  frecuentes **se difiere**; v1 captura texto libre y lo **autocompleta con los valores usados en despachos
  anteriores**… sin tablas ni ABM nuevos». El informe no la cita en §3.1 y propone lo que D-078 difirió a
  propósito.
- **Qué corregiría:** reescribir DES-1 como «el autocompletado existe pero es un `datalist` sin ninguna señal
  visible (no hay flecha ni ayuda), y un usuario nuevo no lo descubre; la primera vez son 9 campos a mano».
  Severidad Media→**Baja**, esfuerzo L→**S**. DES-6 se elimina (la partida ya se propone) o se reduce a «el
  ubigeo de **llegada** sigue como placeholder». P-05 deja de ser una «sesión grande que necesita modelo de
  datos»: queda DES-2 (mover «Qué sale» arriba, S) y, si acaso, una pista visual del autocompletado. Citar D-078
  en §3.1.

### P1-2. CAT-1 es falso: el enlace a Acabados abre **pestaña nueva** y no pierde lo escrito

- **Afirmación (CAT-1 y §3.4, último punto):** «Créalo en Acabados **saca al usuario del formulario y pierde lo
  escrito**: el callejón que D-156 quiso evitar».
- **Código:** `purchase-form.tsx:1088-1098`: `<Link href="/acabados" target="_blank" rel="noopener">`, con el
  comentario en `:1089` «Pestaña nueva: salir de acá pierde la compra a medio cargar», y el texto termina «y
  vuelve a abrir el selector». El formulario nunca se abandona.
- **Además choca con D-203** (F8-S4/M1-M2, feedback del cliente): «el color de la bobina sale del acabado… el
  formulario **nunca inventa un color ni un acabado**»; `purchase-form.tsx:1069-1071` lo cita. «Alta desde el
  formulario (como el cliente)» —la propuesta de CAT-1— es lo contrario de una decisión vigente y no se
  reconoce como tal.
- **Qué corregiría:** retirar CAT-1 como callejón. Lo que sí queda es una fricción S/Baja: tras crear el acabado
  en la otra pestaña hay que reabrir el selector (¿refresca la lista? no se comprobó). Sacarlo de P-12, que
  queda reducida a CAT-2 (más el P1-6). Quitar la frase equivalente de §3.4 («El mismo callejón existe hoy para
  otros maestros…»).

### P1-3. FAC-2 (y «vale hoy en producción» de P-08): la jerarquía de botones la decide un ajuste global

- **Afirmación:** en el borrador, «Emitir y enviar al PSE» es «el primero y el azul»; «Registrar manual, lo
  único que funciona hoy en producción, queda secundario». Vale «hoy en producción» (§7, P-08).
- **Código:** `comprobante-detalle-view.tsx:440` `manualIsDefault = settings.data?.manualByDefault === true` y
  `:631-632` `primary={[manualIsDefault ? 'manual' : 'send', …]}`, `companion={… manualIsDefault ? 'send' :
'manual'}`. Es `invoicing_settings.manual_by_default` (`schema.prisma:2016`, default `false`), que D-153
  describe («un ajuste global solo decide cuál de los dos botones viene destacado») y que se cambia en la
  tarjeta de contingencia (`contingency-card.tsx:90-97`).
- **Problema:** el recorrido corrió con el default `false`. AGENTS.md §8 dice que producción hoy emite «solo
  comprobantes manuales por ahora»; si el dueño ya prendió `manual_by_default`, FAC-2 no existe en producción.
  El informe no lo comprobó ni lo menciona.
- **Qué corregiría:** FAC-2 pasa a «depende de un ajuste; **verificar el valor en producción (solo lectura)**
  antes de asignar sesión». Lo que sí es independiente del ajuste es la razón solo en `title` de los botones
  deshabilitados (DES-4, `despacho-detalle-view.tsx:165`; y los `title` de `comprobante-detalle-view.tsx:568-…`),
  que sigue siendo válido. P-08 se reduce a esa parte.

### P1-4. LOG-2 es real, pero «Alta», «para siempre» y el orden #1 no se sostienen; falta D-169

- **Causa localizada** (lo que se pidió): el 98.0001 nace de un viaje de ida y vuelta redondeado a 4 decimales.
  Al elegir el producto, el formulario siembra el precio con `fixedLengthValuePerMeter(largo, lista)` = 98/3
  (`sales-document-form.tsx:649-651`); con IGV queda 38.5467; al armar la línea, `lineValues`
  (`:374-385`) hace `money(38.5467/1.18)` = **32.6667** (escala 4) y `money(largo × 32.6667)` = **98.0001**. El API
  repite la cuenta: `sales-lines.ts:451-454` `money(fixedLengthUnitValue(largo, valuePerMeterPen))`
  (`packages/shared/src/schemas/roofing.ts:287-292`). La causa es guardar el valor **por metro** con 4 decimales
  y multiplicarlo por el largo: cualquier lista por plancha no divisible exacta por el largo la reproduce.
- **Por qué el saldo queda en 0.0024:** `documentBalance` (`packages/shared/src/schemas/invoicing.ts:142-145`)
  resta a 4 decimales: 3 923.5024 − 3 923.5000 = 0.0024 > 0, y `invoicing.service.ts:3055` filtra «con saldo» con
  `.gt(0)`; la pantalla redondea a `S/ 0.00` (`comprobante-detalle-view.tsx:917-…`).
- **Lo que el informe omite: D-169** (`payableBalance`, `invoicing.ts:161-163`; `receivables.service.ts:151-157`).
  El cobro se compara **en céntimos hacia arriba** precisamente para que un saldo de diezmilésimas «se cierre»:
  con saldo 3 923.5024 se admite hasta **3 923.51**, y eso lo deja en 0 (el excedente lo absorbe
  `documentBalance`). Además el diálogo de cobro se **precarga con `balancePen`** (`comprobante-detalle-view.tsx:1023`
  `setPayAmount(d.balancePen)` = 3 923.5024), así que el camino por defecto **sí cierra**. El residuo aparece
  solo si el usuario teclea la cifra del papel (3 923.50). «Deja la factura con saldo **para siempre**» es falso;
  D-169 dice textualmente que arregla «la clase entera, que también alcanza a un precio tipeado».
- **Qué corregiría:** severidad **Media**, no Alta (no se pierde dinero ni se factura mal: el total de papel
  3 923.50 y el interno 3 923.5024 difieren por 0.0024 y hay una vía de cierre). Citar D-169 y decir qué
  queda realmente abierto: (a) el total interno lleva cola de diezmilésimas que el papel no tiene y (b) el
  cobro exacto del papel no cierra. Mantenerlo entre las primeras sesiones está bien (toca cobranza), pero como
  «M, pequeño y localizado» y no como la única Alta. La verificación «en producción, solo lectura» que propone
  el informe es razonable.

### P1-5. LOG-1 y LOG-3 no necesitan «que alguien confirme qué cifra manda»: la causa está en el código y es de redondeo (S, Baja)

- Los tres números de la plancha (60 m de bobina, 20 planchas de 3.00 m) salen de aritmética sobre
  **valores ya redondeados a 3 decimales por el API**:
  - «190.260 kg a reservar» = `kgPerMeter` (3.171, redondeado con `.toFixed(3)` en `sales-orders.service.ts:3369-3375`)
    × 60 m, en el navegador (`sales-document-form.tsx:2296-2312`).
  - «≈ 190.280 kg» junto a Cantidad = `theoreticalKgPerUnit` (9.514 = `.toFixed(3)`, `catalog.service.ts:990-1000`)
    × 20 (`sales-document-form.tsx:1599-1600`).
  - «190.284 kg» = la cuenta exacta (9.5142… × 20) que hace el API al confirmar/reservar.
    La línea a medida cuadra igual: 42 m × 3.171 = 133.182 (despacho) frente a 133.200 exacto.
- **LOG-3** es lo mismo: 323.483 = 190.284 + 133.199 (lo reservado) frente a 323.462 = 190.280 + 133.182 (suma
  de líneas por unidad redondeada). Y el campo es **editable con ayuda explícita**: «corrígelo con la báscula»
  (`nuevo-despacho-view.tsx:464`).
- **Qué corregiría:** no es «lógica»: es precisión de presentación. Severidad **Baja**; esfuerzo **S** (no
  redondear el `kgPerMeter`/`theoreticalKgPerUnit` del DTO, o enviarlo con más decimales, y redondear solo al
  mostrar). P-15 pasa de «M, de lógica, empezar por confirmar» a «S». El único riesgo real (un «alcanza» que
  no alcanza por 0.024 kg) es despreciable. Conviene, sí, que el informe lo diga con la causa, porque hoy deja
  al dueño con la impresión de que hay dos bases de kilos en pugna.

### P1-6. Omisiones del barrido §3.3 / §3.4 que pertenecen a D-367 y a P-12

1. **El importador de compras muestra «+ Crear» producto a quien no puede crearlo.** La pantalla se abre para
   ADMINISTRADOR **y SUPERVISOR_PLANTA** (`importar-compras-view.tsx:259`), y el botón se muestra con la sola
   condición `businessLine !== null` (`:886-899`); el `ProductDialog` llama `POST /catalog`
   (`product-dialog.tsx:312`) que es **solo ADMINISTRADOR** (`catalog.controller.ts:117-118`). Un supervisor
   abre el formulario completo, lo llena y recibe 403. El informe menciona «ADMINISTRADOR» en el sitio 1 pero no
   ve el desajuste en el sitio 2. Es un hallazgo de UX/rol (Media, S) y un dato para P-12 (si se mantiene el
   botón, hay que ocultarlo por rol).
2. **El importador de cotizaciones promete un botón que ya no existe.** `cotizaciones/importar/importar-view.tsx:465`
   («un cliente o un producto que falta se crea con el botón de al lado, sin salir de acá») y `:1239` («…o
   créalo con el botón de al lado») describen la alta de producto que D-156 introdujo **en este importador**; el
   commit `78f679c` (2026-09-18, «simplificar selectores y altas contextuales») la quitó (hoy solo hay
   `ExpressCreateCustomer`, `:748`). Es el callejón que D-156 midió (141 filas), de vuelta, con el texto
   mintiendo. §3.4 dice que «los formularios de venta (cotización, pedido, comprobante) ya no ofrecían crear
   productos» pero no menciona este importador, que es justamente el origen de D-156. Hallazgo nuevo (Media, S:
   corregir el texto o decidir, junto con D-367/P-12, qué se hace ahí).
3. Menor: el informe afirma que el importador de cotizaciones lo «retiró D-150». D-150 retiró el módulo de
   importaciones anterior; el actual (`imports/quotation-import.service.ts`, D-152) existe y sigue vivo. La
   conclusión («no crea productos», solo clientes desde el padrón, `:555-597`) es correcta; la explicación no.

### Lo que verifiqué del barrido §3.3 y salió bien

`product.create` solo en `catalog.service.ts:221`; `product.upsert` solo en `sales/coil-sale-product.ts:226`
(más el spec). Los cinco disparadores de `ensureCoilSaleProduct` con esas líneas exactas
(`purchases.service.ts:437`, `coil-operations.service.ts:161/171`, `cutting.service.ts:285/295`,
`initial-inventory-import.service.ts:145`, `coil-operations.service.ts:952`→`ensureTradingProduct`,
`coils.service.ts:342`). No hay `createMany`/`connectOrCreate`/`INSERT INTO products` en `apps/`, `scripts/`,
`prisma/` (seed sin productos, migraciones sin `INSERT INTO products`). `bobinas/nueva-xml` solo llama
`/purchases/xml/preview` (`nueva-xml-view.tsx:20`): no crea; el «pendiente de verificar» queda cerrado. `ProductDialog`
solo se monta en `catalogo-view.tsx:436` e `importar-compras-view.tsx:902`. La cuenta «2 sitios explícitos + 1
automático con 5 disparadores» es correcta.

---

## P2 — matices, redacción, cifras, severidad y esfuerzo

**Severidad / esfuerzo que cambiaría**

- **PLA-1 (Media→Baja).** La tarjeta del pedido entera es el clic (`planta/pedido-list.tsx:79-93`: enlace
  estirado con `after:absolute` y `hover:bg-muted/40`, comentario «la tarjeta entera es el clic»). El informe
  dice que «no muestra ningún botón» y que el código «no parece entrada»; lo que falta es una señal visible,
  no un acceso. Queda como ayuda visual (S).
- **PLA-8 (Media→Baja) y contexto.** Cierra sin confirmar, sí (`roofing-order-panel.tsx:940-957`), pero
  «Guardar y cerrar» es la acción destacada decidida en D-159/D-191, y **reabrir existe**
  (`roofing-production.controller.ts:272`, `production.controller.ts:127`; y D-360 acaba de hacer que reabrir
  devuelva la bobina). El informe no menciona que el cierre es reversible.
- **PLA-10.** El texto real es «no tiene órdenes **abiertas**» (`planta-view.tsx:611`), no «no tiene órdenes».
  El fallo es el «Genéralas desde el detalle» (CTA equivocado), no que «parezca que nunca tuvo».
- **ROL-1 (Media→Baja).** La causa es un `RoleGate` desactualizado: `kardex-view.tsx:213` permite VENDEDOR,
  pero el menú (`nav.ts:175-179`) y el API (`inventory.controller.ts:56-57,69-70`, `items/search` solo ADMIN y
  SUPERVISOR_PLANTA) no. Llega solo tecleando la URL. El comentario de `nav.ts:287` («`/kardex` lo ven los tres
  roles») es lo que quedó de la Fase 2b. Arreglo de una línea; conviene barrer otros `RoleGate` contra `NAV`
  (no lo comprobé).
- **ADM-1 (M→S) y ADM-3.** Ya existe el mapa de rótulos y valores en español (`lib/audit-labels.ts:209-222`,
  `humanizeFieldKey` de respaldo) y `EventDiff` ya muestra **solo lo que cambió**
  (`auditoria-view.tsx:88-120`, D-218); lo que se ve en inglés son las claves y valores que **faltan en el
  mapa** (`Method`, `Amount pen`, `ISSUED_HERE`…). El «debería» del informe es en parte lo ya implementado. Es
  completar diccionarios, no una sesión M-L; ADM-3 (densidad y ancho) sí es M.
- **PLA-3 sin cifra verificable por mí.** El barrido no cubre diálogos abiertos; las medidas (905/862) dependen
  de la sesión viva. No las contradigo, no las confirmo.
- **COT-2.** El «una sola base de IGV por vista» choca con D-162(b): «se tipea el precio con IGV y el sistema
  deriva el valor, **mostrando los dos**». §3.1 ya cita D-161 a D-163 «lo hallado es cómo se muestra», pero el
  «debería» debe acotarse a «menos números», no a «una base».
- **COT-3.** El campo deshabilitado es deliberado (`sales-document-form.tsx:1571-1578`, D-083/D-161: la
  cantidad la manda el editor de largos); lo hallado es solo la señal. Media→Baja si se quiere ser estricto.
- **PAN-2 / SES-1 / ADM-4:** confirmados; PAN-2 Media es generosa (contadores informativos), Baja razonable.

**Cifras**

- §0 dice «P-01, P-06, P-08, P-11 y P-13 son **media/S**», pero en §7 P-01 y P-13 son **Baja**; y §0
  llama a P-02/P-04 «las de mayor efecto en 1366» mientras §7 dice de P-03 «el mayor efecto para el
  vendedor». Unificar.
- «A 1920×1080 el barrido marca 6 pantallas de 50; a 1366×768, 13» **cuadra con el JSON** (recalculado: 13 y 6),
  pero engaña algo: de las 6 de 1920, 5 no dependen de la resolución (`despachos/nuevo`, `corte/nueva`,
  `configuracion/reservas`, compra, auditoría); las que dependen de 1366 son 7 y **3 no son problema**
  (2 desbordes de 12 px y el falso positivo de `/comprobantes`). Los desbordes reales de tabla a 1366 son
  6 (comprobante, bobinas, reporte de bobinas ×2, ventas por material, auditoría).
- §8 encabeza «Barrido de **49** pantallas»; el JSON y §0/§8 tabla dicen **50** (`barrido-*.json`, 50 filas).
- TRA-2: en `apps/web/src` hay 109 «acá» en 52 archivos (patrón propio, incluye comentarios); el informe da «96
  en 45». Más importante: **hay voseo también en mensajes del API que llegan al toast**
  (`invoicing.service.ts:218` «acá», `:690` «volvé a intentarlo»; `roofing-production.service.ts:299` «anulá el
  pedido y volvé a confirmarlo»). P-01 dice «textos de interfaz»; el barrido de sesión no ve los que solo salen
  al fallar. Añadirlos al alcance. También `importar-view.tsx:466` («sin salir de acá»).
- ADM-4: el paréntesis «(única de las 50 que no es una pantalla sin permiso)» es confuso; el JSON solo dice que
  `/configuracion/reservas` es la única con `sinH1` (`reservas-config-view.tsx:57-`: usa `CardTitle`, no `h1`).
  Correcto en el hecho.
- FAC-1: 19 columnas y 2002 px en 1078 coinciden con el JSON (`cols: 19`, fuera: 9); a 1920: 2002/1632, 3 fuera. ✓.

**D-367 (fila de §0.2)**

- La fila cita «desplegado el 2026-09-27 con **D-351/D-353**». D-353 es «Recibir seleccionadas» (nada que ver con
  crear productos); el respaldo del «+ Crear» del importador es **D-351 (3)** («el producto sí con el alta de
  siempre desde el campo, D-156»). Quitar D-353.
- D-351 (3), del día anterior y del propio dueño, **afirma** el «+ Crear» del importador como parte del diseño;
  D-367 lo llama «conflicto vigente, no se toca», que es la forma correcta de tratarlo. Bien. Pero el enunciado
  en negrita («**Un producto o SKU se crea solo desde Catálogo**») es absoluto y D-257 deja el SKU `BOB…` «se
  generan solos»; la fila lo reconoce más abajo. Sugiero anteponer «de forma interactiva» al enunciado para que
  no se lea mal solo.
- Consistencia con AGENTS.md regla 16: la fila registra una regla de producto sin implementar con origen
  «instrucción del dueño relatada»; queda claro y no inventa razón del cliente. Aceptable. No hay colisión con
  otras D-nnn: D-367 es la última existente y las P-01…P-15 no aparecen en ningún otro archivo del repo
  (`grep` en `docs/`, `apps/`, `packages/`, `e2e/`, `scripts/`, `.claude/`, `.agents/`).

**Propuestas P-01…P-15: entre sí y con lo existente**

- Sin colisiones de número ni de contenido entre sí. P-12 debe rehacerse (P1-2, P1-6); P-05 (P1-1); P-08
  (P1-3); P-14/P-15 (P1-4, P1-5).
- **Coste E2E no mencionado.** P-06 (renombrar `aria-label`) toca al menos 5 specs
  (`correcciones-03-listas-kardex`, `huecos-cobertura-f8s3`, `multi-montar-f8s3`, `planta-espacio-produccion-ui`,
  `reabrir-bobina-montar-f8s3`; 9 referencias); P-03 (editor de líneas) toca los ~11 specs que buscan
  «Cantidad de la línea»/«Producto de la línea». P-03 «L» está bien puesto; P-06 «S» se queda corto si se
  cuentan los specs.
- **Enmarque «operario».** §0 y §7 hablan de «pantallas de operario» y «la pantalla de planta se usa todo el
  día»; D-179 dice que el **operario de planta no usa la app** y que el supervisor ingresa todo. Es el mismo
  usuario de escritorio, pero el marco puede llevar a diseñar para táctil, que D-179 descarta.

**Menores no listados por el informe**

- Su propia sonda marcó `textosEnIngles: ["Toggle Sidebar"]` en el despacho (visto en mi corrida): el disparador
  del menú tiene el nombre accesible «Mostrar u ocultar menú» y el texto interno en inglés. No está en TRA-2.
- `seller-dashboard-cards.tsx` (Panel) escribe «Con OP viva en progreso o **draft**» (jerga en inglés) y usa
  `md:`/`lg:` para la grilla, contra D-179(a); cosmético, entra bien en PAN-2.

---

## Hallazgos **confirmados** (verificados por mí en código, en el barrido JSON o en vivo)

Confirmados tal cual o con los matices de P2:
**COT-2, COT-3, COT-4, COT-6, COT-8**; **PLA-4, PLA-8** (con caveat), **PLA-9**; **DES-2, DES-3, DES-4**;
**FAC-1, FAC-3, FAC-6**; **ALM-1, ALM-2** (nombre accesible); **REP-1**; **ADM-1** (real, más barato),
**ADM-2, ADM-3, ADM-4**; **PAN-1, PAN-2**; **SES-1, ROL-1** (Baja), **ROL-2**; **TRA-1** (17 pantallas, del
JSON), **TRA-2** (con alcance ampliado); **LOG-2** (real, Media, con D-169), **LOG-1 y LOG-3** (reales como
redondeo de presentación, Baja, S).

Confirmados con severidad rebajada: **PLA-1, PLA-10, COT-3**.

**Falsos o no sostenidos:** **CAT-1** (falso, P1-2), **DES-1** (falso en «nada se recuerda», P1-1), **DES-6**
(ya resuelto tras el primer despacho, P1-1), **FAC-2** (depende de `manual_by_default`, sin comprobar en
producción, P1-3).

**No verificados por mí** (dependen de estado vivo o de capturas que no reprodujo esta revisión; no los
contradigo): COT-1, COT-5, COT-7, COT-9, COT-10, PLA-2, PLA-3, PLA-5, PLA-6, PLA-7, PLA-11, DES-5, DES-7,
FAC-4, FAC-5, FAC-7, FAC-8, REP-2, REP-3, CAT-2 (cierto en el código: `importar-compras-view.tsx:897-911`).

**Añadir** (hallazgos nuevos, P1-6): «+ Crear» producto visible para SUPERVISOR_PLANTA en el importador de
compras con `POST /catalog` solo ADMINISTRADOR (Media, S); texto obsoleto del importador de cotizaciones que
promete un botón de producto inexistente (Media, S).

---

## Resolución del autor (2026-09-28)

Cada P1 se verificó otra vez en el código o en la app antes de aceptarlo (no se tomó de palabra) y se
resolvió en `docs/analisis/ux-recorrido-2026-09-28.md`:

- **P1-1** (DES-1/DES-6): confirmado en `nuevo-despacho-view.tsx:97-121`; reencuadrados (Baja, S), D-078 citada, P-05 baja a S.
- **P1-2** (CAT-1): confirmado (`purchase-form.tsx:1092`, `target="_blank"`); retirado. P-12 queda con CAT-1/2/3 nuevos.
- **P1-3** (FAC-2): confirmado (`comprobante-detalle-view.tsx:440`); pasa a Baja y «verificar el ajuste en producción».
- **P1-4** (LOG-2): confirmado con D-169 (`payableBalance`, `invoicing.ts:161-163`); pasa a Media, sin «para siempre».
- **P1-5** (LOG-1/LOG-3): tomado; fusionados como redondeo de presentación (Baja, S). El detalle de líneas de `sales-orders.service.ts` se cita como «equivalentes» sin número de línea (no lo verifiqué).
- **P1-6**: confirmado y agregado como CAT-1 (SUPERVISOR_PLANTA ve «+ Crear») y CAT-3 (texto obsoleto del importador de cotizaciones); §3.3 corregido (D-150/D-152; commit `78f679c`).
- **P2 tomados:** PLA-1, PLA-8, PLA-10, ROL-1, ADM-1, COT-2, COT-3, cifras 49/50 y media/Baja, D-353 fuera de la fila D-367, «de forma interactiva» en el enunciado, coste de specs E2E (P-06/P-01), encuadre «operario»→supervisor (D-179), voseo del API en TRA-2, 13 vs 6 pantallas separadas por dependencia de la resolución (§8).
- **P2 no tomados:** la observación de `seller-dashboard-cards.tsx` («draft», `md:`/`lg:`) y el nombre accesible de «Toggle Sidebar» (menores; sin verificar).
