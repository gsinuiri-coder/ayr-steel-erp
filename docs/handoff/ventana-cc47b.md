# Ventana cc47b — Correcciones del UAT de cc47

2026-10-12, madrugada de Lima. Sesión en modo continuo, con la ventana suspendida (D-533). Solo web:
sin API, sin migraciones y sin SQL contra producción. Hay cuatro decisiones nuevas, D-623 a D-626,
provisionales: D-623 a D-625 las decidió el dueño en su UAT del 12/10 y D-626 es un criterio de la
sesión dentro de D-623.

## En producción

- Merge del PR #185 (`9c6ef22a`): Vercel en verde y `smoke:prod` en verde en los dos dominios.
- La API no cambió: sigue `00117-7pm`.
- Vuelta atrás: revertir el merge de #185.

## Qué entró

### Descargas y botones de cabecera (D-623 y D-626)

`HeaderActions` nunca deja una descarga como botón principal: la manda siempre a «Más opciones».
Las descargas salieron de la línea del buscar y volvieron a la cabecera. Así quedó cada página:

| Página                          | Principal                                                        | «Más opciones»                                                     |
| ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| Cotizaciones                    | Nueva cotización                                                 | Importar desde Excel (admin), Descargar Excel                      |
| Pedidos                         | Nuevo pedido directo                                             | Descargar Excel                                                    |
| Comprobantes                    | Nuevo comprobante                                                | Descargar Excel                                                    |
| Cobranzas                       | —                                                                | Descargar Excel · Por cliente / · Comprobantes con saldo           |
| Clientes                        | Nuevo cliente (admin)                                            | Descargar Excel                                                    |
| Compras                         | Recibir seleccionadas (con filas marcadas, D-626) / Nueva compra | Importar compras, Descargar Excel                                  |
| Bobinas                         | Nueva compra de bobinas                                          | Importar, Desde XML, Descargar PDF                                 |
| Inventario                      | —                                                                | Descargar Excel · Bobinas por tipo                                 |
| Kardex                          | —                                                                | Descargar Excel, Descargar PEPS                                    |
| Catálogo                        | Nuevo producto / Nuevo color (según la pestaña)                  | Cargar precios de lista                                            |
| Importadores (precios, compras) | —                                                                | Descargar plantilla (y ejemplo)                                    |
| Los 7 reportes                  | —                                                                | Descargar Excel · <línea> (y PDF en el Reporte mensual de bobinas) |
| Cotización cerrada              | Imprimir                                                         | Descargar PDF, …                                                   |
| Detalle de corte                | Vincular factura del corte                                       | Cancelar lo pendiente (rojo)                                       |
| Orden de producción             | Producir esta orden / Reabrir orden                              | Anular orden (rojo)                                                |
| Mostrador, venta cerrada        | Imprimir comprobante («Nueva venta» a la vista, D-523)           | Descargar PDF                                                      |

### Cobranzas con el scroll único (D-624)

La causa: cc35 (D-547) dejó Cobranzas e Inventario «como detalle» porque tenían dos tablas por
pantalla, y las pestañas de cc47 no las volvieron lista. Ahora:

- Las tablas de Cobranzas e Inventario son `Table list`.
- `TabsContent` lleva `min-w-0`.
- Las grillas de las pestañas usan `grid-cols-1`.

### Sin scroll horizontal de página (D-625)

- `min-w-0` en el marco (`SidebarInset` y el contenido), en `Section` y en `TabsContent`.
- Los modales de detalle con tablas son anchos (`WIDE_DIALOG_CLASSNAME`): el desglose de Ventas por
  material y el historial de precio.

## Pruebas

- Lint con las reglas de hooks, typecheck, prettier y 325 unitarios de la web en verde.
- CI en verde: E2E en 2 shards, smoke de Neon `ci`, drift y Sonar.
- E2E adaptados: las descargas ahora están en «Más opciones», y el ayudante `moreOption` las busca por
  el comienzo del rótulo.
- E2E nuevo, `cabecera-y-ancho-cc47b.spec.ts`:
  - ninguna página se desplaza en horizontal, a 1366 ni a 1920;
  - las tablas de las pestañas son listas, con alto tope y cabecera fija (D-624);
  - el PDF y el Excel se descargan desde «Más opciones» con un filtro activo.
- Medida en local contra `ayr_local`:
  - Inventario valorizado pasó de 1419 a 1366 a 1366 px;
  - a 900 px no desbordan Ventas por material, el Reporte mensual de bobinas, Bobinas ni Ventas y
    margen.
- La suite E2E completa no se corrió en local. Claude Code detuvo por falta de memoria los servidores
  de capturas y la medición; la suite completa la corrió la CI.

## Revisión

- Autorrevisión y segundo modelo (`docs/revision/cc47b-segundo-modelo.md`): sin P0 ni P1.
- P2 corregidos:
  - plantillas de los importadores en «Más opciones»;
  - el rótulo de la descarga dice la pestaña;
  - la regla de Compras registrada como D-626;
  - E2E de ancho más robusto y con la prueba de D-624;
  - «Imprimir» como principal de una cotización cerrada.

## Fuera de alcance / para la próxima sesión

- D-612 a D-626 pendientes de ratificación.
- Capturas incompletas por la memoria: quedaron todas las «antes» y 28 «después», en
  `local-data/cc47b/capturas`.
  - Faltan Ventas por material a 1920 y su modal abierto: en `ayr_local` no hay filas por material.
  - Falta el diálogo de venta cerrada de Mostrador, porque pide crear una venta.
- Riesgos anotados: hay unas 48 grillas `grid gap-*` sin `grid-cols-1` en otras vistas. El `min-w-0`
  del marco cubre el scroll de la página, pero una de ellas podría estirar su propio bloque.
