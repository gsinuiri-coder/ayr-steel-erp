# Autorrevisión — color comercial (D-270..D-274), rama `feat/color-comercial`

**Autorrevisión** según `AGENTS.md` §2.2: dos subagentes nuevos del mismo modelo que escribió
el cambio, sin leer el handoff de implementación. Uno revisó API/shared/scripts/E2E y otro la
web, por separado (la lección de «revisar el web aparte del API»). No vale como pase cruzado:
es una lista de riesgos para quien revise después.

Alcance: `origin/main...feat/color-comercial` hasta `e1556ed`.

## Resultado

**0 P0. 0 P1 de código.** Dos P1 de proceso/deploy, los dos atendidos:

| Hallazgo   | Qué                                                                                                                                                      | Resolución                                                                                                                                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 web     | Con la web nueva y la API vieja, `/reportes/inventario-valorizado` se cae (`group.finishes` indefinido) y el selector de planta muestra «RAL undefined». | **Orden de deploy API → web** (regla dura 11), fijado en el runbook `docs/handoff/ventana-color-comercial.md`. No se agregaron guardas `?.`: el tipo del DTO no las admite y la regla de orden ya lo cubre. La convivencia inversa (web vieja + API nueva) no rompe: solo hay campos de más. |
| P1 proceso | Los comandos nuevos que tocan production (`retire:unused-color`, `check:color-comercial`) no tienen regla `ask` en `.claude/settings.json`.              | Agregados a `scripts/apply-ask-rules.mjs`. **Lo tiene que correr el dueño** (`--write`): el agente no puede editar su propia configuración.                                                                                                                                                  |

## P2

| #   | Hallazgo                                                                                                                                                 | Estado                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | El formulario de colores no dejaba editar un color viejo que ya viola el candado (el código deshabilitado se validaba igual; el nombre viajaba siempre). | **Corregido** (`26a5f01`): el candado se aplica a lo que se escribe (código al crear, nombre si cambió) y el PATCH manda el nombre solo si cambió.    |
| 2   | La tabla de colores sigue mostrando la columna «RAL» bajo el texto «sin RAL».                                                                            | **Corregido**: rotulada «RAL (histórico)». Hoy solo la semilla de dev la llena.                                                                       |
| 3   | Dos acabados del mismo RAL en un grupo del valorizado se leen iguales.                                                                                   | **Corregido**: «RAL 3020 (ALZ-ROJO-3020)».                                                                                                            |
| 4   | El texto «arriba van las del mismo acabado» aparece aunque no haya ninguna.                                                                              | **Corregido**: el texto depende de si hay alguna exacta.                                                                                              |
| 5   | `finishRal` toma cualquier número de cuatro dígitos al final (un año, «1000»).                                                                           | **Anotado.** Solo presentación y orden (D-271). En production los 9 acabados son `ALZ-<COLOR>[-RAL]`, `ALZ-NATURAL` y `GALV`: ninguno cae en el caso. |
| 6   | El retiro corre con el timeout de 5 s de Prisma, corto contra Neon desde afuera.                                                                         | **Corregido**: 60 s / 20 s de espera.                                                                                                                 |
| 7   | `check:color-comercial` contra production no pedía `--confirm-production`, a diferencia de las demás CLI.                                                | **Corregido.**                                                                                                                                        |
| 8   | La auditoría de la spec borrada no guardaba `createdAt`.                                                                                                 | **Corregido.**                                                                                                                                        |
| 9   | Colores vivos que violen el candado harían que el PATCH con nombre rebote.                                                                               | Verificado contra el dry-run de production: el único que lo viola es NATURAL, que D-274 retira.                                                       |

## Lo que los revisores verificaron sin hallazgo

- No hay migración ni cambio de `schema.prisma`.
- El retiro cuenta toda referencia posible: ninguna tabla tiene FK hacia `raw_material_specs` y el
  kardex no admite `RAW_MATERIAL`. El `FOR UPDATE` sobre el color serializa contra cualquier
  alta que lo referencie. La auditoría va por `AuditService.write` en la misma transacción.
- El candado no rompe la semilla (`createMany` sin Zod), el helper de E2E (`E2E` + letras) ni
  ningún otro flujo: el único consumidor del schema es `colors.controller.ts`.
- `preferExactFinish` solo reordena (estable, cerradas al final); el tope de 500 ya existía.
- colSpan de las tablas tocadas, `key` de las listas, filtro del selector y aria.
