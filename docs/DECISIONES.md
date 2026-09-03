# Decisiones de arquitectura (formato largo)

> Espejo de `ARQUITECTURA.md` §0.2. Aquí solo van las decisiones que necesitan contexto adicional (alternativas evaluadas, consecuencias). La tabla corta de §0.2 sigue siendo la fuente de verdad del listado.

## D-015 — El web consume el API por proxy same-origin (`/api/*`)

**Fecha:** 2026-09-02. **Actualizada:** 2026-09-02 (mecanismo, ver D-022 — la decisión de fondo no cambia).

**Contexto.** D-010 fija cookies httpOnly para access/refresh. Web (Vercel) y API (Cloud Run) viven en dominios distintos. Cookies de terceros con `SameSite=None` dependen del navegador y Safari/Chrome las restringen cada vez más; además obligan a CORS con credenciales en cada request.

**Decisión.** El navegador solo habla con su propio origen bajo `/api/*`; el web reenvía la petición al API real y pasa de vuelta las cabeceras `Set-Cookie`. Las cookies del API no fijan `domain` y usan `SameSite=Lax`. El API igual habilita CORS para `WEB_ORIGIN` (útil para herramientas y para llamar directo en desarrollo).

**Consecuencias.** Un salto extra por request (Vercel → Cloud Run). Server Components de Next llaman al API directo por `API_URL` reenviando la cookie de la petición entrante. Playwright local usa la misma ruta `/api/*`.

**Nota (2026-09-02):** la implementación original usaba `rewrites()` de `next.config.ts`; se cambió a un Route Handler por el problema descrito en D-022. El objetivo y el contrato (`/api/*` same-origin, cookies sin `domain`) no cambiaron.

## D-016 — Rama de producción de Neon se llama `production`

**Fecha:** 2026-09-02

D-005 decía `main`. El proyecto Neon ya venía creado con la rama por defecto `production`; renombrarla no aporta nada y cambiar la rama por defecto es una operación manual. Se mantiene `production` como prod y se documenta. `dev` y `ci` cuelgan de `production`.

## D-017 — Versiones fijadas en Fase 0

**Fecha:** 2026-09-02

NestJS 11.2 (existe 12 pero el alcance pide 11), Next 15.5 (existe 16), Prisma 6.19 (7 cambia a `prisma.config.ts` + driver adapters; se migrará cuando haya un motivo), TypeScript 5.9 (7 es el port a Go y no todo el tooling lo soporta), ESLint 9 flat config, Zod 3.25 (API v3; `zod/v4` disponible en el mismo paquete), Jest 29 con ts-jest (encaja con el template de NestJS; Vitest queda para el web si algún día hace falta). Versiones exactas, sin `^`, para que dos instalaciones den lo mismo.

## D-022 — El proxy `/api/*` es un Route Handler, no un `rewrites()` de Next

**Fecha:** 2026-09-02

**Contexto.** D-015 exige que el web hable con el API por `/api/*` same-origin. La primera implementación usó `rewrites()` en `next.config.ts` apuntando al dominio por defecto de Cloud Run (`https://<servicio>-<hash>-uc.a.run.app`). Funcionaba contra `localhost` y en el build, pero en producción (Vercel) toda petición a `/api/*` devolvía 404 con el código de error `DNS_HOSTNAME_RESOLVED_PRIVATE`.

**Diagnóstico.** Las IPs de Cloud Run (`34.143.x.x` / `2600:1900:...::`) son públicas y resuelven igual desde cualquier resolutor DNS público (se verificó con DNS-over-HTTPS de Google). El bloqueo es de Vercel: su motor de `rewrites()`/`redirects()` hacia hosts externos aplica una protección anti-SSRF que, contra el dominio por defecto de Cloud Run, da un falso positivo. Mapear un dominio propio al servicio de Cloud Run habría evitado el problema, pero exige verificación de dominio (Search Console) y no hay uno disponible para el API en esta fase.

**Decisión.** Se reemplazó el `rewrites()` por un Route Handler catch-all: `apps/web/src/app/api/[...path]/route.ts`, con `export const runtime = 'nodejs'`. Hace un `fetch()` server-side hacia `API_URL` reenviando método, headers (menos los hop-by-hop), body y query string, y devuelve la respuesta tal cual, incluyendo cada `Set-Cookie` por separado (`Headers.getSetCookie()`, no el `Headers` estándar que los colapsa en uno). Un `fetch` normal dentro de una función no pasa por el chequeo anti-SSRF de `rewrites()`.

**Consecuencias.** Cada request a `/api/*` ahora invoca una función serverless de Vercel (antes era un rewrite de borde, más barato); latencia y cold starts algo mayores, aceptable para el volumen de este proyecto. El contrato (`/api/*` same-origin, cookies sin `domain`) no cambia. `next.config.ts` quedó sin `rewrites()`.

## D-023 — IAM explícito para la service account de Compute (Cloud Build + Secret Manager)

**Fecha:** 2026-09-02

**Contexto.** `gcloud run deploy --source .` usa la service account de Compute por defecto (`<project-number>-compute@developer.gserviceaccount.com`) tanto para que Cloud Build compile la imagen como para que la revisión de Cloud Run corra. Esa cuenta ya tenía `roles/editor` a nivel de proyecto (rol heredado del proyecto GCP).

**Problema.** Con solo `roles/editor` el deploy falló en dos puntos distintos:

1. Cloud Build no pudo leer el zip fuente subido al bucket `run-sources-<project>-<region>` (`PERMISSION_DENIED` en `storage.googleapis.com`).
2. Ya con la imagen construida, la revisión de Cloud Run no pudo leer los secretos de `DATABASE_URL`, `DIRECT_URL` y `JWT_SECRET` desde Secret Manager (`Permission denied on secret ... roles/secretmanager.secretAccessor`).

`roles/editor` no incluye acceso a Secret Manager por diseño (es un rol "básico" legado que excluye IAM y algunos servicios sensibles), y el acceso al bucket de fuentes de Cloud Build requiere roles específicos que tampoco cubre por completo en cuentas nuevas.

**Decisión.** `scripts/gcp-secrets.mjs` (que ya corre antes del primer deploy) ahora también:

- otorga `roles/secretmanager.secretAccessor` sobre cada secreto individualmente a la service account de Compute;
- otorga a nivel de proyecto `roles/storage.objectViewer`, `roles/cloudbuild.builds.builder`, `roles/artifactregistry.writer` y `roles/logging.logWriter` a esa misma cuenta.

Todas las llamadas son idempotentes (`add-iam-policy-binding` no duplica si el binding ya existe), así que correr el script varias veces es seguro.

**Consecuencias.** Un proyecto GCP nuevo con facturación recién vinculada debería poder desplegar con `pnpm deploy:api` sin pasos manuales de IAM. Si Google cambia qué rol usa por defecto para builds de Cloud Run en el futuro, revisar este script primero.

## D-024 — E2E de escritura contra producción con administrador efímero

**Fecha:** 2026-09-02

**Contexto.** El cierre de Fase 0 exige que los cuatro escenarios de autenticación pasen contra la URL de producción, no solo en local/CI: login correcto, login fallido, usuario desactivado no entra y cambio de rol invalida la sesión (RF-01, RF-03). Los dos últimos necesitan crear un usuario, desactivarlo y cambiarle el rol vía API; hasta ahora se auto-excluían en producción (`test.skip(isProduction)`) y allí solo corrían los tres de solo lectura.

**Problema.** Correrlos en producción choca con dos cosas:

1. El administrador real (`ADMIN_EMAIL`) se siembra con `mustChangePassword = true`, y el `AuthGuard` le bloquea todo salvo `/auth/me`, `/auth/change-password` y `/auth/logout`. Usarlo obligaría a consumir su cambio de contraseña obligatorio, es decir, alterar la cuenta del dueño.
2. Los usuarios se dan de baja de forma lógica (nunca `DELETE`), así que cada corrida dejaría cuentas `e2e-...` visibles en `/usuarios` para el cliente.

**Alternativas descartadas.** (a) Dejar solo los tres tests de lectura en producción: no cumple el criterio de cierre y deja RF-03 sin verificar donde importa. (b) Usar la cuenta real cambiándole la contraseña: modifica una credencial del dueño desde un test. (c) Un administrador de pruebas permanente en producción: una cuenta privilegiada extra viva de forma indefinida.

**Decisión.** `pnpm e2e:prod` (`scripts/e2e-prod.mjs`) orquesta la corrida:

1. genera una contraseña aleatoria que solo vive en memoria y en el entorno del proceso hijo;
2. crea el administrador efímero `e2e-admin@ayr.test` con `mustChangePassword = false` (`apps/api/prisma/e2e-admin.ts`, exige `ALLOW_E2E_ADMIN=1`);
3. corre `e2e/tests/auth.spec.ts` con `E2E_ALLOW_WRITES=1`, que es lo que levanta el `test.skip` de los escenarios de escritura;
4. en `finally` —también si los tests fallan— borra todo usuario que cumpla el patrón `e2e-...@ayr.test` (`apps/api/prisma/cleanup-e2e-users.ts`, exige `ALLOW_E2E_CLEANUP=1`).

El patrón de correos vive en un único módulo (`apps/api/prisma/e2e-users.ts`) que comparten la creación y la limpieza, y la limpieza vuelve a filtrar en código lo que ya filtró en SQL: si ambos criterios divergieran, aborta en vez de borrar de más. Crear el admin efímero con un correo fuera del patrón también falla de entrada, porque la limpieza no lo alcanzaría.

**Consecuencias.** Las sesiones de los usuarios borrados caen por `onDelete: Cascade`. `audit_log` **no** se toca: es append-only (RF-95) y sus filas quedan como registro de lo ocurrido aunque el usuario ya no exista — tras la primera corrida verificada quedaron en producción `users.create=3`, `users.deactivate=1` y `users.role.change=1`, que es justamente la evidencia de que RF-03 se probó de verdad. La cuenta del dueño no se usa ni se modifica. `pnpm e2e` (local) y CI no cambian: allí no hay `E2E_BASE_URL`, así que los escenarios de escritura siguen corriendo siempre.

## D-025..D-034 — Cierre de las preguntas abiertas P-02..P-10 (arranque de Fase 1)

**Fecha:** 2026-09-03

**Nota de numeración.** El arranque de Fase 1 traía instrucciones para registrar estas decisiones como `D-024..D-033`, pero `D-024` ya estaba tomado por el cierre de Fase 0 (E2E efímero, arriba). Se corrieron todos los IDs una posición: `D-025..D-034`. El contenido y el orden de las decisiones no cambian, solo el número.

**P-04 (D-027) — la decisión final difiere de la recomendación original.** §5 recomendaba vender la bobina por su código, sin generar SKU de catálogo. Al modelar el catálogo junto con clientes/proveedores/precios de esta misma fase, mantener dos formas distintas de "cosa vendible" (producto de catálogo vs. bobina suelta) habría duplicado listados, búsquedas y el futuro cálculo de precio sugerido (D-032). Se optó por generar igual un `product` de línea `trading` con SKU determinístico `BOB-{finishCode}-{thicknessMm}-{widthMm}` (agrupa por tipo, no por bobina individual — varias bobinas del mismo acabado/espesor/ancho comparten SKU), y la venta sigue grabando qué bobina concreta se descontó en el kardex. Esto se implementa recién en Fase 2 (cuando existen bobinas); en Fase 1 solo queda registrada la decisión y el patrón de SKU.

**P-06 (D-029) — idem, la recomendación original era solo TC manual.** Al confirmarse que la empresa ya cuenta con un token de apis.net.pe (`APIS_NET_PE_TOKEN`, en `.env.setup`), se prefirió automatizar el tipo de cambio SUNAT del día con `exchange-rates.getRate(date, currency)`: busca primero en la tabla `exchange_rates` (caché), si no existe consulta apis.net.pe y la guarda con `source=API`, y si la consulta externa falla cae al último tipo de cambio conocido para esa moneda, marcado editable a mano (`source=MANUAL`). Cada compra/venta guarda su propio `exchangeRate`, `exchangeRateSource` y `exchangeRateDate` en el momento de la operación, para que un TC corregido después no reescriba operaciones ya cerradas.

**P-09 (D-032) — idem, la recomendación original era lista de precios por producto.** Mantener una lista de precios manual por producto exige mantenimiento constante y no refleja el costo real de kardex. Se prefirió un precio _sugerido_ calculado (costo promedio ponderado × (1 + margen% de la línea)), con margen y margen mínimo configurables solo por ADMINISTRADOR en `pricing_settings`. El vendedor ve el sugerido, puede subirlo libremente, y si intenta bajarlo del margen mínimo el guard exige rol ADMINISTRADOR. Esto reemplaza la idea de "lista fija" por un piso dinámico; se implementa en el módulo `pricing` de Fase 1 aunque su consumo real (cotizaciones) es de Fase 5.

**P-07 (D-030) — el módulo de compras se especifica ahora, se construye en Fase 2.** La reorganización de fases (D-034) mueve "bobinas" a Fase 2 junto con "compras", porque toda entrada de bobina o producto terminado a inventario debería nacer de una compra recibida (trazabilidad de costo real para el kardex de D-028). Registrar la decisión ahora evita que Fase 2 tenga que reabrir preguntas de diseño ya resueltas aquí.

## D-035..D-041 — Arranque de Fase 2 (compras, bobinas, kardex)

**Fecha:** 2026-09-03

### D-035 — Costo de producción (cierra P-11)

**Contexto.** Al modelar el kardex hay que decidir con qué costo entra un producto terminado que la empresa fabrica. Si solo se cuenta la materia prima, el costo promedio de un perfil de drywall queda por debajo de lo que realmente costó producirlo, y el precio sugerido de D-032 (costo × (1 + margen%)) hereda ese error.

**Alternativas evaluadas.** (a) Solo materia prima: simple pero subvalúa el inventario y el precio piso. (b) Costeo por absorción real con centros de costo y prorrateo de gastos indirectos: correcto contablemente, pero exige un módulo de contabilidad de costos que §0.3 excluye de v1. (c) Materia prima + servicios directos + un overhead unitario configurable.

**Decisión.** (c). El costo de una corrida de producción = costo promedio del kardex de la materia prima consumida + los servicios directos imputados a esa corrida (corte tercerizado por RF-41, flete) + `overheadPerKg` × kilos producidos. `overheadPerKg` es un campo `Decimal` nuevo en `pricing_settings`, por línea de negocio, editable solo por ADMINISTRADOR igual que el margen.

**Consecuencias.** El overhead es un número que el dueño calibra a mano (gasto de fábrica mensual ÷ kilos producidos al mes); no pretende ser exacto, sí razonable y auditable. Vive en `pricing_settings` porque es la misma tabla que ya gobierna el precio, y ambos parámetros se tocan juntos. Se implementa el campo en Fase 2a (migración); su consumo real llega en Fase 4 (producción).

### D-036 — Alcance cerrado de reportes (cierra P-08 en su segunda mitad)

**Contexto.** D-031 supuso que §4.8 del docx original eran "reportes" y creó RF-90..RF-94 con una lista tentativa que incluía un reporte de compras y un requisito genérico de exportación.

**Decisión.** Los reportes de v1 son exactamente cinco: inventario valorizado por línea, kardex por producto/bobina, ventas por período, cuentas por pagar por proveedor y cola de producción. §4.8 se reescribe con esa lista y se elimina todo RF de reportes fuera de ella (cae el reporte de compras como reporte propio y el RF de exportación genérica).

**Consecuencias.** Exportar a Excel/CSV pasa a ser una propiedad de cada reporte, no un requisito separado; se decidirá por reporte en Fase 7. El reporte de compras por período no desaparece del negocio: la lista central de `/compras` (D-030) ya es filtrable por línea, tipo, proveedor y fecha, y cubre esa necesidad sin un reporte aparte. La cola de producción, que era una vista (RF-37), queda además como reporte consultable.

### D-037 — SKU de bobina para venta directa (supersede D-027)

**Contexto.** D-027 fijó el SKU `BOB-{finishCode}-{thicknessMm}-{widthMm}` para el producto de `trading` que representa la bobina vendida sin transformar. Al modelar `coils` en Fase 2a apareció el choque: RF-14 exige un `typeKey` que agrupa por acabado y espesor **ignorando el ancho**, y el ancho de una bobina cambia con cada partido (RF-15).

**Problema.** Con el ancho dentro del SKU, cada ancho comprado o resultante de un partido crearía un producto distinto en el catálogo de `trading`, y partir una bobina cambiaría el producto al que pertenece su stock. Además, comercialmente el ancho no cambia qué material se está vendiendo: se vende acero de tal acabado y tal espesor, por kilo.

**Decisión.** El SKU es `BOB{finishCode}{thicknessMm}`, sin ancho y sin separadores, uno por `typeKey`. Ejemplo: acabado `GALV` de 0.50 mm → `BOBGALV0.50`. D-027 queda marcada SUPERSEDIDA en §0.2.

**Consecuencias.** El SKU coincide exactamente con el `typeKey` de RF-14, así que el inventario de bobinas y el catálogo de `trading` agrupan por el mismo criterio y no hay que traducir entre ambos. La venta sigue registrando en el kardex qué bobina concreta se descontó (`itemType=COIL`, `itemId`), que es donde vive la trazabilidad física. Sin guiones porque el resto de códigos de bobina (RF-13) sí los usa y conviene que un `BOB...` no se confunda con un `code` de bobina individual.

### D-038 — El costo de kardex de una bobina es el valor de compra sin IGV

**Contexto.** Una factura de compra peruana trae el valor de venta gravado, el IGV (18 %) y el importe total. Hay que decidir cuál de los tres alimenta el `unitCost` del movimiento de entrada.

**Decisión.** El valor **sin IGV**. La compra guarda `subtotal`, `igv` y `total` por separado; el movimiento de kardex se valoriza con el subtotal (dividido entre los kilos, para el `unitCostPerKg`). La cuenta por pagar, en cambio, se lleva por el `total` con IGV, que es lo que efectivamente se le debe al proveedor.

**Consecuencias.** El IGV de compra es crédito fiscal recuperable, no costo del material: incluirlo inflaría el costo promedio en 18 % y, por D-032, también el precio sugerido. Cuando el comprobante viene en USD se guarda además `totalPen` con el TC del día (D-029), y el costo del kardex se lleva en la moneda del documento con su `exchangeRate` para poder reexpresar.

### D-039 — Cuentas por pagar con pagos parciales

**Contexto.** D-030 dejó "cuenta por pagar → pagos" sin especificar la cardinalidad.

**Decisión.** Una compra tiene N pagos (`supplier_payments`: fecha, monto, moneda, tipo de cambio, método, referencia). El saldo de la compra = total − suma de pagos aplicados, calculado, no almacenado. El estado de cuenta por proveedor (`/proveedores/[id]/estado-cuenta`) lista sus compras con saldo distinto de cero, su antigüedad y el total adeudado.

**Consecuencias.** El saldo se calcula en cada consulta en vez de mantenerse como columna, para que no pueda desincronizarse; si el volumen lo exige más adelante se agrega un índice o una vista materializada. Un pago en moneda distinta a la de la compra guarda su propio `exchangeRate` para poder convertir sin reescribir la compra. Anular un pago se resuelve en Fase 2b junto con el resto de anulaciones.

### D-040 — La merma es un movimiento de kardex

**Contexto.** RF-17/RF-18 piden registrar y anular merma sobre una bobina.

**Decisión.** La merma es un movimiento `OUT` con `refType=SCRAP` (identificador en inglés por §0.1; "merma" es solo la etiqueta de UI), valorizado al costo promedio vigente del ítem en el momento de registrarla. Anularla emite un movimiento `IN` inverso con `reversalOfId` apuntando al original. Nunca se borra la fila (regla dura 2 de `CLAUDE.md`, §3.2).

**Consecuencias.** No hace falta lógica especial de valorización: la merma sale al mismo promedio que cualquier otra salida, así el valorizado por línea (RF-90) sigue cuadrando solo. Se implementa en Fase 2b; en 2a solo se deja el `refType` reservado en el enum.

### D-041 — Fase 2 se ejecuta en dos sesiones (2a y 2b)

**Contexto.** El alcance de Fase 2 (§3.7, D-034) es compras completas + bobinas completas + kardex: tres módulos de API, tres o cuatro secciones de web, y un cierre que exige revisión, auditoría de seguridad, E2E, deploy a producción y `pnpm e2e:prod`.

**Decisión.** Se parte por dependencia técnica. **2a**: kardex base (`inventory_movements`, `inventory_balances`, `InventoryService.record` como único escritor), módulo `purchases` con sus cuatro tipos y pagos parciales, y alta de bobinas por las tres vías (manual, XML UBL 2.1, planilla). **2b**: partido (RF-15/16), merma (RF-17/18), cierre (RF-19), edición (RF-20), anulación (RF-21/22) y las vistas de inventario de bobinas por línea (RF-23).

**Consecuencias.** §3.7 pasa a tener filas `2a` y `2b`; las fases 3 en adelante no cambian. 2b no puede empezar antes de 2a porque todo lo suyo opera sobre bobinas ya dadas de alta y sobre el kardex. Cada mitad cierra con su propio handoff, deploy y E2E en producción, así que el proyecto nunca queda con una fase a medio desplegar.

### D-042 — El kardex se lleva en soles

**Fecha:** 2026-09-03

**Contexto.** D-038 fijó que el costo que entra al kardex es el valor de compra sin IGV, pero no dijo en qué moneda. La primera implementación guardaba el costo en la moneda del documento, porque es lo que trae la factura del proveedor.

**Problema (hallazgo del `revisor`).** `inventory_movements` e `inventory_balances` no tienen columna de moneda. Comprar el mismo producto una vez en USD y otra en PEN mezclaba dos escalas en el mismo promedio ponderado (D-028), y `GET /inventory/balances` sumaba dólares con soles en el valorizado por línea (RF-90). El error no salta a la vista: los números siguen "cuadrando", solo que no significan nada.

**Alternativas.** (a) Agregar `currency` al movimiento y al saldo: obliga a llevar un promedio por moneda y a decidir en qué moneda se valoriza el inventario igual. (b) Convertir a soles al registrar el movimiento.

**Decisión.** (b). El costo del movimiento se guarda ya multiplicado por el `exchangeRate` de la operación (`unitCostPerKg × exchangeRate` en bobinas, `unitPrice × purchase.exchangeRate` en producto terminado). La compra y la bobina conservan su moneda original, su `exchangeRate` y su total en la moneda del documento: nada se pierde, y el reporte de compras sigue mostrando la factura tal como la emitió el proveedor.

**Consecuencias.** El costo promedio, el inventario valorizado y el precio sugerido de D-032 quedan todos en soles, que es la moneda funcional del negocio. Un tipo de cambio corregido después no reescribe movimientos ya registrados (misma regla que D-029). Si alguna vez hace falta el inventario valorizado en dólares, se convierte al TC del día de la consulta, no se reescribe el kardex.

### RF-15 recuperado

El docx original saltaba de RF-14 a RF-16, y D-031 (P-08) ya había señalado a RF-15 entre los requisitos faltantes sin recuperarlo. Por el contenido de RF-16 ("revertir un partido, devolviendo peso y ancho a la madre") el hueco solo puede ser el partido en sí: **RF-15 — Partir una bobina en hijas por ancho, conservando trazabilidad a la madre.** Se implementa en Fase 2b; el campo `coils.parentCoilId` se crea ya en 2a (siempre `null` por ahora) para no migrar dos veces la tabla.

### D-043 — Landed cost: flete, aduana y seguro entran al costo de la bobina

**Fecha:** 2026-09-04. Cierra P-12.

**Contexto.** Una importación de bobinas llega con varias facturas: la del proveedor del acero (compra `COIL`) y las del agente de carga, la agencia de aduanas y el seguro (compras `SERVICE`). Hasta ahora cada una vivía sola: la `COIL` movía kardex y las `SERVICE` solo generaban cuenta por pagar (D-030).

**Problema.** El costo promedio del acero salía por debajo del real. Ese promedio alimenta el precio sugerido (D-032) y el costo de producción (D-035), así que el error se propaga a toda la cadena comercial: se vende con un margen aparente que no existe.

**Alternativas.** (a) Dejarlo como gasto del período y absorberlo con el `overheadPerKg` de D-035 — pero ese overhead es fábrica, no compra, y un flete de importación es diez veces un flete local: promediarlo desfigura ambos. (b) Pedir el flete estimado al registrar la compra `COIL` — obliga a adivinar antes de tener la factura y a recostear igual cuando llega la real. (c) Vincular la compra de servicio a la de bobinas y prorratear al recibirla.

**Decisión.** (c). `purchases.relatedPurchaseId` apunta de la compra `SERVICE` a la compra `COIL`. El vínculo solo se admite si el `serviceKind` es `FREIGHT`, `CUSTOMS` o `INSURANCE` (`CUTTING` prorratea distinto y es de Fase 3; `OTHER` no se imputa) y si la compra vinculada es de tipo `COIL` y no está anulada; el proveedor puede ser otro, porque el flete rara vez lo factura el mismo que el acero. Al **recibir** la compra de servicio se toma su subtotal (sin IGV, D-038), se convierte a soles con su propio `exchangeRate` (D-042) y se reparte **por kilo** entre las bobinas de la compra vinculada que todavía tengan saldo: cada una recibe un movimiento `ADJUST` que no cambia la cantidad y sube el `avgCost` del saldo, y se actualiza su `unitCostPerKg`.

**Por qué por kg y no por valor.** El servicio se contrata y se cobra por peso transportado o nacionalizado; prorratear por valor cargaría más costo de flete al acero más caro aunque ocupe el mismo espacio y pese lo mismo. Si alguna vez aparece un servicio que se cobra sobre el valor CIF (algunos seguros), se agrega el criterio como campo de la compra; no se cambia el default.

**Consecuencias.** El `ADJUST` es el primer movimiento de kardex que mueve costo sin mover cantidad, así que `InventoryService` gana un método propio (`adjustCost`) en vez de forzar `record`. Una compra de servicio ya prorrateada no se puede volver a prorratear ni desvincular sin anularla (su anulación revierte los `ADJUST` con `reverse`). Si una bobina de la compra vinculada ya se consumió del todo, no recibe imputación: ese costo ya salió del inventario y reescribirlo tocaría movimientos pasados. Es un **default por recomendación del agente** (§5, P-12): el dueño puede pedir volver a tratar el flete como gasto antes de Fase 3, y el cambio sería dejar de crear el vínculo, sin migrar nada.

### D-044 — RF-22 (cancelar plan de corte) es de Fase 3

**Fecha:** 2026-09-04

**Contexto.** §3.7 listaba RF-22 dentro de Fase 2b junto con el resto de anulaciones de bobina.

**Decisión.** RF-22 se implementa en Fase 3, con el plan de corte tercerizado (RF-40..42).

**Consecuencias.** En 2b no existe todavía la entidad "plan de corte": no hay nada que cancelar, y adelantar un endpoint sin comportamiento solo agregaría superficie. §4.2 lo deja anotado al lado del requisito. El resto de anulaciones de 2b (RF-18, RF-21 y la anulación de compra recibida) no dependen de esto.

### D-045 — Editar moneda o tipo de cambio de una bobina recuesta el ingreso

**Fecha:** 2026-09-04

**Contexto.** RF-20 pide editar los datos de una bobina "incluida su moneda y tipo de cambio". Con D-042 el kardex guarda el costo ya convertido a soles, así que cambiar la moneda o el TC cambia el costo con el que la bobina entró al inventario.

**Problema.** El promedio ponderado de D-028 es acumulativo: el `avgCost` de hoy es función de todos los movimientos anteriores en orden. Si la bobina ya tuvo una salida, un partido o una merma, esas operaciones se valorizaron con el costo viejo. Reescribir el ingreso hacia atrás dejaría el kardex contando una historia que nunca ocurrió, y el trigger de la base lo impide de todos modos (§3.2, append-only).

**Decisión.** El cambio de moneda, tipo de cambio o costo unitario solo se admite si la bobina **no tiene movimientos posteriores** a su `IN` inicial. Cuando se admite, no se hace `UPDATE` del movimiento: se emite la reversa del `IN` original (`reverse`) y un `IN` nuevo al costo corregido, ambos en la misma transacción. Los campos que no tocan el kardex (ancho, notas) se editan mientras la bobina esté `OPEN`, sin condiciones extra.

**Consecuencias.** El kardex de la bobina muestra las tres filas (ingreso, reversa, reingreso), que es exactamente la trazabilidad que pide RF-95: se ve qué se corrigió, cuándo y quién. Si la bobina ya se movió, la corrección queda bloqueada con un mensaje que nombra el movimiento que la bloquea; la salida en ese caso es anular primero la operación posterior. Solo ADMINISTRADOR puede editar moneda/TC (§3.4); SUPERVISOR_PLANTA edita el resto.

## D-047..D-050 — Arranque de Fase 3 (corte tercerizado y flejes)

**Fecha:** 2026-09-02

### D-047 — Consumo de producción: kg teórico con override (cierra P-13)

**Contexto.** RF-30/RF-34 piden producir consumiendo bobina o fleje. Hay que decidir con qué kg se descuenta el kardex de la materia prima: lo que dicen las dimensiones del producto fabricado, o lo que el operario pesa físicamente.

**Alternativas.** (a) Solo kg real pesado: exacto, pero obliga a pesar cada corrida y no da un número de referencia para detectar una corrida anómala. (b) Solo kg teórico por dimensiones: simple y rápido, pero no captura la merma de proceso real (recorte, rebabas) y el kardex terminaría mintiendo sobre cuánta materia prima se usó de verdad. (c) Teórico por defecto con override manual.

**Decisión.** (c). El kg teórico sale de las dimensiones del producto × `densityFactor` del acabado (RF-25): en drywall, kg por metro de perfil calculado desde el fleje consumido; en coberturas, ancho × espesor × largo × densidad. El operario puede sobreescribir ese teórico con el kg real si pesó la corrida. La diferencia entre lo que el kardex tenía que salir (teórico u override) y lo que realmente se descuenta del fleje/bobina consumido se registra automáticamente como merma de proceso (`SCRAP`), igual que D-040.

**Consecuencias.** El caso normal (sin pesar) no exige nada extra del operario: el sistema calcula y descuenta solo. El caso con pesaje queda igual de auditable que cualquier otra merma, sin un tercer mecanismo de ajuste aparte. Se implementa recién en Fase 4 (drywall) y Fase 5 (coberturas); queda registrado ahora para no reabrir la pregunta al llegar ahí.

### D-048 — Reorden de fases 4 y 5 por dependencia RF-31

**Contexto.** §3.7 tenía Fase 4 = producción (drywall + coberturas) y Fase 5 = cotizaciones y ventas. RF-31 exige que toda producción de coberturas vaya contra una cotización confirmada; sin cotizaciones (Fase 5) no hay nada contra qué producir coberturas.

**Decisión.** Fase 4 = producción drywall (que no depende de cotización) + terminal `/planta`. Fase 5 = cotizaciones + `production_orders` (D-026) + producción de coberturas + ventas, todo junto porque coberturas y ventas comparten la dependencia de cotización.

**Consecuencias.** Evita mockear cotizaciones para poder cerrar Fase 4, el mismo problema que D-034 ya había evitado entre compras y bobinas. Drywall sale una fase antes que coberturas aunque el docx original las trataba como una sola fase de "producción".

### D-049 — Los flejes son bobinas con `kind = STRIP`

**Contexto.** RF-40..42 piden enviar bobinas a corte tercerizado, recibir flejes y consultar su stock por ancho. Hay que decidir si un fleje es una entidad nueva o una variación de `coils`.

**Decisión.** `coils` gana la columna `kind COIL|STRIP` (default `COIL`). Un fleje es una fila `kind=STRIP` con `parentCoilId` a la bobina de la que salió (comprada o, en corte tercerizado, la bobina enviada al tercero), creada con la misma mecánica que el partido interno (RF-15, `planCoilSplit`): mismo código RF-13, mismo `typeKey` RF-14, mismo kardex vía `InventoryService`. La diferencia con una hija de partido interno es el `refType` del movimiento (`CUTTING` en vez de `SPLIT`) y que el stock de flejes (RF-42) se agrupa por `typeKey` **+ `widthMm`** — a diferencia del inventario de bobinas (RF-51), que agrupa solo por `typeKey` porque el ancho de una bobina entera no importa para su reventa, pero el ancho de un fleje sí importa para producir drywall.

**Consecuencias.** Cero duplicación de código de kardex, códigos ni trazabilidad: `CoilsService.create`/`prepareBatch` y `planCoilSplit` se reusan sin tocarlos. El corte tercerizado no necesita tabla nueva para "el fleje" en sí, solo para el envío y la recepción (`cutting_orders`/`cutting_order_coils`).

### D-050 — Envío a corte no mueve el kardex

**Contexto.** RF-40 envía una bobina a un tercero para que la corte. Hay que decidir si ese envío es una salida de kardex (como si se vendiera o consumiera) o no.

**Decisión.** La bobina enviada pasa a `status = IN_THIRD_PARTY` (nuevo valor del enum `CoilStatus`) sin movimiento de inventario: sigue siendo propiedad de la empresa, solo cambió de ubicación física. Mientras está `IN_THIRD_PARTY` se excluye de producción y del partido local (RF-15) — las mismas exclusiones que una bobina `CLOSED`, más estricta porque tampoco se puede editar su costo (D-045) mientras está fuera. El kardex real —salida `OUT refType=CUTTING` de la madre, entradas `IN` de los flejes— se emite recién al **recibir**, con la misma matemática que el partido (`planCoilSplit`).

**Consecuencias.** Evita una salida de kardex por un envío que puede tardar semanas en volver o incluso no volver nunca (pérdida en el tercero, que se resolvería como una merma en ese momento, fuera de alcance de v1). RF-22 (cancelar el plan de corte) se resuelve solo devolviendo la bobina a `OPEN`, sin reversar ningún movimiento, porque no hubo ninguno.

## D-051..D-052 — Fase 3b (reversa de recepción de corte tercerizado)

**Fecha:** 2026-09-03

### D-051 — Fase 3b se intercala entre Fase 3 y Fase 4

**Contexto.** El handoff de Fase 3 dejó anotado un hueco explícito: no existe forma de deshacer una recepción de corte tercerizado ya confirmada (RF-41), simétrico al hueco que RF-16 cerró para el partido interno en Fase 2b. Consecuencia concreta: 3 bobinas madre de prueba en producción (una con 2 000 kg) quedaron sin poder anularse porque su compra original está bloqueada por un movimiento `CUTTING` posterior que nada podía revertir.

**Decisión.** Se cierra el hueco ahora, como una sub-fase "3b" entre Fase 3 y Fase 4, antes de empezar producción — igual que D-041 partió la Fase 2 original en 2a/2b por la misma razón (una fase grande con dependencia técnica interna, cerrada en dos sesiones verificables cada una).

**Consecuencias.** §3.7 gana la fila "3b". Fase 4 (producción) empieza sin heredar el mismo hueco: si un operario de planta recibe mal un envío de corte, ya existe una forma de corregirlo antes de que production empiece a consumir esos flejes.

### D-052 — Guardrails de `CuttingService.reverse()`

**Contexto.** `reverse()` deshace la recepción de UNA bobina de una orden de corte: anula los flejes que creó y devuelve el peso a la madre. RF-16 (revertir un partido) es el patrón a seguir, pero un envío a corte tiene una diferencia de fondo con un partido: D-050 hizo que **enviar** una bobina a un tercero no deje ningún rastro de kardex. Eso significa que, entre la recepción que se quiere revertir y el momento de la reversa, la bobina madre pudo haberse reenviado a OTRA orden de corte sin que ningún movimiento lo delate — algo que RF-16 nunca tuvo que contemplar, porque antes de D-050 una bobina no podía "irse" sin dejar rastro.

**Alternativas.** (a) Revertir siempre y decidir el estado final de la bobina madre con una regla adicional (por ejemplo, "si el envío sigue vivo va a `IN_THIRD_PARTY`, si no, queda disponible") sin verificar si la madre se movió entre medio. (b) Bloquear la reversa entera si la madre tiene cualquier indicio de haberse movido desde esta recepción (estado actual distinto de `OPEN`/`CLOSED`, o cualquier movimiento de kardex posterior a la salida que se revierte), igual que RF-16 bloquea si una hija se movió.

**Decisión.** (b). Antes de revertir, la bobina madre debe estar `OPEN` o `CLOSED` (nunca `IN_THIRD_PARTY` de otro envío, nunca `CANCELLED`) y no puede tener ningún movimiento de kardex posterior a la salida que se revierte (otro partido, otra merma, otra recepción de corte). Si ambos guardrails pasan, el resultado es siempre el mismo: los flejes de esa recepción quedan `CANCELLED`, la fila (`cuttingOrderCoil`) vuelve a `SENT` y la bobina madre vuelve a `IN_THIRD_PARTY` — el envío queda vivo por construcción, porque cualquier escenario donde no lo estaría ya bloqueó la operación antes de llegar a decidir un estado final. El mismo guardrail de `IN_THIRD_PARTY` se agregó retroactivamente a `revertSplit` (RF-16, `coil-operations.service.ts`), que tenía el mismo hueco sin haberlo necesitado nunca hasta que D-050 introdujo `IN_THIRD_PARTY`.

**Consecuencias.** No existe hoy un camino de código donde la reversa termine con la bobina simplemente "disponible" sin pasar por `IN_THIRD_PARTY": si el guardrail bloquea, la operación falla completa (mismo criterio "todo o nada" que ya usa RF-16 con las hijas de un partido y RF-21 con los movimientos posteriores de una bobina), nunca deja un estado ambiguo a mitad de camino. Si el negocio pide más adelante un caso legítimo donde la bobina deba quedar disponible en vez de reenviarse, se agrega como una decisión nueva con su propio criterio explícito, no como una rama silenciosa de esta.

## D-053 — Fix del historial de migraciones (Sesión M-1)

**Fecha:** 2026-09-03

**Contexto.** El handoff de Fase 3b dejó documentado que `prisma migrate dev` (shadow database) fallaba con `type "CoilStatus" does not exist` al reproducir el historial completo desde cero, y que la migración de Fase 3b tuvo que escribirse a mano y aplicarse con `prisma migrate deploy` para esquivarlo. La causa, confirmada esta sesión leyendo `_prisma_migrations` directamente (solo lectura, antes de tocar nada) en `dev` y `production`:

- Orden real de aplicación (por `started_at`): `init → refresh_grace → fase1 → fase2a → fase2b → fase3 → fase3b`, idéntico en las dos ramas.
- Orden de las carpetas por nombre (que es el que usa el reproceso desde cero de un shadow database): `init → refresh_grace → fase1 → fase3 (20260903031603) → fase2a (20260903120000) → fase2b (20260904120000) → fase3b`.
- La migración de Fase 3 hace `ALTER TYPE "CoilStatus" ADD VALUE 'IN_THIRD_PARTY'` y agrega columnas/FKs contra la tabla `coils`, pero el tipo `CoilStatus` y la tabla `coils` se **crean** en la migración de Fase 2a. Un shadow database que reproduce las carpetas en su propio orden llega a Fase 3 antes de que exista `CoilStatus` y falla. En `dev`/`production` nunca falló porque cada fase se aplicó con `migrate deploy` en el momento real de la sesión, no reproduciendo el historial completo.

**Decisión.** Renombrar **solo el nombre** de la carpeta `20260903031603_fase3_corte_flejes` a `20260904125000_fase3_corte_flejes` (entre `fase2b` y `fase3b`, reflejando el orden real de aplicación) sin tocar su `migration.sql`. Sincronizar `_prisma_migrations.migration_name` a mano con el mismo `UPDATE` en `dev` y `production`, verificando antes y después que `id` y `checksum` no cambiaron. Autorizado explícitamente por el dueño (ver prompt de la Sesión M-1); sin este paso, la regla operativa 6 de `CLAUDE.md` (nunca tocar el historial de migraciones sin autorización) lo hubiera bloqueado.

**Verificación.** `prisma migrate status` limpio en `dev` y `production` tras el `UPDATE`. `prisma migrate dev` (sin cambios pendientes en el schema) reconstruye el shadow database contra `dev` y confirma "Already in sync, no schema change or pending migration was found" — la ruta que antes fallaba con `type "CoilStatus" does not exist` ahora reproduce el historial completo sin error. Backup de `_prisma_migrations` (todas las columnas, las tres ramas) en `docs/backup/prisma-migrations-{dev,production,ci}-*.json` antes de cada `UPDATE`.

**La rama `ci` necesitó el mismo fix, descubierto por el primer push a CI.** El primer commit de esta sesión (push a `main`, corrida CI 33731598611) asumió que `ci` heredaría el fix solo, porque `docs/PROGRESO.md` decía que esa rama "se resetea por corrida" (D-014). Eso es incorrecto para el historial de migraciones: `reset-test-db.ts` (D-018) corre `prisma migrate deploy` y después `TRUNCATE` de las tablas de negocio — nunca recrea la rama ni toca `_prisma_migrations`, que en `ci` es su propia tabla persistente, independiente de `dev`/`production`, acumulada desde la primera vez que CI corrió. `ci` seguía con `migration_name = 20260903031603_fase3_corte_flejes` (el nombre viejo), así que el `migrate deploy` de esa corrida de CI vio `20260904125000_fase3_corte_flejes` como una migración nueva, intentó aplicarla desde cero y falló con `type "CoilKind" already exists` (P3018) — el mismo tipo de error que motivó todo D-053, ahora en la rama que faltaba. Se corrigió con el mismo procedimiento: backup, `prisma migrate resolve --rolled-back` sobre el intento fallido (que dejó una fila con `applied_steps_count=0` sin `finished_at`, borrada a mano tras confirmar que nunca aplicó nada) y el mismo `UPDATE migration_name` sobre la fila real. Verificado reproduciendo `ALLOW_DB_RESET=1 pnpm exec tsx prisma/reset-test-db.ts` en local apuntando a `ci` antes de reintentar el push.

**Consecuencia para quien repita este tipo de fix.** "Se resetea por corrida" (nota operativa de `PROGRESO.md`) describe los **datos** de `ci`, no su historial de migraciones. Cualquier cambio a `_prisma_migrations` en `dev`/`production` tiene que replicarse también en `ci` explícitamente — no asumir que un reset de datos limpia también el historial de Prisma.

**Nota — `--create-only` aplicó el cambio dummy en vez de solo crearlo.** Al verificar con un campo dummy en `AuditLog` (paso 4 del prompt de la sesión), `prisma migrate dev --create-only` no se comportó como documenta `--help` ("Create a new migration but do not apply it"): aplicó la migración a `dev` de verdad (columna creada, fila en `_prisma_migrations` con `finished_at`). Revertido a mano (`DROP COLUMN`, borrado de la fila, carpetas de migración eliminadas) antes de repetir la verificación real con `prisma migrate dev` sin `--create-only` (sin diff pendiente, solo reconstruye el shadow database). Queda anotado por si vuelve a pasar: no asumir que `--create-only` es inerte en esta versión de Prisma (6.19.3) sin comprobarlo contra la base real después.

**Consecuencias.** `pnpm db:migrate` (`prisma migrate dev`) vuelve a ser seguro para migraciones nuevas; ya no hace falta el flujo manual (escribir SQL a mano + `migrate deploy`) que Fase 3b tuvo que usar. La rama `ci` no se tocó (se resetea por corrida desde su padre, D-014/nota operativa de `PROGRESO.md`) — hereda el orden correcto en su próximo reset, verificable con `node scripts/migrations-diagnose.mjs --branch ci` tras la próxima corrida de CI. Scripts nuevos, solo para diagnóstico/reparación puntual de este tipo de problema, no parte del flujo normal: `scripts/migrations-diagnose.mjs`, `scripts/migrations-backup.mjs`, `scripts/migrations-rename.mjs`, `scripts/migrations-status.mjs` (cada uno invoca su contraparte en `apps/api/prisma/migrations-*.ts`).

## D-054 — Modelo de cotización, pedido y reserva para Fase 5 (P-15)

**Fecha:** 2026-09-03

**Contexto.** RF-31 exige que toda producción de coberturas vaya contra una cotización confirmada (D-048). Falta decidir el mecanismo concreto: si cotizar reserva stock, cómo se modela esa reserva contra el kardex (que es append-only, §3.2), y qué la consume o libera. Es la pregunta abierta P-15, resuelta por el dueño (fuera de esta sesión) y registrada acá para que Fase 5 no tenga que volver a discutirla.

**Decisión.** Cotizar **no** reserva — es una simulación de precio (D-032) sin efecto en el inventario. Al **confirmar** la cotización, el vendedor dispara una transacción atómica que crea el pedido y la reserva juntos. La reserva es por producto/kg, vive en un **ledger propio** (tabla nueva, fuera de `inventory_movements`) con estados `ACTIVA` / `CONSUMIDA` / `LIBERADA`. Invariante `disponible ≥ reservado`: toda operación que la rompería (anular compra o bobina, registrar merma, enviar a corte, o que otra venta reserve el mismo stock) se bloquea mientras la reserva esté `ACTIVA` — mismo criterio de guardrail "todo o nada" que D-046/D-052 ya usan para otras operaciones. La OP de Fase 5 consume la reserva (pasa a `CONSUMIDA`); cancelar el pedido la libera (`LIBERADA`). Sin vencimiento automático: una alerta avisa reservas viejas, pero la liberación es siempre manual.

**Por qué un ledger aparte del kardex.** Un movimiento `OUT` de reserva en `inventory_movements` ensuciaría el promedio ponderado y el valorizado (RF-90..94) con una salida que todavía no ocurrió — la reserva es una promesa comercial, no un hecho físico. Es el mismo argumento que D-050 usó para mantener el envío a corte fuera del kardex mientras la mercadería sigue siendo de la empresa. Un ledger propio deja al kardex intacto (solo movimientos reales) y a la reserva verificable contra él vía la invariante, sin inventar una salida ficticia por cada cotización confirmada.

**Consecuencias.** Fase 4 (producción drywall, sin dependencia de cotización por D-048) deja la OP preparada para consumir contra una reserva **opcional** — el patrón se construye una vez y Fase 5 solo lo activa como obligatorio para coberturas. El módulo de ventas de Fase 5 es quien implementa el ledger de reservas completo (tabla, estados, invariante, alertas). Si el grill formal de Fase 5 con el dueño revela un matiz no cubierto acá (por ejemplo, reservas parciales entre varias cotizaciones sobre el mismo pedido), se ajusta esta decisión antes de construir, no después.

## D-055..D-060 — Fase 4 (producción de drywall y terminal `/planta`)

**Fecha:** 2026-09-03

### El modelo en una página

Una **orden de producción** (OP) fabrica un perfil de drywall contra la **receta** del producto (D-059). El ciclo tiene cuatro actos y cada uno decide algo distinto sobre el kardex:

1. **Crear** la OP: elige el producto y, opcionalmente, una meta de piezas. No toca nada.
2. **Consumir un fleje**: lo pone a disposición de la OP. **No mueve kardex** (D-060).
3. **Reportar piezas** (N veces, D-058): saca del fleje los kilos teóricos que esas piezas consumen (`OUT refType=PRODUCTION`) y mete las piezas al producto terminado (`IN`, unidad `NIU`, D-055), valorizadas exactamente por lo que salió del fleje.
4. **Cerrar** (D-057): lo que quedó asignado y no llegó a ser pieza buena sale como merma de proceso (`OUT refType=SCRAP`), y todo el material —piezas y merma— se reparte entre las piezas buenas con un `ADJUST` sobre el producto (D-056).

Las tres reversas (revertir un reporte, reabrir una OP cerrada, anular la OP) van en esta misma fase, no en una "4b": ver D-060.

### D-055 — Piezas como unidad primaria del producto terminado

**Contexto.** D-047 ya había resuelto **con qué kilos** se descuenta la materia prima. Faltaba decidir en qué unidad entra el producto terminado al kardex.

**Alternativas.** (a) Kilos, para que todo el sistema hable la misma unidad y el valorizado sume sin conversiones. (b) Piezas, con el kilo como magnitud derivada.

**Decisión.** (b). El perfil se vende, se cuenta, se despacha y se cotiza por pieza; llevar su stock en kilos obligaría a convertir en cada consulta y a repetir el factor de conversión en cada punto del sistema. El producto de catálogo debe estar en `NIU` para poder tener receta, y el API lo valida al cargarla.

**Consecuencias.** El kilo no desaparece: sigue siendo la unidad del fleje, que es lo que el kardex descuenta de verdad, y se deriva de un solo lugar (`kgPerPiece` de la receta). `inventory_movements.qty` tiene escala 3, así que las piezas entran como enteros sin problema. El kardex ya prohibía mezclar unidades en un mismo saldo (`InventoryService.record`), así que la unidad del producto queda fijada de entrada y no puede cambiarse a mitad de camino sin vaciar el saldo.

### D-056 — Costo de la pieza en v1

**Decisión.** `costo de la pieza = (costo real de los flejes consumidos) / piezas buenas`. Ese costo del fleje ya arrastra el landed cost de la compra de la bobina (D-043) y el prorrateo del servicio de corte tercerizado (RF-41), así que la OP no vuelve a imputar nada por su cuenta: los prorrateos ya están adentro. La merma de proceso **la absorben las piezas buenas** — no se destruye valor, se reparte.

**Sin mano de obra ni overhead estándar.** `production_orders.overhead_cost_pen` existe, siempre vale `0` en v1, y `productionCost()` deja el término escrito y explícito. Es el **hook** de D-035 (`pricing_settings.overheadPerKg`): cuando el negocio quiera activarlo, se llena ese término y no hay que rehacer ni el cálculo, ni la columna, ni el DTO, ni la UI.

**Por qué la merma se absorbe y no se pierde.** Es costeo por absorción, la práctica habitual: si perfilar 900 piezas gastó 2 400 kg de fleje, cada pieza costó lo que costó ese fleje, no lo que "debería" haber costado. Tratar la merma como pérdida dejaría el inventario de piezas por debajo de su costo real y ese error viajaría al precio sugerido (D-032). El movimiento `SCRAP` registra la pérdida **física** (los kilos se fueron) y el `ADJUST` traslada su **costo** a las piezas: el valor que sale de los flejes es exactamente el que entra al producto terminado, y el kardex cierra sin residuo.

**El residuo de redondeo también lo absorbe el cierre.** El costo unitario de cada reporte se guarda con 4 decimales, así que `piezas × costo unitario` puede diferir en céntimos del material que realmente salió. El `ADJUST` del cierre se calcula como _costo total real − valor con el que las piezas entraron_, así que se lleva la merma **y** ese residuo de una vez.

**Límite conocido.** El `ADJUST` se reparte sobre **todo** el saldo del producto, no solo sobre las piezas de esta OP — es inevitable con promedio ponderado (D-028) y es el mismo comportamiento del landed cost (D-043). El costo propio de la corrida queda guardado aparte en `production_orders.unit_cost_pen`, que es el número que hay que mirar para comparar corridas entre sí. Si al cerrar el producto ya no tiene saldo (todas las piezas salieron), el ajuste no tiene dónde imputarse y no se emite; la OP guarda igual su costo y la auditoría lo registra (`costAdjusted: false`), mismo criterio que D-043.

### D-057 — La merma de proceso sale por diferencia al cerrar

**Decisión.** Al cerrar, `merma = kg asignados − kg teóricos de las piezas buenas`. Se emite como `OUT refType=SCRAP` sobre cada fleje que quedó con saldo asignado, valorizada al promedio vigente igual que cualquier otra merma (D-040).

**Por qué al cerrar y no en cada reporte.** Durante la corrida no se sabe si el fleje que sobra va a convertirse en más piezas o no. Descontarlo antes obligaría a devolverlo después; descontarlo al final es el único momento en que la respuesta es definitiva. Es la aplicación concreta de D-047 al caso drywall: el caso normal no le pide nada al operario y la diferencia queda tan auditable como cualquier otra merma, sin inventar un tercer mecanismo de ajuste.

### D-058 — Reportes parciales y cierre explícito

**Decisión.** La OP acepta N reportes de piezas y se cierra en un acto aparte, mismo patrón que la recepción parcial de una orden de corte (RF-41). Estados `DRAFT` → `IN_PROGRESS` → `CLOSED` | `CANCELLED`; `DRAFT` mientras no tiene ningún fleje tomado, y se vuelve a `DRAFT` si se le revierte todo.

**Consecuencias.** El stock del perfil está disponible desde el primer parcial, no al final del turno. Cada reporte guarda quién lo hizo, cuántas piezas y qué material consumió, así que el rastro por tanda queda completo (RF-95). El cierre es lo que fija el momento en que el costo real se conoce (D-056) y la merma se puede calcular (D-057).

### D-059 — La receta vive en el maestro de productos

**Contexto.** El dueño pidió "BOM en maestro de productos: SKU fleje → SKU perfil, piezas/kg teórico".

**El matiz que hubo que resolver.** **Un fleje no tiene SKU.** D-049 decidió que un fleje es una fila de `coils` con `kind=STRIP`, no un producto de catálogo — justamente para no duplicar catálogo, kardex y trazabilidad. Inventarle ahora un SKU sería reabrir esa decisión por la puerta de atrás. Así que la receta identifica el insumo por **acabado + espesor + ancho**, que es exactamente el criterio con el que RF-42 ya agrupa el stock de flejes: el mismo trío que el operario ve en `/flejes`.

**Decisión.** `product_boms`, una fila por producto: `finishId`, `inputThicknessMm`, `inputWidthMm`, `pieceLengthMm` y `kgPerPiece`. El kilo por pieza se **sugiere** desde la geometría (`ancho × espesor × largo × densityFactor / 1e6`, D-047/RF-25) y admite override del maestro cuando planta pesó el perfil real. La función que lo calcula (`theoreticalKgPerPiece`) vive en `@ayr/shared` para que la previsualización del web y la validación del API no puedan divergir — la lección que dejó la previsualización del partido en Fase 2b. La OP valida cada fleje contra los tres campos y rechaza el que no coincide, que es RF-32 aplicado a drywall.

**Solo drywall en Fase 4.** Coberturas exigen cotización (RF-31, D-048) y su receta tiene otra forma (el largo lo fija el pedido, no el maestro). Dejar cargar recetas de coberturas ahora sería construir la mitad de un módulo que todavía no puede producir nada.

**Cambiar una receta con OP vivas está bloqueado.** Reescribir `kgPerPiece` a mitad de una corrida haría que los reportes anteriores hubieran consumido con un número y los siguientes con otro, y la merma del cierre saldría de una cuenta que nunca existió.

### D-060 — Asignar un fleje no mueve kardex, y qué se rompe si nadie lo mira

**Decisión.** Consumir un fleje en una OP es **asignarlo**: el fleje sigue en el almacén y en el saldo de la empresa hasta que un reporte de piezas lo consuma. Es el mismo criterio que D-050 tomó con el envío a corte tercerizado, y por la misma razón: un movimiento de kardex por material que todavía está en casa y puede volver a estar libre en cinco minutos ensucia el promedio ponderado sin ganar nada.

**El precio.** Ninguna de las reglas "no tiene movimientos posteriores" que protegen al resto del sistema (RF-16, RF-21, D-045, D-052) ve una asignación, porque no hay movimiento que ver. Es **exactamente** el hueco que D-050 abrió con `IN_THIRD_PARTY` y que Fase 3 tuvo que tapar a mano en cuatro sitios distintos, y que Fase 3b volvió a tapar en dos más. Así que esta vez se revisaron **todas** las rutas que tocan un fleje, no solo las nuevas:

| Ruta                                                        | Qué pasaba sin el guardrail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerScrap` (RF-17)                                     | La merma le sacaba a la OP material que sus piezas todavía no consumieron; la merma del cierre salía de menos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `split` (RF-15)                                             | El partido le sacaba el material por debajo a una orden en curso.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `setStatus` (RF-19)                                         | Cerrar el fleje lo sacaba de producción justo mientras se estaba usando.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `update` (RF-20, D-045)                                     | Recostear cambiaba, a mitad de corrida, el costo con el que ya habían entrado piezas; reanchar rompía la validación contra la receta.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cancel` (RF-21)                                            | La OP quedaba apuntando a un fleje anulado, sin ningún movimiento que lo delatara.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PurchasesService.cancel`                                   | Los flejes heredan el `purchaseId` de su madre: anular la compra los cancelaba con la orden en curso.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cancelScrap` (RF-18)                                       | Devolver los kilos de una merma anulada recalcula el promedio del fleje: los reportes siguientes de la OP salían a otro costo que los anteriores. Y peor: la **merma de proceso del cierre** (D-057) tiene la misma firma (`refType=SCRAP`, `itemType=COIL`) que una merma de RF-17, así que se podía anular desde el kardex de la bobina — devolviendo kilos y valor al fleje mientras las piezas conservaban el costo absorbido, es decir creando valor de la nada. Ahora se distinguen por `refId` (la merma de RF-17 apunta a la bobina; la de producción, a la orden) y la del cierre solo se deshace reabriendo la OP. |
| `revertSplit` (RF-16)                                       | Una hija del partido podía ser un fleje ya montado en una OP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `applyLandedCost` (D-043) y `applyCuttingOrderCost` (RF-41) | Un `ADJUST` de flete o de corte subía el costo de un fleje a mitad de corrida —los flejes heredan el `purchaseId` de su madre—, así que los reportes previos y los siguientes salían a costos distintos. Es la misma acción que D-045 ya tenía bloqueada, llegando por otra puerta.                                                                                                                                                                                                                                                                                                                                          |
| `CuttingService.reverse` (D-052)                            | La reversa de la recepción anulaba flejes que una OP ya tenía montados.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `consume` de otra OP                                        | Dos órdenes se repartían el mismo fleje sin saberlo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

El chequeo **toma el lock de las filas de los flejes antes de mirar** (`SELECT … FOR UPDATE`, en orden de id). `ProductionService.consume` toma ese mismo lock antes de crear la asignación, así que sin él quedaba una ventana real: el chequeo veía la lista vacía, un consumo concurrente commiteaba, y la operación seguía adelante anulando un fleje que para entonces ya era de una orden viva.

`CuttingService.send` (RF-40) no lo necesita: solo acepta `kind=COIL` y una OP solo consume `kind=STRIP`, así que los conjuntos no se cruzan. El guardrail vive en `production-assignments.ts` como **función suelta**, no como provider inyectable: `coils`, `cutting` y `purchases` lo llaman, y hacerlo un servicio metería a `production` en un ciclo de módulos con los tres.

**Las tres reversas van en esta misma fase.** Es la lección de D-051 (Fase 3 cerró con un hueco de reversa documentado y costó una sesión entera abrirlo de nuevo, además de dejar residuos en producción mientras tanto):

- **Revertir un reporte de piezas.** Saca las piezas del producto y devuelve los kilos al fleje, todo o nada. Solo el **último reporte vigente** de la orden: los reportes se apilan sobre los mismos flejes, así que deshacer uno del medio dejaría los kilos consumidos contando una historia que no ocurrió. Se bloquea si después del ingreso de esas piezas hubo cualquier movimiento del producto que no sea otra entrada — una salida (pudieron ser justo estas piezas) o un **ajuste de costo** del cierre de otra OP del mismo perfil, que se repartió sobre un saldo que incluía estas piezas.
- **Reabrir una OP cerrada.** Revierte el ajuste de costo y la merma de proceso, y devuelve los flejes a la orden, que vuelve a `IN_PROGRESS`. Guardrails con el mismo criterio conservador: ni las piezas ni los flejes pueden haberse movido desde el cierre, y ningún fleje puede haber sido tomado por otra orden. Sin esto, una OP cerrada sería irreversible y el stock de prueba de los E2E quedaría en producción para siempre, sin forma de purgarlo.
- **Anular la OP.** Solo con cero reportes vigentes. Como asignar no movió kardex, anular **no tiene nada que revertir**: los flejes vuelven a estar libres tal como estaban, igual que cancelar un envío `SENT` en D-050.

**Detalles que salieron de la revisión y conviene no volver a perder:**

- **El "último reporte" se decide por un `seq` serial, no por `createdAt`.** En Postgres `now()` es el instante en que **empezó** la transacción, así que dos reportes concurrentes sobre la misma OP pueden empatar en fecha o quedar invertidos respecto al orden de commit — y la regla "solo se revierte el último vigente" dejaría de ser cierta justo en el caso que pretende proteger. Es el mismo criterio por el que el kardex ordena por su `id` bigserial y no por `at`.
- **Reabrir sigue siendo del supervisor de planta, no solo del administrador.** El `ADJUST` que revierte es **derivado**, no un número que alguien tipea: `adjustPen = costo total − valor con el que entraron las piezas`, con el material saliendo de flejes que el supervisor ya controla por §3.4. Es la diferencia con el hallazgo de Fase 2b, donde el landed cost (D-043) permitía inyectar un monto arbitrario al costo del inventario y por eso pasó a ADMINISTRADOR. Reservar la reapertura al administrador dejaría a planta sin poder corregir su propio cierre.
- **Cerrar con mucha merma exige motivo.** `closeProductionOrderSchema` no pedía nada, mientras que la merma equivalente de RF-17 sí exige `reason`: cerrar con 20 flejes montados y una pieza reportada era una baja de inventario sin explicación. Por encima del 10 % de merma sobre lo asignado, el API pide motivo; el ratio queda en la auditoría para poder alertar después sin recalcularlo desde el kardex.
- **Una hija de un partido hereda la clase de la madre.** `split()` (RF-15) creaba las hijas sin pasar `kind`, así que partir un fleje devolvía bobinas (`@default(COIL)`): ese material se caía del stock de flejes (RF-42), producción lo rechazaba y el guardrail que D-060 acababa de agregar a `revertSplit` quedaba inalcanzable — ninguna hija de partido podía estar nunca en una OP. Es un defecto preexistente de Fase 2b que solo se vuelve visible cuando algo consume flejes; lo encontró `qa` al cerrar esta fase.
- **El `bomId` de la OP apunta a la receta viva, no a una versión congelada.** Editar una receta con órdenes vivas está bloqueado, así que solo una OP ya cerrada puede terminar mostrando un `kgPerPiece` distinto del que usó. Los datos reales están a salvo (`production_reports.theoreticalKg` guarda los kilos de cada reporte); si en algún momento hace falta la receta histórica, hay que congelarla en la OP al crearla.

## D-061 — Anular un pago a proveedor (Sesión M-2, cierra D-039)

**Fecha:** 2026-09-03

**Contexto.** D-039 (Fase 2a) dejó escrito: "Anular un pago se resuelve en Fase 2b junto con el resto de anulaciones." Fase 2b llegó y se fue sin construirlo — se anularon compras, mermas y partidos, pero no pagos. El hueco quedó invisible hasta que Fase 4 lo tropezó de frente: `pnpm prod:purge-e2e` no podía dejar producción sin rastro de pruebas porque `cancel()` bloquea anular una compra con cualquier pago registrado, y sin poder anular el pago, la compra —y su proveedor de prueba— quedaban ahí para siempre. El handoff de Fase 4 lo documentó como "6 comprobantes de servicio con un pago registrado" y como el único residuo que impedía un cierre 100 % limpio.

**El bug que este hueco escondía.** Al construir la reversa apareció algo peor que la ausencia de una función: `cancel()` contaba **cualquier** fila de `supplier_payments`, sin distinguir "vivo" de "anulado" — porque hasta ahora esa distinción no existía. Eso significa que, incluso hoy sin la reversa, el chequeo ya estaba mal formado: apenas se agregara la reversa sin corregir `cancel()`, una compra con un pago recién anulado habría seguido bloqueada, contradiciendo el propósito mismo de la reversa. El fix real tiene dos mitades inseparables: la reversa en sí, y enseñarle a todo el código que ya leía pagos (`cancel()`, `purchaseBalance`, `paidAmount`) que un pago puede estar anulado.

**Decisión.** `SupplierPayment` gana `reversedAt`/`reversedById` (append-only: la fila nunca se borra, mismo criterio que `CoilSplit`/`CuttingOrderCoil`). `POST /purchases/:id/payments/:paymentId/reverse` (solo ADMINISTRADOR, igual que `addPayment`/`cancel`, D-046) marca la fila y escribe el motivo en `audit_log` (RF-95), nunca en la fila misma. `purchaseBalance` — la única función que suma pagos — filtra `reversedAt === null` en un solo lugar, así que `paidAmount`, la lista de compras, el detalle y el estado de cuenta del proveedor quedan correctos sin tocarlos uno por uno. `cancel()` se corrige para contar solo pagos vigentes.

**Guardrails, mismo patrón que el resto del proyecto (D-050/D-052/D-060).** (a) Idempotencia: un pago ya anulado no se puede volver a anular — `409 Conflict`, mismo criterio que `InventoryService.reverse` con un movimiento ya revertido. (b) Defensivo: la compra no puede estar `CANCELLED` — hoy **inalcanzable** por la API, porque `cancel()` exige cero pagos vigentes antes de anular, así que una compra `CANCELLED` nunca tiene un pago vivo que revertir; se comprueba de todas formas, con el mismo criterio conservador que ya usan RF-16/RF-21/D-052 ante cualquier estado que no se pueda verificar. A diferencia de D-060 (asignar un fleje no deja rastro de kardex), un pago **no tiene ningún "downstream" real** en v1: no toca stock, no lo consume nada más que el propio saldo de la compra. El guardrail "aguas abajo" que de verdad importa **ya existía**: es el de `cancel()`, ahora corregido.

**Consecuencias.** `pnpm prod:purge-e2e` gana un paso (0.7) que revierte los pagos vigentes de las compras de prueba antes de intentar anularlas, cerrando el último residuo que Fase 4 había dejado documentado. Un pago anulado sigue visible en el detalle de la compra (columna "Estado": Vigente/Anulado) para que RF-95 quede satisfecho — nada desaparece, solo deja de contar para el saldo.

## D-062 — El `deny` de `.env*` en `.claude/settings.json` es una política permanente

**Fecha:** 2026-09-03

**Contexto.** Al abrir la Sesión M-2 sobre Fase 4, el `deny` de `Read(./.env*)` en `.claude/settings.json` apareció **eliminado del árbol de trabajo** (junto con `Bash(sed:*)` agregado al `allow`), con `Read(**)` y `defaultMode: auto` ya vigentes — es decir, cualquier agente podía leer `.env.setup` (que la regla dura 5 de `CLAUDE.md` prohíbe imprimir: tiene **todas** las credenciales del proyecto) sin que nada lo bloqueara. El cambio era anterior a esa sesión y de origen desconocido; se restauró entonces, ampliado a `Read(**/.env*)`. Al abrir la Sesión **M-2** (esta), se verificó que seguía intacto — no había vuelto a faltar.

**Decisión.** El `deny` de `.env*` (ampliado en Fase 4 de `Read(./.env*)` a también `Read(**/.env*)`) es una política **permanente**, no una configuración de sesión que un agente pueda remover o negociar. Si vuelve a faltar, restaurarlo es la acción correcta por defecto — no una pregunta de "¿esto se quitó a propósito?".

**Consecuencias.** Queda pendiente que el dueño confirme si la eliminación original (antes de Fase 4) fue intencional. Si no lo fue, vale la pena revisar si `.env.setup` llegó a leerse por algún agente mientras el `deny` estuvo ausente y, de ser así, evaluar rotar las credenciales que contiene (Neon, JWT, Nubefact, R2, UptimeRobot). Esta sesión no encontró evidencia de que se haya leído —el archivo nunca aparece en ningún transcript ni output de las sesiones de Fase 4 o M-2—, pero tampoco hay forma de confirmarlo desde el repositorio.
