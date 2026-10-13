# cc50 corte B — autorrevisión (subagente nuevo, no aprobación)

Commit `fb0d587d`, solo lectura. Sin P0 ni P1.

## P2

1. La segunda aserción del test nuevo del smoke era un comentario (`//api/health…`) →
   **corregido** en `5e1309e4` (comparación exacta del mensaje).
2. El error decía «reintentando…» también donde no se reintenta (health sin `--expect-api-sha`, y
   «último error» al vencer el tope) → **corregido** en `5e1309e4`: el error dice solo el hecho y
   `onAttempt` de `smoke-prod.mjs` agrega «; reintentando…».

## P3 (anotados)

3. La E2E espera un `<h1>`; `error-screen.tsx` también dibuja uno: si la página cayera al error
   boundary para ese rol, la prueba pasaría sin probar la ausencia.
4. El usuario SUPERVISOR_PLANTA de la prueba queda vivo (mismo patrón que otros specs).
5. Cualquier `SyntaxError` se traduce a «todavía no responde JSON»: un JSON truncado de la API ya no
   muestra el error de parseo original.

## Bien

- `AuditHistoryLink` a 32 px: cotización, despacho, comprobante e importar precios quedan iguales o
  mejor; los diálogos con `size="sm"` quedan como antes.
- Contexto de navegador nuevo cerrado en su `finally`; permisos coherentes.
- Errores que no son de JSON (incluido el `AbortSignal.timeout`) salen tal cual; la espera no cambia.
- El caso real: un build viejo redirige `/version` a `/login` (HTML 200) → `SyntaxError` → mensaje
  nuevo.
