# Handoff — Sesión Planta III — 2026-09-09

## 1. Resumen

Cuatro decisiones (**D-157..D-160**) y un tema común: terminar de sacar los pasos que el
sistema inventaba. El importador de cotizaciones deja de crear documentos que nacen vencidos y
puede dar de alta al cliente que falta desde el padrón; producción pasa de dos pantallas a
medias a **una sola**, con el plan editable, el reporte que llega relleno y un cierre que le
devuelve la bobina a la orden hermana en la misma transacción.

`pnpm turbo lint typecheck test` en verde (**300/300** unitarios), `prettier --check` y
`eslint e2e` limpios. E2E local: **26/26** de los specs de esta sesión y **55/55** de la
regresión de coberturas y ventas.

**Nada desplegado y sin push**; producción no se tocó ni para leer.

---

## 2. Hecho

### M0 — El importador de cotizaciones (D-157, D-158)

**Sin fecha de vencimiento (D-157).** El importador creaba las 71 cotizaciones de agosto con
la vigencia por defecto —siete días— sobre una emisión de hace un mes: **nacían vencidas**, y
`confirm()` las rechazaba una por una en el paso siguiente al que acababa de crearlas.
`quotations.valid_until` pasa a nullable
(`20260909180000_d157_cotizacion_sin_vencimiento`, aditiva) y `NULL` significa **no vence**.

Lo que vale del cambio no es el `null` sino la función: `validUntil < businessToday()` escrito
suelto convierte la ausencia en `'' < hoy` —vencida desde siempre— y el compilador no avisa,
porque las dos son comparaciones de cadenas válidas. Hay **una sola** función que responde la
pregunta, `isQuotationExpired(validUntil, hoy)` en `packages/shared/src/schemas/sales.ts`, y
los cuatro lugares del API que comparaban pasan por ella. El `null` **no viaja por HTTP**:
`createQuotationSchema` sigue exigiendo la vigencia y el importador lo pasa por código con
`CreateQuotationInternalInput`.

**El padrón y el cliente del comprobante (D-158).** Cuando el RUC/DNI del archivo no está en
el maestro, `apps/api/src/imports/quotation-import.service.ts` lo consulta contra apis.net.pe
(el servicio de D-029/D-067, con `MAX_PADRON_LOOKUPS = 80` y concurrencia 6, porque la cuota
es una sola) y la cabecera muestra **«Nuevo — se creará desde padrón: \<razón social\>»**. Al
confirmar se crea con `CustomersService.createInTx` **dentro de la transacción del archivo**.

Es una excepción controlada a D-152, y lo que la separa de la creación silenciosa de D-138 son
tres cosas concretas: está a la vista antes de apretar, la decide una persona que puede elegir
otro cliente en el mismo campo, y **lo que se escribe no lo elige el navegador** — la fila
manda solo el documento; con el nombre en el request, editar el cuerpo alcanzaba para dar de
alta «PROVEEDOR S.A.C.» bajo un RUC ajeno. Las consultas se resuelven **antes** de abrir la
transacción y, si falta una, no se importa nada.

Además, **el cliente subió a la cabecera del acordeón**
(`apps/web/src/app/(app)/cotizaciones/importar/importar-view.tsx`): una factura es de un solo
cliente y sus diez líneas lo heredan. Y el **plan de corte llega relleno** con la sugerencia
`1 × los ML de la línea` (`suggestedRoofingPlanText`), que no vuelve válido lo que no lo es
—una línea de 81.9 m sigue sin caber en una plancha— pero convierte corregirla en editar un
número en vez de transcribir la cifra del papel.

### M1 — El espacio de producción v2 (D-159)

`apps/web/src/app/(app)/planta/roofing-order-panel.tsx` (nuevo), con
`components/production/length-editor.tsx` y `planta/coil-picker.tsx`.

1. **El plan de corte se edita desde el panel** — cantidad y largo en una cobertura a medida,
   **solo cantidad** en una plancha de catálogo, donde el largo lo trae el SKU (D-118).
2. **Montar la bobina rellena el reporte con los largos que el plan todavía debe**, editables
   y borrables. El campo único de metros/planchas desaparece.
3. **El selector de bobina es un modal de búsqueda con tabla** (código, espesor, color, kg
   disponibles, «Montar»), reusando el `SearchSelectModal` de D-156 con columnas.
4. **Guardar** / **Guardar y cerrar** / **Cerrar sin reportar más**. El segundo es
   `POST /production/roofing/:id/report-and-close`, que corre `reportInTx` + `closeInTx`
   (extraído acá) en **una transacción**.

El caso que obliga al cierre atómico es de dominio: un pedido genera una OP por línea
(D-084/D-148) y todas se rolan **del mismo rollo**, pero mientras la primera siga abierta con
la bobina montada, `assertStripsNotAssigned` no la deja montar en la segunda.

### M2 — Una sola entrada a producción (D-160)

`/planta` (terminal) y `/planta/producir` (espacio del pedido) se funden en **`/planta`**, con
filtro por pedido (`?pedido=`) o todas las órdenes abiertas, y las dos clases de orden en el
mismo selector: coberturas abre el panel de D-159 y drywall el de piezas
(`planta/drywall-order-panel.tsx`). Crear una orden pasa a una sección que se despliega
(`planta/new-order-cards.tsx`). El sidebar (`apps/web/src/lib/nav.ts`) queda con **Producción**
y **Órdenes de producción**. `/planta/producir` y `/planta/tanda` son redirecciones.

El detalle de la orden (`produccion/[id]/produccion-detalle-view.tsx`) queda de **lectura más
corrección** —anular, revertir un reporte, reabrir— y **pierde el cierre**, que era lo único
que estaba en los dos sitios.

Se borraron `planta/roofing-terminal.tsx` y `planta/producir/producir-view.tsx`.

### Lo que la revisión encontró y se corrigió

Dos pasadas de `revisor` (API/`shared` y web por separado) y el `qa` escribiendo los E2E. Dos
bloqueantes, cinco altos y una docena de menores; el detalle completo está en
`docs/PROGRESO.md`. Los que más importan:

- **«Guardar y cerrar» mandaba lo del botón anterior**: el flag se leía de un `useState` en el
  mismo tick en que se seteaba, así que el primer clic reportaba **sin cerrar** y el siguiente
  «Guardar» cerraba la orden que nadie quiso cerrar. Pasó a `useRef`.
- **El importador se caía en render al tipear una coma** en una cantidad — excepción dentro
  del `useMemo` que arma las 141 filas, pantalla caída y archivo revisado perdido.
- **Un cliente desactivado con el mismo RUC devolvía un 500**: se buscaba por
  `(docNumber, isActive)` y el índice único es `(doc_type, doc_number)`.
- **`validityDays: null` se había colado en el schema público**, o sea en `POST`/`PUT
/sales/quotations`.
- **Una orden que produjo menos que su plan no se podía cerrar desde ninguna pantalla** (la
  bobina se acaba a los 28 m de un plan de 40), y el **`consumedKg` del cierre (D-089) se
  había ido con la terminal** junto con sus dos cotas.
- **Cada cierre valida contra su propio piso**: el kg del cierre suelto se comparaba contra un
  reporte que ese botón no manda, y como el editor se re-siembra solo, el caso normal quedaba
  bloqueado.

---

## 3. Decisiones tomadas

| ID        | Una línea                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-157** | Una cotización puede no tener vencimiento; `NULL` es «no vence» y una sola función responde la pregunta. El `null` no viaja por HTTP.                             |
| **D-158** | El importador da de alta al cliente desde el padrón —visible antes de confirmar, con los datos de SUNAT y nunca los del archivo— y el cliente es del comprobante. |
| **D-159** | Espacio de producción v2: plan editable, reporte que se autocompleta al montar, selector de bobina con búsqueda y «Guardar y cerrar» atómico.                     |
| **D-160** | Una sola entrada a producción: `/planta`. El detalle de la orden queda de lectura más corrección y pierde el cierre.                                              |

RF actualizados: **RF-39** (`/planta` es la única entrada a producir, con sus tres acciones) y
**RF-52** (el importador crea sin vencimiento, con el cliente por comprobante y el alta desde
el padrón).

---

## 4. Bloqueos y pendientes

### Lo que necesita acción tuya

- **Dar el OK para desplegar.** Está commiteado en local y **sin push**.
- **Mirar el menú**: producción pasó de tres entradas a dos —**Producción** (`/planta`, donde
  se produce) y **Órdenes de producción** (`/produccion`, donde se gestiona)—. Si preferís
  otros rótulos es un cambio de una línea en `apps/web/src/lib/nav.ts`.
- **`docs/analisis/` sigue sin commitear**: es tuyo, viene de la sesión anterior y no se tocó.

### Anotado, no hecho

- **El badge del padrón (D-158) no se pudo ejercitar en E2E.** El entorno local no tiene token
  de apis.net.pe, así que todo documento desconocido cae en la rama del error normal. No se
  montó un mock: probaría el mock. Es la única parte de D-158 sin cobertura automática.
- **Cada `preview` repite hasta 80 consultas al padrón, sin caché.** Subir, corregir y volver
  a subir tres veces son 240 llamadas de la cuota que se comparte con el tipo de cambio
  (D-029).
- **`reset-test-db.ts` no vacía los maestros y la base de E2E envejece.** Medido:
  1 019 proveedores, 1 582 productos, 860 acabados, 627 clientes y 471 colores acumulados en
  `ayr_local_e2e`. Produce `409` al azar desde dentro de los helpers (se mitigó con un
  correlativo de proceso en `e2e/helpers`) y hace que el importador cambie de forma
  —modal contra `<select>`— según la edad de la base. Cambiar qué trunca el reset se mira con
  la suite completa delante, no de paso.
- **Un caso de `fase5a-bordes` estaba en rojo desde D-154** —la sesión anterior no corrió ese
  spec— porque codificaba el comportamiento que D-154 quitó. Se reescribió (ver PROGRESO); no
  era un defecto del código.
- **En una corrida el API de `:3000` murió a mitad** y tumbó once casos con `Login admin falló:
500`. Al relanzar, verde. Sin causa ni reproducción.
- **Las series manuales, la corrección de un manual y `7f`** siguen igual que en el handoff
  anterior; ninguna se tocó.

---

## 5. Cómo verificar

```bash
pnpm turbo lint typecheck test build     # verde (300/300 unitarios)
pnpm exec eslint e2e
pnpm exec prettier --check apps packages docs CLAUDE.md scripts e2e

# **Antes de correr E2E**: matar cualquier servidor viejo en :3000/:3001 — `reuseExistingServer`
# reusa el que encuentre y el síntoma es `Login admin falló: 401`. NO tocar :4000/:4001.
netstat -ano | grep LISTENING | grep ":300"

pnpm e2e planta-espacio-produccion-ui planta-espacio-produccion planta-avisos-materia-prima
pnpm e2e import-cotizaciones import-cotizaciones-ui fase7e-ajustes-d121
pnpm e2e fase6 fase6-bordes fase7final-op-a-stock fase7-consolidada fase5a fase5a-bordes
```

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126).

### Checklist de deploy — sin correr, esperando tu OK

```bash
pnpm turbo lint typecheck test build && pnpm format:check && pnpm exec eslint e2e
pnpm db:prod     # incluye 20260909180000_d157_cotizacion_sin_vencimiento
pnpm deploy:api
# Web: por push a main (integración Vercel-GitHub)
pnpm smoke:prod  # solo lectura (D-126)
```

**La migración va primero.** Es aditiva —afloja un `NOT NULL`— así que el API viejo contra la
base migrada funciona igual; lo que rompe es el API nuevo contra la base sin migrar, porque el
importador escribe `NULL` en `valid_until`. Siguen pendientes además las migraciones de las
sesiones anteriores (D-145, D-146, las dos de D-153 y la de D-154).

---

## 6. Siguiente sesión

1. **Usar lo que se construyó, que sigue siendo el pendiente de las cinco sesiones
   anteriores**: cargar agosto con el importador (D-152/D-157/D-158), registrar sus
   comprobantes con el modo manual (D-153) y producir esos pedidos desde `/planta`. Es la
   primera vez que el ciclo completo existe sin huecos.
2. **Fase 8 — auditoría, reportes y UAT**, la siguiente según `docs/ARQUITECTURA.md` §3.7.
3. **7f sigue sin alcance escrito**, arrastrado desde hace cinco handoffs.
