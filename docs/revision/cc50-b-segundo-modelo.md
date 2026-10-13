# cc50 corte B — revisión del segundo modelo (Sonnet, contexto limpio)

`git diff 16813963 cc50-b-menores`, solo lectura. Sin P0 ni P1.

## P2

1. `scripts/smoke-version.test.mjs:214`: la regex de la segunda aserción quedó como comentario
   (`//api/health…`), así que `assert.rejects` pasa con cualquier rechazo. → corregir con la regex o
   comparación exacta.

## P3

1. `notJsonMessage` ata el texto de la web a `endsWith('/version')`; correcto hoy, revisar si cambia
   la ruta.
2. La E2E espera el `h1` (que solo aparece con la página cargada) antes de afirmar la ausencia: válida;
   si el API respondiera 403 el fallo diría «h1 no visible» y no la causa.

## Bien

- La espera del smoke no cambia (`waitForSha` captura el error y reintenta; topes intactos; un error
  que no es `SyntaxError` sale tal cual; `HTTP !ok` y el timeout siguen igual).
- SUPERVISOR_PLANTA entra a las tres vistas (RoleGate de corte y OP; compras en `nav.ts`).
- Contexto de navegador nuevo cerrado en `finally`; `deactivateTrail` intacto.
- Los 11 usos de `AuditHistoryLink` quedan bien: 9 cabeceras al tamaño por defecto (incluida
  importar precios, `items-center` junto a `HeaderActions`), los 2 diálogos con `size="sm"`.

## Qué se hizo

- P2-1: **corregido** en `5e1309e4` (comparación exacta del mensaje).
- P3-1, P3-2: anotados.
