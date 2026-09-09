# Handoff — Sesión Largo de la plancha — 2026-09-09

## 1. Resumen

Bugfix de la captura: en Nueva cotización, `PL028ROJO` (plancha de 3 m) mostraba el largo en
**0.00**, calculaba **0.030 m lineales** y cobraba **S/ 0.28** por diez planchas a S/ 11 el
metro, en vez de 30 m y S/ 330. **No había ningún error en el código de D-161**: la cuenta era
correcta y el número del maestro estaba mal. **D-166** hace que el largo del catálogo tenga que
ser un largo posible, y que el campo diga en qué unidad va.

`pnpm turbo lint typecheck test` en verde (**357/357** unitarios). E2E: **3/3** del caso nuevo,
por pantalla, y **33/33** de regresión de ventas y catálogo.

**Nada desplegado y sin push**; producción no se tocó ni para leer.

---

## 2. Hecho

### La causa, que no era la que parecía

El brief apuntaba a que «el largo del SKU no se hidrata en el form». **Sí se hidrata.** Lo que
pasa es que el catálogo tiene `length_mm = 3.00`: el campo del maestro pide **milímetros** y
todo el resto de la pantalla de coberturas trabaja en **metros**, así que «3» entró queriendo
decir 3 metros.

Y no fue un desliz. Las **tres** planchas del catálogo estaban así:

```
 sku       | unit | length_mm
 PL028ROJO | NIU  |      3.00
 PL035AZUL | NIU  |      6.00
 PL045ROJO | NIU  |      6.00
```

De ahí en adelante todo funcionó como estaba escrito: 3 mm ÷ 1000 = 0.003 m por plancha, × 10 =
0.030 m, × S/ 9.3220 (el valor sin IGV de S/ 11) = **S/ 0.28**. Dos números correctos en
pantalla que había que saber leer, y ningún error por ningún lado.

### D-166, y lo que decidió su forma

**El corte no podía ser que `sellsByFixedLength` devolviera `false`.** Es lo primero que uno
piensa —si el largo es imposible, que no cotice por metro— y está mal: con `false` la línea cae
en el camino viejo, el del valor por plancha tipeado a mano, y el vendedor escribe 11 pensando
«por metro». Vuelve a estar mal, en silencio y por otro lado. Hace falta **cortar**, no elegir
otra rama, y por eso la precondición vive aparte del predicado.

**El rango no se inventó para este caso.** `MIN_PIECE_LENGTH_MM`..`MAX_PIECE_LENGTH_MM` (0.1 a
20 m) es exactamente el que la rama **a medida** ya exigía a cada largo de su plan de corte
desde D-083. La asimetría era el defecto: el largo que se tipea línea por línea estaba validado
y el que vive en el maestro —el único que nadie mira al cotizar— no. Ahora los tres lugares
preguntan lo mismo, `isPlausiblePieceLength` en `@ayr/shared`.

### Tres cortes, en los tres momentos

1. **Al cargar el producto** — `assertStructuredFields` (`apps/api/src/catalog/catalog.service.ts`)
   no guarda un largo imposible, y el mensaje **traduce el número y nombra la unidad**.
2. **Al tipearlo** — `PlateLengthHint` (`apps/web/src/components/catalog/product-dialog.tsx`)
   muestra el equivalente en metros en vivo. Es la mitad barata y la que de verdad previene.
3. **Al cotizar** — `assertUsableFixedLength` (`apps/api/src/sales/sales-lines.ts`) se niega a
   cotizar un producto **ya guardado** con el largo roto, nombrando el SKU; y la línea del
   formulario lo dice antes de intentar guardar. Es el corte que más importa: los tres
   productos siguen rotos hasta que alguien los corrija.

`pnpm check:roofing-catalog` los lista (y ahora acepta `--branch local|local-e2e`).

### Lo que NO se hizo, a propósito

**No se migró ni un dato.** Multiplicar por 1000 los largos por debajo del mínimo sería casi
siempre correcto y ocasionalmente desastroso, y es una decisión del dueño sobre sus propios
datos, no de una migración. Son tres productos y se corrigen en el catálogo en un minuto.

---

## 3. Decisiones tomadas

| ID        | Una línea                                                                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-166** | El largo fijo de una plancha tiene que estar entre 0.1 y 20 m —el mismo rango que el plan de corte ya exigía— y el campo dice en qué unidad va; tres cortes y ninguna migración. |

RF actualizados: **RF-50** (el largo va en milímetros y tiene rango).

---

## 4. Bloqueos y pendientes

### Lo que necesita acción tuya

- **Corregir las tres planchas en el catálogo**: `PL028ROJO` → 3000, `PL035AZUL` → 6000,
  `PL045ROJO` → 6000. Hasta entonces **no se pueden cotizar** (el API las rechaza nombrando el
  SKU, que es mejor que cobrar S/ 0.28, pero es un bloqueo real).
- **Correr `pnpm check:roofing-catalog --branch production`** y `--branch demo` para ver si allá
  hay más. Es solo lectura; no se corrió contra la base real sin tu OK.
- **Dar el OK para desplegar.** Está en local y sin push, junto con D-164/D-165 de la sesión
  anterior. **No hay migración nueva** en esta.

### Anotado, no hecho

- **El mismo campo existe en Drywall** («Largo de la pieza (mm)») y no tiene ni el rango ni la
  traducción a metros. No se tocó porque no hay evidencia de que esté mal cargado y porque una
  pieza de drywall no multiplica ningún precio por su largo; pero la trampa del campo es la
  misma y vale mirarlo si aparece un importe raro por ahí.
- **El ancho y el espesor tampoco tienen rango.** Un ancho de «1.22» en vez de 1220 no produce
  un error de precio —no multiplica el importe— pero sí ensucia el kg teórico y el agregado de
  materia prima. Es el mismo patrón y merece una pasada.

---

## 5. Cómo verificar

```bash
pnpm turbo lint typecheck test build     # verde (357/357 unitarios)
pnpm exec eslint e2e
pnpm exec prettier --check apps packages docs CLAUDE.md scripts e2e

pnpm check:roofing-catalog --branch local     # lista las planchas mal cargadas

# Matar servidores viejos en :3000/:3001 antes de E2E; NO tocar :4000/:4001 (regla dura 15).
pnpm e2e plancha-largo-d166                              # 3/3, por pantalla
pnpm e2e precios-d161-d163 fase7e fase1 fase7-consolidada-subtipo   # 33/33 de regresión
```

**Nunca `pnpm e2e:prod`** (regla dura 9, D-126).

---

## 6. Siguiente sesión

1. **Corregir las tres planchas** y volver a cotizar la de la captura, que es la verificación
   que cierra el caso de punta a punta.
2. **Usar lo que se construyó**: cargar agosto con el importador, registrar sus comprobantes en
   modo manual (D-153) y producir esos pedidos desde `/planta`.
3. **Fase 8 — auditoría, reportes y UAT**, la siguiente según `docs/ARQUITECTURA.md` §3.7.
