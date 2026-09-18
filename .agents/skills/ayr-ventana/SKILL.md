---
name: ayr-ventana
description: Ejecuta o guía una ventana de despliegue de AYR Steel ERP con respaldo Neon, migraciones, API, web y smoke en el orden seguro. Usar exclusivamente para una ventana autorizada de demo o producción.
---

# Ventana de despliegue AYR

Lee primero `AGENTS.md`, `docs/ENTORNOS.md`, `docs/PROGRESO.md`, el handoff de la sesión y el
guion UAT. Una autorización general de ventana no elimina las paradas manuales siguientes.

1. Verifica rama/SHA, CI verde, diff de runtime y UAT aprobado. Define el SHA de release.
2. **PARADA DEL DUEÑO:** solicita autorización por nombre para crear el respaldo Neon y para
   cualquier limpieza de respaldos. Verifica nombre e ID; nunca borres las ramas protegidas ni
   `respaldo-pre-v4-20260915`.
3. Crea/verifica el respaldo según `docs/ENTORNOS.md`. Mide filas/tamaño/estado cuando el runbook
   lo pida; no estimes.
4. Ensaya migraciones en el entorno permitido y comprueba que `migrate diff` coincide exactamente
   con el drift conocido.
5. **PARADA MANUAL POR CADA COMANDO DE PRODUCCIÓN:** el dueño aprueba individualmente
   `migrate status`, `migrate diff`, `migrate deploy`, `db:prod` o cualquier comando con
   credenciales de producción. El agente propone un comando y espera; no los encadena.
6. Orden invariable: migraciones Prisma → deploy API con label `git-sha` → push web por el dueño.
   El API nuevo nunca apunta a un schema viejo.
7. **PARADA DEL DUEÑO:** el agente no hace push. Entrega el comando con
   `AYR_OWNER_PUSH=1`; continúa solo después de confirmación del push y CI verde.
8. Desde un worktree en el SHA desplegado, corre `pnpm smoke:prod`; nunca `e2e:prod` (D-126).
   Verifica `/health`, revisión activa, label y ausencia de drift de runtime.
9. **PARADA DE VERIFICACIÓN:** el dueño ejecuta el guion manual/UAT en producción. Sin esa
   confirmación la ventana queda abierta, no «completada».
10. Registra tiempos y resultados medidos en `docs/PROGRESO.md` y cierra con `$ayr-cierre`.

Fuente operativa canónica: `docs/ENTORNOS.md`; invariantes: `AGENTS.md` §§3.1–3.3.
