# Handoff — Ventana de deploy D-167..D-171 — 2026-09-10

## 1. Resumen

Mini-ventana de deploy a producción, aprobada por el dueño y ejecutada comando por comando con
su OK. Salieron los tres commits del hotfix (**D-167..D-171**), **sin migraciones nuevas**. El
API está arriba y verificado; el web salió por el push y su verificación en navegador es del
dueño.

CI (`34475912275`) quedó **en progreso** al cerrar. **Y la ventana no está cerrada**: falta la
rotación de la credencial de `neondb_owner`, que se expuso durante el paso 1.

---

## 2. Hecho

| Paso                      | Resultado                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1. Respaldo en Neon       | rama `respaldo-pre-hotfix-2026-09-10` (`br-muddy-flower-ae8ik7ae`), `ready`; `production` sigue default |
| 2. Estado de migraciones  | **«Database schema is up to date!»** — 55/55, solo lectura                                              |
| 3. `deploy:api`           | revisión nueva en `https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app`                                   |
| 3b. Verificación          | `smoke:prod` en verde + dos marcadores de revisión                                                      |
| 4. `git push origin main` | `16ef8b5..946ce0e`; disparó CI y Vercel                                                                 |
| 5. Clientes activos       | **49 de 49** — el defecto del selector no es urgente                                                    |

**Pre-vuelo**: `turbo lint typecheck test build` 12/12, `eslint e2e` y `format:check` en verde,
working tree limpio.

**Producción ya estaba migrada.** La lista de «migraciones pendientes de desplegar» que
`PROGRESO.md` arrastraba (D-145, D-146, D-153 ×2, D-154, D-157, D-161, D-164) **ya se había
aplicado en la ventana anterior** y nadie la había limpiado. Estuvo a punto de motivar un
`pnpm db:prod` que no hacía falta. Corregida, con la lección anotada: esa lista se **comprueba**
—`node scripts/migrations-status.mjs --branch production`, diez segundos y solo lectura— y no se
cree.

**Los dos marcadores de revisión.** Un smoke que solo mira que el API responda no distingue la
revisión nueva de la vieja, así que además se leyeron dos campos que **solo existen en los
commits de esta tanda**: `avgCostPen` en `/sales/sellable-coils` (D-170, 43 bobinas) y
`carriesInventory` en `/sales/stock-panel` (D-167). Los dos vinieron. Se leyeron con un
administrador efímero borrado en el `finally` (patrón D-024), nunca con la cuenta del dueño, y
el guion de un solo uso se borró (regla dura 13). **Conviene elegir un marcador nuevo en cada
ventana**, porque el de la anterior ya está desplegado y deja de distinguir nada.

**El selector de clientes tiene margen.** El defecto que encontró QA —pide 200 y los pinta sin
búsqueda— se midió contra la base real: **49 activos**, o sea 151 de margen. Sigue anotado y hay
tiempo de resolverlo con `SearchSelectField` (D-156) en vez de a las apuradas.

---

## 3. Decisiones tomadas

Ninguna decisión de arquitectura nueva: la ventana desplegó D-167..D-171, ya registradas en
`ARQUITECTURA.md` §0.2.

Sí se **amplió la regla dura 5** de `CLAUDE.md` con la tercera vía por la que se escapa un
secreto —el comando que lo imprime **al salir bien**— y con qué hacer ante una fuga (rotar, no
«tener cuidado»).

---

## 4. Bloqueos y pendientes

### ⛔ Pendiente crítico — la ventana no está cerrada sin esto

**Rotar la contraseña de `neondb_owner`.** Incidente del **2026-09-10, 11:54 UTC**:
`neonctl branches create` imprimió `connection_uris` con la contraseña en texto plano en su
salida de éxito. **Alcance: las cuatro ramas de Neon, `production` incluida**, porque esa
contraseña es la misma en todas (regla dura 5). No se escribió en ningún archivo ni se
commiteó; quedó en la salida del comando y en el transcript de la sesión.

El dueño decidió continuar la ventana sin rotar, asumiendo el riesgo, con la rotación como paso
obligatorio de cierre. Hasta que pase, **la credencial de producción está comprometida**.

```
neonctl roles reset-password --project-id frosty-cherry-97873994 --branch production neondb_owner
```

Y después: actualizar `.env.setup`, los secretos de Secret Manager en GCP (`pnpm secrets:gcp`) y
los de GitHub Actions (`pnpm secrets:gh`). **Redesplegar el API** después de rotar, porque su
revisión toma la credencial de Secret Manager.

### Otros

- **Verificar el web en el navegador.** El push disparó Vercel; no se sondeó (incidente de la
  ventana anterior). Vale mirar una cotización con un servicio, una plancha y una bobina.
- **CI `34475912275` quedó en progreso.** Mirarla una vez. Ojo: la corrida anterior (`16ef8b5`,
  D-166) quedó **`cancelled`**, así que la última CI verde es del 2026-09-08 y D-164..D-166
  nunca pasaron por una completa.
- **Vaciar los comprobantes de la cuenta demo del PSE.** Sigue en su tope y con eso hay 12 casos
  E2E rojos que no son una regresión (ver el handoff del hotfix).
- **La rama `respaldo-pre-hotfix-2026-09-10` queda para siempre** (nunca se borran ramas de
  Neon), igual que `respaldo-pre-deploy-20260909` de la ventana anterior. Son ya dos; conviene
  decidir si se acumula una por ventana.

---

## 5. Cómo verificar

```bash
# Solo lectura contra producción:
pnpm smoke:prod
node scripts/migrations-status.mjs --branch production

# Estado de la infraestructura (OJO: `branches create` imprime credenciales; `list` no):
neonctl branches list --project-id frosty-cherry-97873994
gh run list --limit 3
```

Prod: <https://ayr-steel-erp-web.vercel.app> · API:
<https://ayr-steel-erp-api-2ompzrgnfq-uc.a.run.app>

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126).

---

## 6. Siguiente sesión

1. **Rotar `neondb_owner`** y redesplegar el API. Es lo primero y no depende de nada más.
2. **Confirmar CI verde** en la corrida del push, o relanzarla.
3. **Vaciar el cupo del PSE demo** y correr `pnpm e2e` entera, que es lo único que la separa de
   estar en verde.
4. **Usar lo que se desplegó**: cargar agosto con el importador, cotizar un conformado y
   producir un pedido de planchas desde `/planta`.
5. **Fase 8 — auditoría, reportes y UAT**, según `docs/ARQUITECTURA.md` §3.7.
