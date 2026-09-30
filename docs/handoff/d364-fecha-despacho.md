# Handoff — D-364, fecha editable del despacho rápido

## 1. Resumen

D-364 ajusta el despacho rápido de D-285 para que la fecha de salida sea elegible sin cambiar el comportamiento por defecto. La rama es `feat/fecha-despacho-editable`, creada desde `origin/main`; no se ejecutó ningún comando contra producción.

El cambio toca API y web. Commit `9f89455`, PR #62 abierto sin merge. El despliegue posterior debe ir **API antes que web**.

## 2. Hecho

- API: `GET /invoicing/documents/:id/dispatch-plan` acepta `dispatchDate` y `POST /invoicing/documents/:id/dispatch-at-issue-date` lo recibe en el cuerpo.
- El plan toma `max(fecha elegida, último parte de producción)`. Sin fecha elegida conserva `max(fecha de emisión, último parte)` de D-285.
- Preview y ejecución recalculan el plan; `firstNegativeDate` sigue bloqueando toda salida que deje negativo. Para una revisión por saldo se devuelve `firstValidDate` como ayuda de elección.
- Web: el diálogo muestra el selector, el default y la primera fecha candidata cuando la línea queda bloqueada.
- `OperationDateService` conserva los límites de fecha de operación y el rol ADMINISTRADOR para retrofecha. D-210 se mantiene sobre `issueDate`; no aplica una ventana fiscal a la fecha de salida interna.

## 3. Decisiones tomadas

- **D-364** — Fecha de despacho editable en D-285, sin cambiar la fecha de emisión ni permitir saldo negativo. La salida puede ser posterior al comprobante; GRE y PLE conservan sus fechas propias.
- **D-364** — Despliegue API antes que web, porque se agrega el contrato `dispatchDate` y `firstValidDate`.

## 4. Bloqueos / pendientes

- Pendiente: abrir PR, obtener revisiones independientes y ejecutar CI completa.
- Pendiente de ventana posterior: desplegar API antes que web. No hay migración ni cambio de datos.

## 5. Cómo verificar

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
```

Verificado: `pnpm typecheck` verde; `pnpm test` verde (158 suites / 1,966 tests API y 15 archivos / 88 tests web); y pruebas focalizadas D-364, 3 suites / 48 tests verdes. E2E local se detuvo por timeouts ajenos de alcance comercial; CI corre en un runner limpio.

## 6. Siguiente sesión

Esperar CI de PR #62. Si pasa, preparar una ventana de deploy API antes que web; el merge sigue requiriendo la ventana autorizada.
