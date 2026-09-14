# E2E (Playwright)

Detalle de entornos, stubs y reglas en [`docs/ENTORNOS.md`](../docs/ENTORNOS.md). Esto es el
resumen operativo.

## Comandos

| Comando          | Qué corre                                           | Contra qué base                                                |
| ---------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm e2e`       | Suite completa, sin los casos `@pse`                | Local: `ayr_local_e2e` (Docker). CI: Postgres del runner.      |
| `pnpm e2e:smoke` | ~12 specs representativos (`scripts/e2e-smoke.mjs`) | Local: `ayr_local_e2e`. CI: rama Neon `ci` (job `smoke-neon`). |
| `pnpm e2e:pse`   | Solo los casos `@pse` (aceptación real del PSE)     | Local, con la cuenta demo de Nubefact.                         |

Nunca contra producción (D-126, regla dura 9): la verificación post-deploy es `pnpm smoke:prod`.

## Qué hace el arranque (`global-setup.ts`)

1. **Reset** (`apps/api/prisma/reset-test-db.ts`): migraciones y vaciado de todas las tablas.
   Solo contra una base de la lista blanca de `apps/api/prisma/test-db-guard.ts`:
   `ayr_local_e2e` en Docker, `ayr_ci_e2e` en `localhost` con `GITHUB_ACTIONS=true`, o la rama
   Neon `ci`.
2. **Seed**: líneas de negocio, márgenes, administrador, series fiscales y cliente «público en
   general».
3. **Correlativos por corrida** (`apps/api/prisma/e2e-fiscal-offset.ts`, D-202). Solo tras un
   reset.

## Correlativos fiscales y la cuenta demo de Nubefact (D-202)

El reset deja cada serie fiscal (`F001`, `B001`, `FC01`, `BC01`, `T001`) en correlativo 0, pero la
cuenta demo de Nubefact **recuerda** los números que ya recibió. Sin más, cada corrida volvía a
emitir `F001-00000001` y chocaba con la anterior, y el gate `pnpm e2e:pse` exigía vaciar la
cuenta hasta 0 exacto.

Por eso, tras el seed, todas las series se adelantan a un punto de partida propio de la corrida:

```
base = 10 000 000 + (epoch en segundos mod 80 000 000)
```

- **En segundos y no en minutos**: una corrida local y una de CI que arrancan en el mismo minuto
  partirían del mismo número. Dos corridas separadas por `n` segundos solo chocan si una emite
  más de `n` comprobantes de una serie, y el propio arranque de la suite tarda más que el cupo
  entero de la cuenta demo.
- **Ocho dígitos**, que es lo que SUNAT admite y lo que valida `createFiscalSeriesSchema`: el
  tope es 90 000 000. El rango da la vuelta cada ~2,5 años; **la próxima es el 2028-04-22**, y
  después de una vuelta la garantía no vale contra lo que la cuenta demo recibió en la anterior:
  ese día hay que vaciarla una vez.
- **Nunca sobre una base con historia**: el correlativo es un hecho fiscal. Con
  `E2E_RESET_DB=0` no se toca.

**Lo que no cambia:** la cuenta demo sigue admitiendo 50 comprobantes. Si está cerca del tope, el
dueño la vacía antes de `pnpm e2e:pse` (checklist de ventana en `docs/ENTORNOS.md`). Lo que deja
de ser bloqueante es la numeración, no el cupo.
