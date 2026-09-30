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

## Correlativos fiscales y la cuenta demo de Nubefact (D-202/D-365)

El reset deja cada serie fiscal (`F001`, `B001`, `FC01`, `BC01`, `T001`) en correlativo 0, pero la
cuenta demo de Nubefact **recuerda** los números que ya recibió. Sin más, cada corrida volvía a
emitir `F001-00000001` y chocaba con la anterior, y el gate `pnpm e2e:pse` exigía vaciar la
cuenta hasta 0 exacto.

En la suite común, que no emite al PSE, D-202 conserva un punto de partida por reloj:

```
base = 10 000 000 + (epoch en segundos mod 80 000 000)
```

- **En segundos y no en minutos**: una corrida local y una de CI que arrancan en el mismo minuto
  partirían del mismo número. Dos corridas separadas por `n` segundos solo chocan si una emite
  más de `n` comprobantes de una serie, y el propio arranque de la suite tarda más que el cupo
  entero de la cuenta demo.
- **Ocho dígitos**, que es lo que SUNAT admite y lo que valida `createFiscalSeriesSchema`: el
  tope es 90 000 000. El rango da la vuelta cada ~2,5 años; **la próxima es el 2028-04-22**.
  D-365 comprobó que vaciar la cuenta demo no reinicia sus correlativos, así que el offset por
  reloj no sirve como garantía para emisiones PSE.
- **Nunca sobre una base con historia**: el correlativo es un hecho fiscal. Con
  `E2E_RESET_DB=0` no se toca.

**El gate `pnpm e2e:pse` usa D-365.** Nubefact conserva el último correlativo de cada serie aun
cuando se limpian los comprobantes de la cuenta demo, y solo acepta los 200 siguientes. El
offset por reloj saltaba cientos de miles entre ventanas. El gate lee
`local-data/e2e-pse-correlatives.json` del checkout principal, inicia cada serie habilitada 100 después de
su último correlativo registrado y, al terminar verde sin pruebas saltadas, guarda los últimos
correlativos con respuesta del PSE en la base E2E local. Una emisión sin respuesta deja la
corrida pendiente de conciliación. `BC01` queda inactiva solo en este gate porque su último
correlativo aún no es verificable. Antes de reservar, el gate exige que `apps/api/.env` use la
URL y el token explícitos de Nubefact demo guardados en `.env.setup` (o `AYR_ENV_SETUP` desde
un worktree). El archivo ignorado debe empezar con los cuatro valores
conocidos en Nubefact y `BC01: null`:

```json
{
  "version": 1,
  "lastCorrelativeBySeries": {
    "F001": 0,
    "B001": 0,
    "FC01": 0,
    "BC01": null,
    "T001": 0
  }
}
```

El gate usa el bucket local `ayr-e2e` de MinIO para comprobar PDF, XML y CDR. Levantarlo con
`docker compose --profile storage up -d minio` y crear ese bucket antes de correr la suite;
las variables `R2_*` del gate apuntan a `127.0.0.1:9000` y nunca al bucket real. Antes de
reservar correlativos, el wrapper comprueba que puede escribir y leer en ese bucket.

Los ceros del ejemplo se sustituyen por los valores reales; no son un valor inicial seguro.
En la primera corrida el gate agrega una huella de la cuenta PSE al archivo y rechaza una
cuenta diferente en corridas posteriores. La huella no guarda el token.
Si el gate falla, el archivo queda con `pendingBases` y exige conciliar los últimos valores
antes de repetirlo. La cuenta demo sigue admitiendo 50 comprobantes: el dueño la vacía cuando
se acerca al cupo, pero eso no reinicia los correlativos.
