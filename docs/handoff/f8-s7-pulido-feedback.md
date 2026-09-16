# F8-S7 — Pulido y feedback de uso real

Cierre de la sesión del 2026-09-16. Decisiones nuevas: **D-211, D-212, D-213**.

Es la primera sesión de producto con **producción operando de verdad**, y eso cambió de dónde
salió el trabajo: los tres módulos vienen de que el cliente usara la app durante la migración,
no de un backlog. La regla de la sesión fue **additive only** — una sola migración, que crea una
tabla y nada más.

## Qué quedó hecho

| Módulo | Qué                                                                                                                              | Decisión |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | -------- |
| M1     | La fecha de emisión de un comprobante **manual** se corrige, con motivo, historial visible y el vencimiento corriéndose con ella | D-211    |
| M2     | El acabado se elige por **color comercial**; el código técnico solo desambigua                                                   | D-212    |
| M3     | Al facturar se **declara** qué despacho cubre el comprobante (cierra la deuda de D-205)                                          | D-213    |
| M4     | Cosméticos (`<main>` anidado)                                                                                                    | —        |

## Lo que hay que saber antes de tocar esto

**M1 no es «editar la fecha»: es «corregir el dato de un papel».** Por eso solo alcanza a
`origin = MANUAL`. Un `ISSUED_HERE` mandó su fecha al PSE y la tiene en un CDR firmado; tocarla
en el ERP la desalinea de SUNAT sin forma de deshacerlo. Un `IMPORTED` se corrige donde se
emitió y se reimporta. Si alguna sesión futura recibe «que se pueda editar en todos», **esa es
la razón por la que no**, y está en D-211 con todas las letras.

**El vencimiento se corre con la emisión, y eso es una decisión, no un descuido.** No se
recalcula con `customers.credit_days` porque el dato guardado no dice si salió de ahí o lo
tipeó alguien (D-075 admite las dos): recalcular pisaría el segundo caso en silencio. Correr el
delta conserva el plazo pactado en los dos. Y como igual es un efecto colateral, la pantalla lo
muestra antes de confirmar y el API exige `confirmDueDateShift`.

**`shiftDate` vive en `@ayr/shared` y tiene que seguir viviendo ahí.** Nació duplicada en esta
misma sesión —una copia en el API y otra en la pantalla— y la regla de lint contra
`toISOString().slice(0, 10)` la cazó. La pantalla le promete al usuario el vencimiento nuevo
antes de confirmar; con dos implementaciones, lo prometido y lo guardado se pueden separar sin
que nada falle. Es la lección que `resolveDueDate` ya tenía escrita.

**M2 es solo presentación, y conviene que siga siéndolo.** D-203 y D-085 quedaron intactos: el
`color_id` de la bobina sigue saliendo del acabado por el trigger y todo emparejamiento va por
id. La tentación que se descartó fue renombrar los acabados del catálogo para que se leyeran
mejor; el código técnico es lo correcto para el SKU y el `typeKey`, y cambiarlo habría
arrastrado esas dos cosas detrás de un problema de `<select>`.

**M3 no infiere nada, y esa es la parte importante.** D-205 descartó inferir el despacho por
diseño y no por costo: un link falso pesa más en auditoría que un guion. Por eso el campo es
opcional, la pantalla preselecciona **solo** si hay exactamente un despacho enlazable, y con dos
o más no elige por el usuario. «El primero de la lista» sería una inferencia con otro nombre.

## Deuda que esta sesión encontró y no resolvió

**Drift entre `schema.prisma` y las migraciones.** `migrate dev` para la tabla de M1 arrastró
`DROP INDEX` de dos índices, `DROP DEFAULT` del `operation_date` de cinco tablas, un
`RENAME INDEX` y cuatro FK recreadas. No es de esta sesión: son diferencias acumuladas entre el
SQL escrito a mano en migraciones viejas y lo que el schema declara. **No afecta a nada hoy** —
un índice es rendimiento y un `DEFAULT` que la aplicación siempre pisa da igual—, y ni
`migrate status` ni `migrate deploy` lo miran. Aparece **solo al generar una migración nueva**.

Mientras no se concilie: **toda migración generada con `migrate dev` se lee entera antes de
commitearla**. La de esta sesión se escribió a mano con el `CREATE TABLE` solo. Conciliarlo es
una sesión propia, con producción en uso real, y no algo para hacer de paso.

**Y la advertencia operativa que salió de ahí:** una migración se genera contra la base
**descartable**, no contra `ayr_local`, que es la del dueño. Acá se corrió contra ella por
descuido y hubo que reponerla con `pnpm db:local reset` (no se perdió nada: estaba vacía salvo
el cliente del seed, pero pudo no estarlo). La regla dura 15 protege los puertos de
`dev:preview`; su base merece el mismo cuidado.

## Lo que costó, para que la próxima sesión no lo repita

**Tres bloqueantes en M3, y el primero es el que hay que entender.** La primera versión escribía
`fiscal_documents.dispatch_id` además de `dispatches.invoice_id`. Esa columna **ya tenía dueño**:
significa «este documento _es_ la guía de remisión de ese despacho», y un CHECK de Fase 5b la
exige nula en todo lo que no sea una GRE. La emisión con despacho declarado terminaba en 500, y
justo en el caso que la pantalla preselecciona. Se eligió la columna por su nombre, sin releer
qué preguntaba — la misma forma de error que la regla dura 14, sobre columnas en vez de
funciones. **El enlace de D-205 vive en `dispatches.invoice_id` y en ningún otro lado.**

**El enlace se toma al crear el comprobante, que es antes de saber si va a existir.** De ahí
salen las tres piezas que lo sostienen y que conviene no tocar sin entenderlas: `discardDraft`
suelta el enlace antes de borrar (la FK es `ON DELETE RESTRICT`, si no el borrador queda
indescartable), lo que ocupa un despacho es un comprobante **vivo** y no la mera presencia del
id, y revertir un despacho también lo suelta.

**Dos veces la misma lección, en la misma sesión: una regla copiada en dos lados son dos
reglas.** Primero `shiftDate`, que nació en el API y otra vez en la pantalla —la cazó el lint—;
después `finishLabels`, cuya copia implícita eran los specs armando `CÓDIGO — Nombre` a mano, y
que tiró tres tests que no hablaban de acabados. Las dos viven ahora en `@ayr/shared` y las leen
todos. Si M2 se extiende a más pantallas, la etiqueta sale de ahí.

**Y una de forma, no de criterio:** un heredoc se comió las barras invertidas de un regex
(`/^d{4}-d{2}-d{2}$/`), y **volvió a pasar al intentar arreglarlo por el mismo camino**. El
efecto no era un error visible: el aviso del corrimiento del vencimiento no se renderizaba
nunca mientras el front mandaba `confirmDueDateShift: true`, o sea que el vencimiento se habría
movido en silencio. Es la regla dura 16 y vale para el código igual que para los docs: **el
texto con `\`, `$` o backticks no pasa por la shell**.

## Cómo correr la suite en esta máquina

En modo dev el host **no aguanta** la corrida completa: la mata por memoria cerca del test 308
de 347. Con los builds de producción entra entera y tarda 25 min en vez de 1,6 h. `CI=1` es lo
que hace que `playwright.config.ts` levante `start` en vez de `dev`; a cambio hay que pasar a
mano lo que el bloque `!isCI` completaba solo (`DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `E2E_RESET_DB`, `ALLOW_DB_RESET`). El worktree del runbook de
F8-V4prep **no hace falta** salvo que el dueño tenga `dev:preview` levantado: existe para no
pisarle `apps/web/.next`.

Y para un archivo suelto: `pnpm exec playwright test e2e/tests/<archivo>.spec.ts`. **`pnpm e2e
-- <archivo>` corre la suite entera en silencio** — con `--grep` anda porque es una opción, con
una ruta el filtro posicional se ignora.

## Pendientes que esta sesión deja

- **`purgeInvoicingTrail` gasta cupo de Nubefact.** Un manual `ACCEPTED` no admite baja ante
  SUNAT, así que la purga cae en su rama genérica y **emite una nota de crédito real contra el
  PSE**; `createCreditNote` bloquea `IMPORTED` pero no `MANUAL`. Cada corrida completa se lleva
  unos comprobantes del cupo de 50 de la cuenta demo. Los specs nuevos lo esquivan cerrando con
  anulación interna antes de purgar; **el helper sigue sin arreglar**.
- **Drift entre `schema.prisma` y las migraciones** (ver arriba): toda migración generada con
  `migrate dev` hay que leerla entera antes de commitearla.
