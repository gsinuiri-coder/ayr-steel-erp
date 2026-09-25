# Handoff — Hallazgos de la guía (D-310 a D-312), 2026-09-25

Rama `fix/hallazgos-guia` (worktree `../ayr-steel-erp-guia-final`), desde `origin/main` en `0e31c83`.
PR #30, merge `dffb2eb`; SHA desplegado `fbd2c04`; API `ayr-steel-erp-api-00055-8cs`. **Sin
migraciones.** Estado de partida en producción: API `00054-rw8`, git-sha `6182e3e`.

## 1. Qué entró

| Milestone | Decisión | Resumen                                                                                                                                                                                                                                    |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1        | D-310    | Una bobina atada a otra cotización abierta no se ofrece (`sellable-coils`), se lista en «No se ofrecen» y se rechaza al guardar (alta, edición, duplicado y pedido directo). Una sola regla (`findCoilTies`) para pool, listas y guardado. |
| M2        | D-311    | Reserva consumida por una entrega: «Entregada en DES-…» con enlace; ya no pide revertir una orden de producción. Derivado al leer (`reservation-dispatches.ts`), sin columna.                                                              |
| M3        | D-312    | «Despachar» solo si al pedido le queda algo por despachar (misma consulta `order-progress` que el formulario).                                                                                                                             |
| M4        | —        | Solo lectura: el 500 fue un P2024 del pool de Prisma en `AuthGuard` (ver `docs/PROGRESO.md`, «M4»). Sin código.                                                                                                                            |
| M5        | —        | Guía final `docs/cliente/revision-2026-09-25.md`: la guía verificada + la de corr03, reescrita contra producción.                                                                                                                          |

Commits en la rama: `3bfe9a6` (M1), `33e8f21` (M2 y M3), `1adcd87` (autorrevisión y guía),
`013516f` (formato), `fbd2c04` (pruebas para el gate de Sonar); más `867e8d0` (la guía verificada,
cherry-pick) y el merge de `docs/cierre-corr03`.

## 2. Verificación

- `pnpm lint`, `pnpm typecheck`, `pnpm test` (API 1261 pruebas), `pnpm format:check`: en verde.
- E2E de los 23 specs afectados: 67 pasados y 3 rojos iniciales. `fase5a.spec.ts:100` (PDF en R2, sin
  credenciales en el worktree: **infraestructura**); `fase7e.spec.ts:183` (**producto**: anular el
  pedido devuelve la cotización a «emitida» y la bobina vuelve a quedar atada; el spec se actualizó);
  `pedido-edicion-f8s2.spec.ts:378` (pasó al repetir; probable interferencia de una edición del API
  a mitad de corrida, no comprobado). CI: todo en verde, incluida Sonar.
- No se corrió la suite E2E completa con builds de producción (AGENTS §5): solo los specs afectados
  y la CI del runner.
- Cobertura de código nuevo medida en local: 95,2 % (79/83 líneas del API).

## 3. Autorrevisión

`docs/revision/hallazgos-guia-autorrevision.md`: subagente nuevo, **autorrevisión, no pase cruzado**.
0 P0, 0 P1, 7 P2. Corregidos: H1 (la edición no rechaza la bobina que ya vendía), H2 (el rechazo a
un VENDEDOR no confirma que otra cotización la tiene), H6 (`order-progress` se invalida). Sin cambio:
H3 (carrera sin lock; la barrera sigue siendo confirmar), H4 (`EMITTED` vencida sin barrer ata la
bobina), H5 (dos consultas en serie), H7 (solo la última entrega). Registrado en `PROGRESO.md` como
**PENDIENTE DE REVISIÓN INDEPENDIENTE**.

## 4. Para el dueño

1. **Agregar ítems a un pedido confirmado no aplica D-310** (`sales-order-edits.service.ts`, línea de
   alta de ítems): acepta una bobina atada a otra cotización. El brief nombró alta, edición y
   duplicado de cotización, y un spec fija ese comportamiento como diseño. ¿Se cierra el hueco?
2. **Duplicar una cotización abierta con una bobina entera ahora rebota** mientras la original siga
   abierta (hay que anularla o elegir otra bobina).
3. **`/kardex`: «Desde» y «Hasta» rellenados casi a la vez se pisan** (la segunda fecha usa el
   `Desde` viejo porque el `onChange` toma `dates.from` del render). Lo vio Playwright; a mano es poco
   probable. Arreglo mínimo: la forma funcional de `setUrl`. No se tocó (fuera de alcance).
4. **El 500 de M4** es probablemente una conexión inactiva o Neon despertando con `connection_limit=5`;
   si vuelve a aparecer, evaluar `pool_timeout`/`connect_timeout` más generosos o instancias mínimas.

## 5. La guía: qué se ve y qué no

Verificado contra producción tras el deploy (solo lectura, admin efímero borrado): chips «Anulados»
y «Atendidos», «Listo» (11 pedidos), kardex por ítem con el formato del cliente y selector
Promedio/PEPS (UPVC36MT en agosto: Carga inicial 01/08 y venta 11/08 DES-000004), menú acordeón,
aviso del PSE en ⓘ con «Emisión electrónica: apagada», bobinas de COT-000002/000011 en «No se
ofrecen», PED-000028 «Entregada en DES-000009».

No se ve con los datos reales de hoy (se anotó en la guía) y **se puede mostrar en demo esta noche**:

- **1.4 «Cotizar por metro»:** hace falta una cotización importada con planchas sin confirmar; en
  demo hay que cargarla con el importador (no se arma desde la interfaz).
- **1.5 en planta:** hay que crear un pedido ROJO de prueba y generar sus órdenes en demo.
- **1.3 paso 6 (vendedor ve «no disponible»):** hace falta una cuenta de vendedor (no hay ninguna en
  producción, ver 2.3); en demo se crea una.
- **1.12 paso 4** y **1.3 paso 3** ya se ven en producción (las dos bobinas atadas).

## 6. Cierre de ramas y worktrees

- PR #29 (`docs/cierre-corr03`): su contenido entró en la rama por merge y GitHub lo marcó como
  mergeado al llegar su commit a `main` con el PR #30.
- Ramas remotas `fix/correcciones-03` y `docs/cierre-corr03`: borradas (no protegidas).
  `docs/guia-revision-verificada` nunca se empujó: solo existía local; se borraron su rama y su
  worktree `../ayr-steel-erp-docs-guia-verificada` (sin `local-data/` ni cambios).
- `fix/hallazgos-guia` (remota): la borra el dueño (AGENTS §4).
- Verificación de producción: el script de un solo uso (`local-data/guia-verif/verify.mjs`) se
  borró; las capturas y el log de la corrida quedaron en `local-data/guia-verif/` del checkout de
  esta sesión.
