-- D-125: la rama `demo` se clona de `production` y hereda sus `sessions` — refresh tokens
-- vivos de usuarios reales. Se purgan siempre al preparar demo (`pnpm db:demo`).
--
-- No es solo higiene: demo tiene su propio `JWT_SECRET` justamente para que un token de un
-- entorno no valga en el otro, y dejar las sesiones del clon sería conservar la única pieza
-- que un secreto compartido necesitaría para cruzar. Se borra la más barata de reponer (nadie
-- pierde nada: se vuelve a iniciar sesión).
DELETE FROM "sessions";
