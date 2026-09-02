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
