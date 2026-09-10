# Handoff — Sesión HOTFIX post-deploy — 2026-09-10

## 1. Resumen

Cuatro flujos que la ventana de deploy expuso porque nunca se habían ejercitado de punta a
punta con datos reales: **un servicio no se podía cotizar por ninguna puerta**, **los importes
de un comprobante importado se recalculaban** (y el rechazo salía a la superficie en la
cobranza), **el SKU de venta directa de una bobina lo calculaban dos funciones que no
coincidían**, y **la plancha de catálogo exigía tener planchas en un almacén donde nunca vive**.
Cinco decisiones nuevas, **D-167..D-171**, dos de ellas reglas de negocio del dueño.

`pnpm turbo lint typecheck test` en verde (**399/399** unitarios). E2E: **22/22** de los cinco
frentes nuevos y **41/41** de la regresión de D-171; la suite completa pasa de **26 fallados a
13**, y los 12 que sobreviven son todos el cupo de la cuenta demo del PSE.

**Nada desplegado y sin push.** Contra `production` solo se corrieron los dos guiones de
**solo lectura**, con tu OK.

---

## 2. Hecho

### M0 — Un servicio no se podía cotizar (D-167)

«Línea 1: el producto CONFORMADO es de una línea sin inventario: no se cotiza», sobre lo que
una empresa de transformación factura todo el tiempo. El rechazo estaba en
[`sales-lines.ts`](../../apps/api/src/sales/sales-lines.ts) y cortaba **antes** de llegar al
kardex, que ya trataba el caso como el no-op explícito que es (§2.2): la mitad de abajo del
sistema estaba lista y la de arriba no dejaba llegar.

La exención la decide ahora `carriesInventory(line)` en
[`enums.ts`](../../packages/shared/src/enums.ts), por el **atributo** `inventory_strategy` y
nunca por el código de la línea; reemplaza a las tres comparaciones sueltas que había.

Dos consecuencias que había que decidir, no dejar implícitas:

- **El despacho rechaza una línea de servicio** ([`dispatches.service.ts`](../../apps/api/src/invoicing/dispatches.service.ts)).
  No sale nada del almacén; dejarla pasar hacía que el despacho pidiera «el peso en kilos» de un
  conformado y lo escribiera en la guía de remisión como un bulto.
- **`recomputeOrderStatus` no la espera** para llegar a `FULFILLED`. Sin eso, todo pedido que
  mezclara mercadería con un servicio quedaba en `PARCIALMENTE DESPACHADO` para siempre.

**Lo que la revisión encontró y amplió el alcance:** el web filtraba el selector de línea de
negocio por `inventoryStrategy === 'STOCK'`, así que Servicios **ni siquiera se podía elegir** y
todo lo agregado del lado del navegador era código muerto.

### M1 — El rechazo por céntimos vivía en la cobranza (D-169)

**No estaba en el importador.** Ahí no hay ninguna comparación de importes. Se reprodujo el
camino completo contra el API local hasta encontrarlo: una línea de 3 × S/ 33.3333 da un total
de **117.9999**, el papel dice S/ 118.00, y cobrar los 118 del papel se rechazaba con

```
El cobro excede el saldo pendiente (S/ 118.00)
```

sobre un cobro de exactamente S/ 118.00 — el mensaje redondeaba para mostrar y la comparación
no. Dos cifras idénticas en pantalla y un 400 sin salida.

**Dos arreglos, y hacen falta los dos**: `netAmountPen` persiste el importe del papel (la
causa) y `payableBalance` compara el saldo **en céntimos** (la clase entera, que también
alcanza a un precio tipeado a mano). Más tres cierres aguas abajo en
[`invoicing.service.ts`](../../apps/api/src/invoicing/invoicing.service.ts): la línea que
factura un pedido entero **copia** su importe, la cabecera del comprobante y la de la nota de
crédito **suman sus propias líneas**, y acreditar una línea entera acredita su importe entero.

**La tolerancia tuvo que dejar de ser un número fijo.** El techo plano de S/ 0.10 rechazaba
justo los documentos que la decisión venía a poder importar: el redondeo del unitario produce
hasta `cantidad × 0.00005`, o sea S/ 0.12 en una línea de 2 500 kg.

### M2 — El guion es un separador (D-168)

`coilSkuFromTypeKey` borraba **todos** los guiones y `coilSku` conservaba los del acabado. Con
un código sin guiones (`GALV`) coinciden y el test que había pasaba; con uno real del cliente
(`ALZ-ROJO-3002`) no, y RF-73 respondía «no existe el producto de venta directa» sobre una
bobina que sí tenía el suyo. Una sola función lo arma ahora
([`coil-code.ts`](../../packages/shared/src/coil-code.ts)).

### M3 — A la venta de bobina entera le faltaba el cierre (D-170)

Al leer el código antes de diseñar apareció que **RF-73 ya estaba casi entero desde D-116** y
que lo que la rompía en la práctica era M2. Lo que faltaba: el despacho **cierra** el rollo que
quedó en cero y sin reservas, y la reversa lo **reabre** — mirando el último cierre del rollo,
porque una bobina que ya estaba cerrada cuando se vendió (caso normal de D-116) no se reabre.
Un despacho parcial con remanente no lo cierra: eso sigue siendo D-164, con su liquidación.

### M4 — La plancha no es stock terminado (D-171, revierte D-140)

Nace `isMadeToOrder`, la **cuarta** pregunta de la familia, y `orderedMeters` convierte planchas
a metros con el largo del SKU. El 1 % de merma normal **no** se suma aparte: vive dentro de la
densidad estándar desde D-165. Producir coberturas a stock se eliminó, y la tarjeta de `/planta`
se fue con la puerta para no dejar un callejón (D-156).

**Un defecto viejo que apareció al mirar el camino del despacho:** `resolveDispatchTarget`
decidía «se fabrica contra el pedido» con `productBom.count`, y desde D-122 una cobertura **ya
no tiene receta** — un despacho anterior a producir emitía una salida de **kilos de bobina** por
una venta de planchas, que es lo que D-088 vino a cerrar.

---

## 3. Decisiones tomadas

| ID        | Una línea                                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-167** | Una línea de negocio sin inventario se cotiza, se vende y se factura; lo único que no hace es prometer existencias, y la exención la decide el atributo, no el código. |
| **D-168** | El SKU de venta directa de una bobina lo calcula **una sola** función: el guion del `typeKey` es un separador, no un carácter a borrar.                                |
| **D-169** | El importe de una línea importada es el del papel; se copia y no se recalcula, y el saldo se cobra en céntimos, que es la escala en la que se cobra.                   |
| **D-170** | La venta de una bobina entera la **cierra**, y la reversa del despacho la reabre. Sin `refType` nuevo.                                                                 |
| **D-171** | La plancha de catálogo se produce contra el pedido y reserva materia prima; producir coberturas a stock deja de existir. Revierte D-140.                               |

RF actualizados: **RF-31**, **RF-50**, **RF-61**, **RF-73**, **RF-86**.

---

## 4. Bloqueos y pendientes

### Necesita acción tuya

- **Vaciar los comprobantes de la cuenta demo del PSE.** Está en su tope («No puedes enviar mas
  de 50 documentos en en una cuenta DEMO») y con eso quedan **12 casos rojos** en `fase5b`,
  `fase5b-bordes` y `fase7b`. **No es una regresión** y no se silenciaron: `probePse` no cubre
  este caso —el PSE está configurado, solo sin cupo— y saltear esos casos por cuota escondería
  regresiones reales el día que las haya.
- **Dar el OK para desplegar.** Está en local y sin push, junto con D-164..D-166 de las sesiones
  anteriores. **No hay migración nueva** en esta.
- **Mirar cuántos clientes activos hay en producción.** El selector de cliente de la cotización
  pide 200 y los pinta en un `<Select>` plano sin búsqueda; con más de 200 activos **el vendedor
  no puede elegir a la mayoría**, y no hay ningún error: simplemente no están en la lista. No es
  de esta sesión y no se tocó, pero conviene saberlo antes de que alguien lo descubra vendiendo.

### Anotado, no hecho

- **Un pedido de solo servicios no llega a `FULFILLED`** y se queda en `CONFIRMADO`: el ERP no
  modela la ejecución de un servicio. Hoy no existe ninguno; la decisión conviene tomarla cuando
  aparezca el primero.
- **Editar el precio de una línea importada** la saca del importe del papel, que es lo correcto
  —quien lo edita está diciendo que el papel decía otra cosa— pero nada en la pantalla lo avisa.
- **El importador deja editar el unitario, no el importe.** Ahora que el importe manda, lo
  natural sería al revés. No se movió la forma de una pantalla conocida en medio de un hotfix.
- **Reabrir la producción a stock de coberturas** exige responder antes qué hace una línea de
  pedido cuando ese saldo existe. `createToStock` quedó en el archivo, sin llamadores.
- **`BOB38AZUL` y `BOB38ROJO` en `production`** son SKU creados a mano que ninguna bobina nombra;
  antes de darlos de baja hay que ver si alguno está cotizado o vendido.

---

## 5. Cómo verificar

```bash
pnpm turbo lint typecheck test     # verde (399/399 unitarios)
pnpm exec eslint e2e
pnpm exec prettier --check apps packages docs CLAUDE.md scripts e2e

# Solo lectura, contra la base real (ya corridos en esta sesión con tu OK):
pnpm check:coil-skus --branch production
pnpm check:roofing-catalog --branch production   # incluye el censo de PLANCHA

# Recrear `ayr_local_e2e` antes de una tanda larga (ver notas operativas de PROGRESO).
# Matar servidores viejos en :3000/:3001; NO tocar :4000/:4001 (regla dura 15).
pnpm e2e servicios-d167 bobina-sku-guiones-d168 importe-importado-d169 \
         venta-bobina-entera-d170 plancha-contra-pedido-d171          # 22/22
pnpm e2e fase6 fase7-consolidada-subtipo fase7final-op-a-stock precios-d161-d163 \
         planta-avisos-materia-prima planta-espacio-produccion-ui plancha-largo-d166   # 41/41
```

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126). La verificación post-deploy es
`pnpm smoke:prod`, de solo lectura. Prod: <https://ayr-steel-erp-web.vercel.app>.

---

## 6. Siguiente sesión

1. **Vaciar el cupo del PSE demo y volver a correr la suite completa**, que es lo único que
   separa a `pnpm e2e` de estar entera en verde.
2. **Desplegar** D-164..D-171 juntos, con las migraciones acumuladas que PROGRESO lista (la de
   D-164 va **antes** que el API nuevo).
3. **Usar lo que se construyó**: cargar agosto con el importador —ahora los importes entran
   tal como salieron en el papel—, cotizar un conformado, y producir un pedido de planchas
   desde `/planta`.
4. **Fase 8 — auditoría, reportes y UAT**, la siguiente según `docs/ARQUITECTURA.md` §3.7.
