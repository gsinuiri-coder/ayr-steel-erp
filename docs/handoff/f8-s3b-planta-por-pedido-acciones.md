# Handoff — F8-S3b: modal de stock, planta por pedido, patrón de acciones — 2026-09-13

## 1. Resumen

Sesión F8-S3b (Fase 8): iteración sobre el feedback del dueño probando `dev:preview`. Solo UI y navegación (cero schema, lógica de dominio o endpoints). **M1–M4 entregados, nada sacrificado.**
Entorno **LOCAL**: 7 commits en `main` (`173b003..d5c45a5`) más el de docs, **sin push** por regla de la sesión. CI no corrió y no se desplegó nada.
Lint, typecheck y format en verde; **414/414 unitarios**. E2E completa: **302 verdes, 2 saltados (cupo PSE), 0 caídos** (§5).

## 2. Hecho

### M1 — modal de elegir producto

- [product-stock-picker.tsx](../../apps/web/src/components/sales/product-stock-picker.tsx): se quitó la sección del pool de bobinas (espesor + color con ML teórico). Todas las líneas ven la misma lista de productos con disponible y búsqueda.
- Sin scroll horizontal: tabla `table-fixed` con celdas que parten línea (la base de `TableCell` es `whitespace-nowrap`). «Elegir» queda visible sin desplazar.
- Aviso sin stock y flag de S2b, sin cambios.
- `RawMaterialPoolList` sigue en uso en el panel lateral de stock.
- E2E: [product-stock-picker-f8s2b.spec.ts](../../e2e/tests/product-stock-picker-f8s2b.spec.ts) comprueba en el DOM que no hay pool y que ni la tabla ni su contenedor desbordan.

### M2 — `/planta` entra por pedido (D-194)

- [planta-view.tsx](<../../apps/web/src/app/(app)/planta/planta-view.tsx>) pasa a cuatro modos por URL ([planta-links.ts](<../../apps/web/src/app/(app)/planta/planta-links.ts>)):
  - sin parámetros: lista de pedidos;
  - `?pedido=<id>` (`sin-pedido` para corridas a stock): cola del pedido + workspace de F8-S3;
  - `?op=` suelto: se resuelve al pedido de la orden; si no está abierta, lo avisa y ofrece su detalle;
  - `?historial=1`: el historial (M4).
- [pedido-groups.ts](<../../apps/web/src/app/(app)/planta/pedido-groups.ts>): agrupa batch + perfiles abiertos + cola.
  - Avance: órdenes con el plan cubierto / en curso / sin iniciar, y ML con `Decimal`.
  - Orden: `compareQueueRank` sobre la OP más urgente de cada pedido; corridas sin pedido al final.
- [pedido-list.tsx](<../../apps/web/src/app/(app)/planta/pedido-list.tsx>): una tarjeta por pedido.
  - Contenido: cliente, compromiso, prioridad, vencido, conteos, ML, productos y el resumen de cada OP en cola.
  - La tarjeta entera es el enlace «Producir PED-…».
- [pedido-priority.tsx](<../../apps/web/src/app/(app)/planta/pedido-priority.tsx>): «Priorizar pedido» / «Quitar prioridad al pedido» (ADMINISTRADOR).
  - Llama en serie a `PATCH /production/roofing/:id/priority`, solo en las OPs que cambian.
  - Un fallo parcial dice cuántas quedaron hechas y cuál falló.
  - Muestra «Prioridad en N de M órdenes» cuando es parcial.
- Abrir desde la cola **o elegir pestaña** escribe `?op=`: la última orden elegida sobrevive a recargar.
- E2E adaptados a la navegación nueva, con la misma cobertura de ranking y staging:
  - [planta-cola-f8s3-ui](../../e2e/tests/planta-cola-f8s3-ui.spec.ts), reescrito: ranking de pedidos, propagación de prioridad por pantalla y ranking por OP dentro del pedido;
  - `planta-espacio-produccion-ui`, `multi-montar-f8s3`, `reabrir-bobina-montar-f8s3` y `fase7e-ajustes-d121`.
  - Helper nuevo: `openQueuedOrder` en [ui.ts](../../e2e/helpers/ui.ts).

### M3 — patrón de acciones de cabecera (D-195)

- [header-actions.tsx](../../apps/web/src/components/header-actions.tsx): la vista declara acciones (`show`, `href`, `download`, `onSelect`, `pending`, `destructive`) y candidatas a principal.
  - La principal es la primera visible; el resto va al menú «Más acciones».
  - Las destructivas van al final del menú, separadas.
- Inventario de vistas con más de dos acciones a la vez, y su principal:

  | Vista            | Principal (en orden)                                                               |
  | ---------------- | ---------------------------------------------------------------------------------- |
  | Cotización       | Confirmar → Editar → Descargar PDF                                                 |
  | Pedido           | Despachar                                                                          |
  | Comprobante      | terminal por defecto (borrador) → Corregir y reemitir → Reintentar → Consultar PSE |
  | Despacho         | Emitir/Reemitir guía → Ver guía                                                    |
  | Bobina           | Partir (con saldo) → Cerrar/Abrir → PDF                                            |
  | Lista de bobinas | Nueva compra de bobinas                                                            |
  | Compra           | Recibir (con su fecha de operación debajo)                                         |

  Fuera del patrón por tener dos acciones o menos a la vez: detalle de OP, corte y lista de cotizaciones.

- Excepción `companion` en el borrador de comprobante: los dos terminales siguen a la vista porque D-153 lo exige.
- «Generar todas las órdenes» del pedido abre un diálogo con su `OperationDateField`. La hoja de planta pasa a acciones (`usePlantSheetActions`).
- E2E: helper `headerAction`, acotado a `[data-slot="header-actions"]`. Seis specs adaptados.

### M4 — plegables → drawer o vista propia (D-196)

- «Abrir una orden nueva» de `/planta` pasa a drawer; al crear, navega a `?op=`, que se resuelve al pedido.
- «Registrar pago» de la compra pasa a drawer ([compra-detalle-view.tsx](<../../apps/web/src/app/(app)/compras/[id]/compra-detalle-view.tsx>)) y no se cierra mientras el pago viaja.
- El historial de órdenes pasa a vista propia en `/planta?historial=1`; `/produccion` sigue redirigiendo ahí.
- No se tocaron, por no ser secciones de página:
  - «Ver bobinas cerradas», que vive dentro del modal de montar;
  - los grupos expandibles del importador.

### Revisión y QA

- **revisor**: sin bloqueantes ni altos. Todos los hallazgos se corrigieron en `1131423`.
  - Medio: un error de la cola tumbaba la lista de pedidos.
  - Bajos:
    - `?op=` que no sobrevivía a recargar;
    - `?op=` de otra orden que caía en silencio;
    - «0.000 m de 0.000 m» en pedidos solo de perfiles;
    - `drywall` sin memorizar;
    - foco perdido al volver del menú;
    - mensaje «(0 órdenes)» y texto del diálogo de prioridad;
    - helper E2E sin acotar.
  - Documentado sin cambiar: el tope de 500 del batch.
- **qa**: [huecos-cobertura-f8s3b.spec.ts](../../e2e/tests/huecos-cobertura-f8s3b.spec.ts), 8 casos:
  - prioridad parcial y quitar prioridad;
  - SUPERVISOR_PLANTA sin botones de prioridad;
  - `?op=` cerrado;
  - generar órdenes desde el menú;
  - drawer;
  - destructiva en el menú;
  - tarjeta del pedido paso a paso.

  No encontró defectos de la app.

- **El arreglo del revisor abrió una carrera, que corrigió `d5c45a5`.** Dejar en `?op=` solo lo abierto desde la cola hacía que una navegación en vuelo le robara la pestaña a un clic posterior. La suite completa lo encontró dos veces: la segunda, por un guardia que comparaba contra el `?op=` todavía viejo.

## 3. Decisiones tomadas

- **D-194**: `/planta` entra por pedido. La prioridad se asigna al pedido y se propaga a sus OPs con el endpoint por orden, sin migrar el schema.
- **D-195**: patrón único de cabecera, principal + «Más acciones», con la asignación por vista de arriba y la excepción de D-153.
- **D-196**: los formularios de creación en línea pasan a drawer y los historiales a vista propia.

## 4. Bloqueos / pendientes

- **Para el dueño:**
  - Confirmar o levantar la excepción de D-153 en el borrador de comprobante. El brief pedía un solo botón principal; se dejaron los dos terminales visibles porque D-153 lo pidió explícitamente.
  - Mirar en `dev:preview` la lista de pedidos, la prioridad por pedido y los menús antes del deploy: cambian cómo navega planta.
- **Menores, sin cerrar:**
  - Lo fijado desde la cola, salvo la última orden elegida, es estado de pantalla: tras recargar vuelve a la cola.
  - La lista de pedidos depende del batch sin filtro, con tope de 500 órdenes de coberturas abiertas.
  - `qa` notó un `main` anidado (layout de `(app)` + página); es previo a esta sesión.
- **Heredados de F8-S3:**
  - idempotencia de «Agregar al borrador»;
  - historial ordenado por `createdAt`;
  - `idempotency_keys` sin limpieza.
- Nada desplegado. Esta sesión no agrega migraciones; la ventana V-3 sigue siendo F8-S1..S3 más esta.

## 5. Cómo verificar

```
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check   # 414/414 unitarios
pnpm e2e                                                         # suite completa local (recrear ayr_local_e2e antes)
pnpm exec playwright test e2e/tests/product-stock-picker-f8s2b.spec.ts e2e/tests/planta-cola-f8s3-ui.spec.ts e2e/tests/planta-espacio-produccion-ui.spec.ts e2e/tests/huecos-cobertura-f8s3b.spec.ts
git log --oneline 573309d..HEAD                                  # commits de la sesión
```

E2E suite completa, tres corridas con la base recreada antes de cada una:

1. 300 verdes, 2 saltados, 2 caídos. Timeouts en `planta-espacio-produccion-ui`: la carrera de `?op=`.
2. 299 verdes, 2 saltados, 3 caídos. Los tres por `ECONNRESET` del contexto de requests: `auth`, `fase1` y `reabrir-bobina`; 3/3 en aislado.
3. **302 verdes, 2 saltados (cupo PSE demo), 0 caídos.**

Nada que verificar contra producción ni demo: sesión local, sin deploy.

## 6. Siguiente sesión

1. Ventana de deploy V-3 con F8-S1..S3b. Migraciones D-182, D-184, D-185, D-187, D-189 y D-191; F8-S3b no agrega. Verificar el backfill de prioridad en `demo` antes que en `production` y correr `pnpm smoke:prod` después.
2. Decisión del dueño sobre la excepción de D-153 (§4).
3. Resto de la Fase 8 según §3.7: auditoría, reportes, UAT.
