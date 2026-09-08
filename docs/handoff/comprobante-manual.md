# Handoff — Sesión Comprobantes manuales — 2026-09-08

## 1. Resumen

Dos cosas. **D-131 pasó de decisión a regla dura** (`CLAUDE.md` nº 14) con su centinela, después
de que la misma confusión causara dos defectos, el segundo el día anterior. Y **D-153**: un
borrador de comprobante tiene ahora dos terminales excluyentes — emitirlo por el PSE, o
registrarlo manual con el número del papel que la empresa emite desde otra app mientras dura la
migración. El diseño se te presentó antes de escribir una línea y se implementó lo que aprobaste.

`pnpm turbo lint typecheck test` en verde (**279/279**). E2E del comprobante manual **7/7**;
regresión de facturación con las fallas conocidas del cupo del PSE demo. **Nada desplegado y sin
push**; producción no se tocó ni para leer.

---

## 2. Hecho

### D-131 pasa a invariante

`sellsByLength(product)` —la unidad— responde _¿esta línea necesita el detalle de largos?_, y
`isMadeToMeasure(product)` —el subtipo— responde _¿se fabrica contra pedido desde materia
prima?_. Son dos preguntas distintas, las dos devuelven `boolean`, y el compilador nunca avisa
cuando se responde una con la otra. Ya costó dos defectos: el mostrador vendiendo material a
medida, y el importador de cotizaciones dejando pasar sin marca toda línea en `MTR` que no fuera
`A_MEDIDA`.

Ahora hay **una sola definición**, que el importador también usa, la regla está en `CLAUDE.md`
como la 14, y el centinela es `apps/api/src/sales/sales-lines.spec.ts` — la tabla completa de
unidad × subtipo, más una aserción que se cae si alguien define una pregunta en términos de la
otra.

### D-153 — el borrador tiene dos terminales

**El modo es un tercer valor de `FiscalDocumentOrigin` (`MANUAL`), no un campo aparte**, y el
motivo se pudo medir antes de decidir: hay siete ramas que miran `origin`, y la que importa es
una función llamada `assertIssuedHere` cuya prueba era `!== IMPORTED`. Con un campo ortogonal
esas siete guardas habrían seguido **dejando pasar un manual a Nubefact**; con un valor nuevo se
dan vuelta a `=== ISSUED_HERE` y el comportamiento cae solo.

`POST /invoicing/documents/:id/register-manual` cierra el borrador con la serie y el correlativo
del papel: `seriesId = null` —la serie del talonario no es una fila de `fiscal_series`, y
adelantar esa tabla quemaría rango de las series con las que facturás de verdad—, nace
`ACCEPTED` por el mismo motivo que un importado (D-105), sin CDR ni XML. Que los dos terminales
partan del **mismo borrador** es lo que garantiza que un manual pase por las mismas validaciones
que un electrónico.

Lo demás: la **nota de crédito hereda el modo de su afectado** (guarda en cada terminal); la
anulación interna de D-110 se generalizó y cubre todo lo que el ERP no emitió; el pre-llenado de
serie y correlativo desde el `Factura externa: FFA1-1349` que el importador (D-152) deja en las
observaciones del pedido; el ajuste global `manual_by_default`, que solo decide cuál botón viene
destacado con los dos siempre visibles; y en el listado, badge de origen y filtro por origen.

### Lo que pediste y no hizo falta hacer

Pediste que "la salida de stock sea idéntica en ambos modos, misma ruta
`InventoryService.record()`". **El comprobante no mueve kardex en ningún modo**: lo mueve el
despacho (D-074), por un solo camino. La garantía ya existía por construcción, así que no toqué
nada — y quedó con su caso de prueba, porque la pregunta va a volver.

### El defecto de D-145, otra vez

Registrar el primer manual devolvía **`500` sin mensaje**. Dos `CHECK` de la base escritos
cuando la regla era más angosta: `fiscal_documents_number_ck` exigía que el número viniera
siempre con un `series_id`, y `fiscal_documents_annulled_origin_ck` reservaba `ANNULLED` a lo
importado —o sea, un manual mal registrado no tenía vuelta—.

Es D-145 exactamente: código que ensancha una regla, base que sigue diciendo la anterior, 500
mudo como único síntoma. La diferencia es que **esta vez no llegó a desplegarse**, porque el
spec incluía la reversa además del caso feliz. Corregidos en una migración aparte, separada a
propósito de la que agrega el modo: editar una migración ya aplicada le cambia el checksum y
rompe `migrate deploy`.

**La lección: al agregar un valor a un enum que la base conoce, hay que ir a leer sus `CHECK`.**
El compilador no los ve.

### Lo que la revisión encontró

Dos **bloqueantes míos**, los dos por el mismo descuido: escribí dos expresiones regulares a
través de un heredoc de shell y se comieron los backslashes, así que `/^\d{1,8}$/` quedó como
`/^d{1,8}$/`. Resultado: el botón "Registrar" **nunca se habilitaba** y el pre-llenado **nunca
matcheaba**, con el fallo tapado por un `catch`. Los E2E por API no lo veían porque no pasan por
la pantalla.

Cuatro **altos**, todos de la misma familia — código que preguntaba `!== IMPORTED` y ahora dice
algo falso: `voidPath` ofrecía "Dar de baja" en un manual, `canAnnul` dejaba la reversa
inaccesible desde la UI, y `canQuery` mostraba "Consultar al PSE" en todos los manuales. Más el
terminal manual sin `assertOwnership`, que dejaba a un vendedor cerrar el borrador de otro.
Corregidos con un único `isExternal`, que es la pregunta que esas tres querían hacer.

Medios corregidos: el choque de número entre dos registros simultáneos salía como 500 en vez de
409; `acceptedAt` quedaba nulo y —con `NULLS FIRST`— un manual ganaba el desempate y desplazaba
a la factura electrónica del respaldo de una guía; el badge del detalle seguía marcando solo lo
importado; y dos huecos de test que el propio revisor señaló como "el mismo hueco de D-145":
ahora hay un caso que **anula un manual de verdad** y otro que comprueba que **ninguna de las
cuatro puertas al PSE lo acepta**.

Ese último lo escribí mal la primera vez: asertaba que el barrido `send-pending` devolviera cero,
y `send-pending` es **global** —barre hasta veinte documentos de toda la base—, así que el número
dependía de lo que otras pruebas dejaran (devolvió 7) y, peor, **llamarlo mandaba al PSE demo
comprobantes ajenos al escenario**, quemando cupo de la cuenta. El barrido salió del test.

---

## 3. Decisiones tomadas

| ID        | Una línea                                                                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-153** | Un borrador tiene dos terminales excluyentes: emitirlo por el PSE o registrarlo manual. El modo es un tercer valor de `origin`, para que las guardas existentes lo cubran solas. |

RF actualizados: RF-70 (los dos terminales), RF-75 (un manual no se da de baja ante SUNAT desde
el ERP) y RF-76 (la nota de crédito hereda el modo). `CLAUDE.md` gana la regla dura 14.

---

## 4. Bloqueos y pendientes

### Lo que necesita acción tuya

- **Dar el OK para desplegar.** Está commiteado en local y **sin push**.
- **Decidir si activás el modo manual por defecto** (`Configuración → estado del envío al PSE`).
  Mientras esté apagado, el botón destacado sigue siendo el electrónico.
- **Los servidores de `pnpm dev:local` quedaron abajo**; relevantalos cuando los necesites.

### Anotado, no hecho

- **Las series manuales no se validan contra un maestro**: cualquier `F###` bien formado entra.
  Es a propósito —el talonario de la otra app no está en este ERP— pero significa que un error
  de tipeo en la serie solo lo atrapa el ojo de quien registra, no el sistema.
- **Un manual no se puede corregir**: si el número quedó mal, hay que anularlo internamente y
  registrar otro. Alcanza para hoy; si pasa seguido, vale una ruta de corrección.
- El revisor anotó tres cosas de `scripts/dev-local-view.mjs` (arma el mensaje de error con
  `args.join(' ')` en vez de usar `run` de `scripts/lib.mjs`, imprime la contraseña local, y la
  numeración de pasos va "1/3, 2/4"). **No es de esta sesión y no lo toqué**; el primero es la
  forma que la regla dura 5 nombra como el escape de D-128, aunque hoy no viaje ninguna
  credencial por `argv`.

---

## 5. Cómo verificar

```bash
pnpm turbo lint typecheck test        # verde (279/279)
pnpm exec eslint e2e
pnpm exec prettier --check apps packages e2e docs CLAUDE.md

# **Antes de correr E2E**: matar cualquier servidor viejo en :3000/:3001 — `reuseExistingServer`
# reusa el que encuentre y el síntoma es `Login admin falló: 401`.
netstat -ano | grep LISTENING | grep ":300"

pnpm e2e comprobante-manual comprobante-manual-ui   # D-153
pnpm e2e fase7b-bordes m4-anulacion-importado fase5b-bordes   # regresión de facturación
```

Las fallas de `fase5b*` que dicen _"No puedes enviar mas de 50 documentos en una cuenta DEMO"_
son el cupo del PSE de pruebas, no el código.

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126).

### Checklist de deploy — sin correr, esperando tu OK

```bash
pnpm turbo lint typecheck test build && pnpm format:check && pnpm exec eslint e2e
pnpm db:prod     # 20260908210000_d153_... y 20260908213000_d153_checks_...
pnpm deploy:api
# Web: por push a main (integración Vercel-GitHub)
pnpm smoke:prod  # solo lectura (D-126)
```

**El orden importa: la migración va primero, y esta vez no es opcional.** La primera agrega el
valor `MANUAL` al enum y la segunda afloja dos `CHECK`; el API viejo contra la base ya migrada
funciona igual (nunca escribe `MANUAL`), pero el API nuevo contra la base **sin** migrar
devuelve el mismo 500 mudo que apareció en local. Siguen pendientes además las migraciones de
las dos sesiones anteriores (D-145 y D-146), las dos aditivas.

---

## 6. Siguiente sesión

1. **Usar lo que se construyó**: cargar agosto con el importador de cotizaciones (D-152) y
   registrar sus comprobantes con el modo manual. Es el ciclo completo que estas tres sesiones
   vinieron a habilitar.
2. **Fase 8 — auditoría, reportes y UAT**, la siguiente según §3.7.
3. **7f sigue sin alcance escrito**, arrastrado desde hace tres handoffs.
