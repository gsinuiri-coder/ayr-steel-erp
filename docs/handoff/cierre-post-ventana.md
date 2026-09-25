# Handoff — Cierre post-ventana de correcciones 02 (2026-09-25)

Agente: Claude Code, con dos subagentes: la revisión de segundo modelo (Sonnet) y la
autorrevisión de la PR #24. Orden del dueño, de corrido, en dos tramos: los pasos 1 a 6, y
después de ver el P1 de la revisión, la PR aparte `fix/despacho-cupo`.

## 1. Resumen

| Paso | Decisión | Resultado                                                                                         |
| ---- | -------- | ------------------------------------------------------------------------------------------------- |
| 1    | D-286    | Trigger del kardex estricto de nuevo; herramienta de D-285 deshabilitada y con advisory lock      |
| 2    | —        | Saldo corrido de los 109 ítems: ningún negativo en ninguna fecha                                  |
| 3    | —        | `COMPANY_RUC`/`COMPANY_LEGAL_NAME` en Cloud Run; falta mirar el Excel                             |
| 4    | —        | Capturas «después» de M8 en `local-data/capturas-corr02-despues/`; guía del cliente actualizada   |
| 5    | —        | AGENTS.md §4: copiar y verificar `local-data/` antes de borrar un worktree                        |
| 6    | D-287    | Segundo modelo: 0 P0, 1 P1, 4 P2. P1-1 y P2-3 corregidos en la PR #24; los otros 3 P2 en PROGRESO |

Secuencia de commits: `a472252` (D-286, PR #23, merge `11628d2`); `2301c0e` y `a5b39c5` (D-287,
PR #24, merge `5f6eacc`); el commit de docs de esta rama (`docs/cierre-post-ventana`).

## 2. Production

- Respaldo `respaldo-pre-kardex-estricto-20260925` (`br-blue-night-aeconhje`).
- Migración `20260925120000_kardex_append_only_estricto` (`db:prod`; `migrate diff` = drift
  conocido exacto). UPDATE rechazado en la base, verificado en transacciones revertidas.
- API: `00050-hvk` (`a472252`) → `00051-k7j` (solo variables `COMPANY_*`) → `00052-mcz`
  (`a5b39c5`). Health 200 y `smoke:prod` verde después de cada deploy de código. La web no
  cambió.
- Dry-run de D-278 de solo lectura después de D-287: 0 comprobantes, 0 líneas a revisión.
- Margen de agosto: 11.30 %, 28 pedidos `COMPLETO` (detalle en PROGRESO).

## 3. Lo que no se pudo hacer

- **Ver la cabecera en el Excel del PEPS.** La web guarda el token en memoria: leer el reporte
  desde la sesión del navegador del dueño exigía tomar ese token, y quedó bloqueado. Las
  variables están en la revisión activa y el código las lee (`env.ts`); falta que el dueño
  descargue un PEPS y lo mire.
- **Capturas «antes» de M8:** se perdieron con el worktree de corr02.

## 4. Pendientes

- El dueño descarga un PEPS y confirma RUC y razón social en la cabecera.
- P2-4 de la revisión de segundo modelo y el P2 abierto de D-287 (ver PROGRESO).
- La venta de agosto subió S/ 4 025.42 desde la foto de D-285; sin investigar.
- Respaldos de Neon de las ventanas del 24 y 25: proponer su borrado cuando cumplan siete días.

**Todo lo de esta sesión queda PENDIENTE DE REVISIÓN INDEPENDIENTE.**
