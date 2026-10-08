# Revisión de segundo modelo — cc33 corte 2

Modelo: Sonnet, contexto limpio. Alcance: `git diff origin/cc33-correcciones...origin/cc33-c2`
(`invoicing.service.ts`, `invoicing-net.spec.ts`, `cc33-comprobante-pedido.spec.ts`). Revisión
por lectura; no corrió tests.

**Veredicto:** sin P0 ni P1. Hay un P2 y cuatro P3.

## Verificado

- **N2.** `assertSellerAccess` va antes de cualquier escritura. La transacción de `create()`
  revierte también la clave de idempotencia. El E2E lo confirma: A reusa la clave de B.
- **Orden de bloqueos.** No cambia y no hay `FOR UPDATE` nuevo.
- **Mostrador.** El mismo cliente, el vendedor es el actor y el pedido está `CONFIRMED`: no se
  rompe.
- **Pedido con `sellerId` nulo.** Un VENDEDOR ya recibía 404 en `findOne`; ahora lo recibe antes
  de escribir.
- **Notas de crédito.** Salen por su rama antes del bloque nuevo.
- **Los dos que llaman a `assertStillAvailable`** cargan la fila completa (`include`).
- **«Corregir rechazado».** Copia pedido y cliente; si el pedido se anuló, el reintento se rechaza
  al emitir, que es lo buscado.

## Hallazgos

- **P2.** La reválida de la cabecera no está probada a través de `registerManual` ni de
  `assignInTx`. Si un `include` pasa a `select` sin esos campos, el guard se apaga en silencio.
  Arreglo: un test por ese camino, o campos obligatorios en el tipo.
- **P3.** La rama de N4 de `createInTx` solo tiene cobertura E2E.
- **P3.** `assignInTx` lee el pedido sin bloquearlo. Ya pasaba con las líneas; D-383 cierra la
  carrera en la práctica.
- **P3.** Una réplica idempotente de otro vendedor sale antes del alcance. Da 404 en `findOne` y no
  escribe nada: es inocua.
- **P3.** Un borrador de líneas libres queda sin poder emitirse si se cambia el cliente del pedido
  (D-187). El mensaje es claro. Hay que confirmar con el dueño que esa es la política.
