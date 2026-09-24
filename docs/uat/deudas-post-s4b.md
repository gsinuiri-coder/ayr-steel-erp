# UAT — Deudas post-RF-S4b (2026-09-24)

En `demo`. Los pasos escriben reservas y precios: **nunca en production**. El paso 3 se puede
correr en production después de la ventana (es de solo lectura).

## 1. El rechazo de reserva no nombra la cotización de otro vendedor (D-275)

Hacen falta dos vendedores (A y B) y una bobina de cobertura sola en su color y espesor (por
ejemplo, una de 100 kg recién comprada en demo).

1. Como **A**: cotizar una cobertura a medida de ese color y espesor que use la mayor parte de
   la bobina (p. ej. 20 m sobre 100 kg) y pulsar **Reservar**.
2. Como **B**: cotizar la **venta de la bobina entera** (producto `BOB…`, elegir la bobina) y
   pulsar **Reservar**.
   **Esperado:** rechazo «… hay … kg prometidos a cotización no disponible (reserva temporal)
   …». No aparece el código COT-… de A.
3. Como **ADMINISTRADOR**, **Reservar** la cotización de B.
   **Esperado:** el mismo rechazo, con «COT-… (reserva temporal)» de A.
4. Liberar la reserva de A al terminar.

## 2. Corregir producto y precio con cambio de unidad deja registro (D-276)

1. Como ADMINISTRADOR, abrir una cotización emitida con una línea por kg y **Editar**.
2. En esa misma línea, cambiar el producto por uno que se venda por metro y poner otro precio.
   **Guardar cambios.**
3. **Esperado:** en «Cambios de precio» aparece una fila de esa línea, con el producto nuevo y
   los dos precios.

## 3. `smoke:prod` contra el dominio propio

1. Desde un worktree en el SHA desplegado: `pnpm smoke:prod --base-url https://v2.mareliac.pe`.
   **Esperado:** corre (antes lo rechazaba «--base-url tiene que ser https y del dominio del
   proyecto»).
