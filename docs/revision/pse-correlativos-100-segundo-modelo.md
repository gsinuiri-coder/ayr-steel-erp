# Segundo modelo — D-365, gate PSE

Revisión de contexto limpio sobre el diff completo por `gpt-6-sol`. Se intentó además el pase
exigido con `claude -p --model sonnet --permission-mode plan`, pero Claude Code rechazó la
sesión por límite de gasto mensual. Este pase se registra como alternativa, sin presentarlo
como revisión humana ni como Sonnet.

- P1: `pnpm e2e:pse -g ...` o `--config ...` podía reemplazar la selección `@pse` y guardar un
  estado verde incorrecto. Corregido: el wrapper rechaza opciones de Playwright y comprueba en
  el JSON que todos los casos esperados tienen etiqueta `pse`.
- P2: MinIO podía fallar después de reservar correlativos y consumir emisiones de Nubefact.
  Corregido: prueba de escritura y lectura en MinIO local antes de guardar `pendingBases`.

Ambas correcciones tienen pruebas de script; el preflight de MinIO se ejecutó contra el
contenedor local. Sin P0/P1 abiertos identificados en este pase. La revisión del dueño sigue
siendo el cierre requerido.

Pase final del diff completo por el segundo modelo: sin hallazgos P0, P1 ni P2 concretos.
Señaló que la suite E2E completa precedió al ajuste final de espera en el spec de bobinas;
ese spec pasó 1/1 después del ajuste. La autorrevisión posterior detectó por separado el
riesgo de cuenta PSE real y se corrigió antes del commit.
