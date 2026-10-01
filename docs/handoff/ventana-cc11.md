# Runbook: ventana de cc11 (D-377, decimales: totales al céntimo)

**Estado: PENDIENTE.** Se ejecuta esta noche, con el cliente fuera de la app.

Cada paso marcado **[OK]** espera el OK explícito del dueño (D-251/D-232). El agente propone el
comando exacto y espera.

- PR: `<PR>` (rama `cc11/decimales`).
- **No hay migración.** No se escriben datos: no se recalcula ningún documento ya grabado (D-377,
  «solo hacia adelante»).
- **Orden:** comprobación con los PDF → API → smoke → merge (web) → smoke → verificación en
  pantalla.
- **La API nueva convive con la web vieja durante los minutos entre los dos deploys**, con dos
  diferencias:
  - Las cotizaciones y pedidos nuevos ya salen con el total al céntimo, aunque la web vieja
    muestre la vista previa a cuatro decimales.
  - Un cobro precargado por la web vieja con un saldo de cuatro decimales (S/ 117.9999) lo rechaza
    la API nueva con «hasta dos decimales». Se resuelve escribiendo el monto al céntimo, y deja de
    pasar cuando se publica la web.
- **No hace falta respaldo Neon:** no hay migración ni escritura de datos. Si el dueño lo quiere
  igual, el mismo paso de cc08 con `respaldo-pre-cc11-<fecha>`.

## 0. Comprobación con los PDF de Nubefact: ANTES del merge [dueño + agente]

R2 se midió sobre las **líneas** de los exportes (141 comprobantes). Las cabeceras (gravada, IGV,
total) no vienen en el exporte; las confirma el PDF.

1. **[dueño]** Deja 2 o 3 PDF de Nubefact en `local-data/nubefact-pdf/`. Al menos uno debe tener
   varias líneas, y mejor si es de los 27 donde R1 y R2 difieren. El agente da la lista con
   `local-data/` antes de empezar.
2. **[agente]** Para cada PDF, compara:
   - **gravada** del PDF contra `céntimo(Σ valor de las líneas)`;
   - **IGV** del PDF contra `céntimo(Σ valor × 18 %)`;
   - **total** del PDF contra gravada + IGV.

   Revisa además si el total del papel es gravada + IGV o `céntimo(Σ totales de línea)`. Con el
   146 × 16.28928 la primera da 2,806.31 y la segunda 2,806.32: no pasa en todos los documentos,
   pero si el papel usa la segunda hay que corregir la fórmula del total.

3. **Si los tres PDF coinciden con R2, se sigue. Si no, se para:** no hay deploy. El agente
   presenta la diferencia y la regla que la explica.

## 1. Antes de empezar [agente]

```sh
git fetch
gh pr checks <PR>
git rev-parse origin/cc11/decimales     # = <SHA>
git diff --name-only origin/main origin/cc11/decimales -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

Lo esperado antes de la ventana es la revisión `ayr-steel-erp-api-00073-zmj` con
`git-sha=abe3e08`. Esa revisión es la vuelta atrás.

## 2. Deploy de la API [OK]

```sh
git checkout --detach <SHA>
pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
git checkout main
```

Verificar el `git-sha`, que la revisión esté al 100 % y que `/health` responda 200. Después,
`pnpm smoke:prod` desde un worktree en `<SHA>` (con `AYR_ENV_SETUP`).

## 3. Merge a `main`: publica la web [OK]

```sh
AYR_OWNER_PUSH=1 gh pr merge <PR> --merge
```

Comprobar que el diff de runtime contra `<SHA>` sale vacío y que Vercel terminó en `success`.
Correr `smoke:prod` contra `vercel.app` y contra `--base-url https://v2.mareliac.pe`.

## 4. Verificación en pantalla [agente, solo lectura]

Sin crear documentos en producción (D-126):

- **Cobranzas** (`/cobranzas`): los totales y la lista de clientes no muestran comprobantes con
  saldo S/ 0.00. Es el arreglo A.
- **Comprobantes, filtro «Pendientes»:** ninguna fila con saldo S/ 0.00.
- **Un comprobante con saldo:** «Registrar cobro» se abre con el saldo al céntimo. Se cancela sin
  registrar.
- **Un PDF de cotización existente:** los importes redondean, no truncan.

## Riesgos conocidos (de las revisiones, aceptados o pendientes del dueño)

- **IGV de cabecera = céntimo(Σ IGV de línea)**, no `Σ valor × 18 %` como decía §5.2 del análisis.
  Así se conserva el trío del papel de D-255. **Lo confirma el dueño antes del merge** (D-377).
- **Peso teórico de planchas con un solo redondeo:** cambia el teórico que se usa como referencia
  del tope de kg declarado. En el caso real de D-246, 4,043.952 pasa a 4,043.916 kg. El tope duro
  está en metros; el kilo de más solo avisa (D-154).
- **Notas de crédito parciales:** cada una redondea su cabecera, así que varias pueden acreditar un
  céntimo más que el comprobante. El saldo queda en cero (nunca negativo en cobranzas) y el arreglo
  A lo esconde. Si el dueño quiere cerrarlo, la nota que agota el comprobante tomaría el resto, como
  D-265 en la línea.
- **Editar un documento anterior a R2** (cotización o pedido) recalcula su cabecera al céntimo:
  35.4354 pasa a 35.44. No se recalcula nada en lote. El barrido de importados solo corre a mano.
- **Vista previa de «Nuevo comprobante»:** recalcula `cantidad × unitario`. Con líneas importadas
  puede diferir un céntimo del total que guarda el API. Viene de antes de R2.

## Vuelta atrás

- **Código:** sin la web publicada, volver el tráfico a `ayr-steel-erp-api-00073-zmj`. Con la web
  publicada, abrir un PR de revert, mergearlo y después desplegar la API.
- **Datos:** no aplica. Los documentos creados entre el deploy y la vuelta atrás quedan con su
  total al céntimo, que sigue siendo válido con el código anterior: un total de dos decimales es
  un caso particular del de cuatro.

## Nota para el cliente (lo que se ve distinto)

> Desde hoy los **totales de cotizaciones, pedidos y comprobantes van al céntimo**, igual que en
> el papel de Nubefact. Antes la pantalla podía mostrar un total como S/ 35.4354; ahora muestra
> **S/ 35.44**. El precio de cada línea no cambia, y los documentos ya emitidos tampoco.
>
> Al **registrar un cobro**, el monto ya viene escrito con el **saldo al céntimo**. Se puede
> cambiar, pero solo con hasta dos decimales. Los comprobantes a los que les quedaba una fracción
> de céntimo (S/ 0.0001) dejan de aparecer como pendientes en Cobranzas.
>
> Otros cambios menores: el PDF de la cotización redondea en vez de cortar los decimales, la
> caja del POS cuadra al céntimo y los costos por kilo se ven con cuatro decimales.
