# Revisión de segundo modelo — cc31 corte 2

Revisor: Sonnet (contexto limpio). Fecha: 2026-10-07. Diff: `cc31-c1...cc31-c2`. Solo lectura; no se
ejecutó la suite (la revisión es por lectura de código y de los controladores del API).

Este informe es una lista de riesgos, no una aprobación: cierra la revisión el dueño.

## Resumen

- P0: ninguno.
- P1: 1 (la ruta de la barra superior queda en «…» en subrutas que no son documentos).
- P2: 4.
- P3: 6.

Verificado sin hallazgo: hooks de `AppFrame` (todos antes del `return` condicional); roles de cada
consulta de la campana contra el API (ninguna da 403); claves de query compartidas (misma forma
y mismo `queryFn` que las pantallas existentes); alcance por vendedor en el API; bucle de redirección
ingreso/middleware; E2E existentes.

## P1

### P1-1. La ruta muestra «…» para siempre en subrutas que no son un documento

`apps/web/src/lib/breadcrumb.ts:50-62`. Todo lo que cuelga de un ítem del menú y no es crear,
importar, estado de cuenta, editar ni agregar cae en `leaf = 'document'`, y el código lo pone solo
un detalle con `CrumbLabel`. Casos reales, todos sin `CrumbLabel`:

- `/configuracion/tipo-cambio`: entra por `activePrefix` de «Márgenes y tipo de cambio». Como
  `pathname !== best.path` (`/configuracion/margenes`), da `Administración / Márgenes y tipo de cambio / …`.
- `/planta/producir` y `/planta/tanda`: `Planta / Planta / …`.

El spec (`breadcrumb.spec.ts`, «las pestañas de configuración caen en su ítem») solo comprueba
`list.title`, por eso no lo vio.

Arreglo: cuando el ítem tiene `activePrefix` con varias rutas, o la ruta es hermana del menú,
comparar contra todos los prefijos exactos para devolver `leaf: null` (con `href: null` si
`pathname` es uno de ellos); y agregar a `EXTRA_LEAVES` `/planta/producir` («Producir») y
`/planta/tanda` («Tanda»). Mejor: que `'document'` solo se devuelva si el último segmento parece
un id (UUID), y que lo demás sea `leaf: null`. Añadir al spec las tres rutas.

## P2

### P2-1. La campana dice «No hay nada pendiente.» mientras carga o si las consultas fallan

`apps/web/src/components/pending-bell.tsx:97-110,146-148`. Todas las fuentes valen `null` hasta que
llegan; `pendingRows` devuelve `[]` y la campana afirma que no hay nada. Con la primera apertura
antes de que lleguen las consultas, o con el API caído, se tranquiliza al usuario sin fundamento
(el aviso de «Pendientes: ninguno» también va al lector de pantalla).

Arreglo: que `usePendingSources` devuelva también `isLoading`/`isError` (alguna consulta habilitada
sin datos). Con carga: «Calculando…»; con error: «No se pudo calcular. Reintenta en un minuto.».
El texto de «nada pendiente» solo con todas las consultas habilitadas resueltas.

### P2-2. Cotizaciones por vencer: tope silencioso de 200

`apps/web/src/components/pending-bell.tsx:88-92`. Pide `status=EMITTED&pageSize=200` y no mira
`total`. Con más de 200 emitidas el contador del menú y la fila de la campana subcuentan, y el
orden por defecto de la lista (`quotationOrderBy`) no es por vencimiento, así que pueden quedar
fuera justo las que vencen. Arreglo: comparar `data.total` con `items.length` y, si hay más,
mostrar «200 o más» / avisar que el cálculo es parcial, o pedir las páginas siguientes. Hoy el
volumen no llega, pero es un tope mudo.

### P2-3. `safeNext` acepta caracteres de control

`apps/web/src/app/login/login-form.tsx:28-32`. `?next=%2F%09%2Fevil.com` decodifica a `/\t/evil.com`:
empieza por `/`, no por `//`, no tiene `\`. Los navegadores quitan tab y saltos de línea al
resolver URL, así que se vuelve `//evil.com`. La lógica ya existía (se movió y se exportó), pero
ahora es una función con nombre y debería cerrarse. Arreglo: rechazar `/[\u0000-\u001f\u007f]/` y, para
asegurar, resolver con `new URL(next, window.location.origin)` y exigir mismo `origin`.

### P2-4. Breadcrumb ignora la pestaña de `/catalogo?tab=colores`

`apps/web/src/lib/breadcrumb.ts:31-48`. «Productos» (`/catalogo`) y «Colores» (`/catalogo?tab=colores`)
comparten ruta; con `>` estricto gana el primero, así que en Colores la ruta dice «Productos».
`crumbsFor` solo recibe `pathname`. Arreglo: pasar también `?tab=` y aplicar el mismo criterio
que `isItemActive` del menú (que sí mira el query), o aceptar y documentarlo.

## P3

1. Textos con plural fijo: `app-sidebar.tsx` (`'${n} cotizaciones por vencer…'`, `'${n} reservas
   temporales vigentes'`, `'${n} pedidos listos…'`, `'${n} órdenes…'`) dicen «1 reservas». La campana
   sí pluraliza (`plural()`); reusarla.
2. Primer ingreso, al guardar: `invalidateQueries(ME)` deja `mustChangePassword=false` antes del
   `router.replace('/')`, y por un instante se dibuja la pantalla de «Cambiar contraseña» dentro
   del marco con el formulario recreado. Visual, no funcional. Arreglo: `router.replace('/')`
   primero y después invalidar, o `await` solo del `replace`.
3. Accesibilidad de «Ir a» (`go-to-dialog.tsx:117-130`): `aria-expanded` fijo en `true` y falta
   `aria-autocomplete="list"`; el `role="group"` dentro de `listbox` es válido pero algunos lectores
   lo leen mal. Funciona con `aria-activedescendant`. El `onMouseMove` que fija `active` dispara
   `scrollIntoView` y puede tironear la lista.
4. La campana (`pending-bell.tsx:134`): el `PopoverContent` (rol `dialog` de Radix) no tiene nombre
   accesible; agregar `aria-label="Pendientes"`. La insignia numérica cuenta filas, no ítems: está
   bien, pero la etiqueta «Pendientes: 3» puede confundirse con 3 documentos.
5. `SessionProvider` (`session.tsx:49`) pierde la query string de la pantalla al vencer la sesión
   (`encodeURIComponent(pathname)`, ya era así). El aviso «vuelves a X» dice la pantalla, no
   los filtros. Vale `pathname + search`.
6. Costo: la campana y el menú comparten consultas (una sola petición por clave), pero cada
   sesión de administrador hace 7 consultas por minuto en cada pestaña abierta. Es lo aprobado en
   ESPEC §8; solo dejarlo anotado para el monitoreo del API.

## Verificado por lectura

- **Roles por endpoint.** `/invoicing/alerts` (clase ADMIN+VENDEDOR, la usa solo ADMIN),
  `/invoicing/documents` (ADMIN+VENDEDOR, vendedor), `/sales/orders/with-shortfall` y
  `/catalog/price-list/floor-summary` (solo ADMIN, `enabled: isAdmin`), `/sales/orders`,
  `/sales/quotations`, `/sales/temporary-reservations` (ADMIN+VENDEDOR, `sells`),
  `/production/roofing/queue` (ADMIN, VENDEDOR y SUPERVISOR; se pide para ADMIN y SUPERVISOR).
  Ningún rol llama a un endpoint que se le niegue: sin 403 en consola. SUPERVISOR_PLANTA solo
  consulta la cola.
- **Alcance del vendedor.** `findAll` de comprobantes, pedidos y cotizaciones recibe `actor` y
  `findTemporaryReservations` usa `quotationSellerWhere(actor)`: el vendedor solo ve lo suyo y la
  campana dice «tuyos/tuyas». Para el vendedor se usa la lista de comprobantes (no `/alerts`, que es
  global), bien resuelto.
- **Claves compartidas.** `['production-queue']`, `['temporary-reservations']`,
  `['orders-with-shortfall']`, `['price-list-floor-summary']` e `['invoicing-alerts']` tienen en
  las otras pantallas el mismo `queryFn` y la misma forma (`ProductionQueueEntryDto[]`,
  `TemporaryReservationListItemDto[]`, `OrderWithShortfallDto[]`, `{pending,stalled}`). Las tres
  consultas nuevas usan claves propias (`['pending', …]`). Las invalidaciones existentes
  (`invalidateSales`, `invalidateProduction`, `invalidateInvoicing`) siguen alcanzándolas.
- **Hooks de `AppFrame`.** `useState`, `useCallback` y `useGoToShortcut` van antes del
  `return` por `mustChangePassword`; sin violación. Con `mustChangePassword` no hay marco ni
  `GoToDialog`: no se ofrece navegar, y `SessionProvider` ya devuelve a `/cambiar-contrasena` desde
  cualquier otra ruta (también si el atajo Ctrl K se pulsa: no hace nada visible).
- **Bucles de redirección.** `/login` con cookie → middleware manda a `/`; si `/auth/me` da 401,
  `SessionProvider` manda a `/login?…&expired=1`. No hay bucle porque `POST /auth/refresh`
  borra las cookies al fallar (`auth.controller.ts`, `clearAuthCookies`) antes del redirect.
  `expired=1` solo cambia un aviso.
- **Textos.** Tuteo consistente («Ingresa», «Revisa», «Pídele», «Elige»), sin inglés ni códigos
  internos visibles (los `status=ISSUED,SEND_ERROR` son solo URL).
- **E2E.** `getByRole('button', { name: 'Ingresar' })` sigue siendo único (los botones «Mostrar
  la contraseña» no coinciden; «Ingresando…» no contiene «Ingresar»). `getByLabel('Contraseña',
  { exact: true })` sigue dando un solo campo. Las etiquetas del cambio de contraseña
  (`Contraseña temporal`, `Contraseña nueva`, `Repite la contraseña nueva`, `Guardar y entrar`)
  están actualizadas en `e2e/helpers/ui.ts`, `auth.spec.ts` y `usuarios.spec.ts`. No queda ningún
  E2E que busque el botón «Cerrar sesión» ni «Volver al mostrador» fuera de lo ya editado.
- **Sin verificar.** Los roles de `RoleGate` de `/cotizaciones/nueva`, `/pedidos/nuevo` y
  `/clientes/nuevo` (no tienen `RoleGate` propio visible); `CREATE_ENTRIES` los declara a mano
  (`go-to.ts`) y puede desfasarse del control real. Conviene un spec que cruce `CREATE_ENTRIES`
  con `NAV`/`RoleGate`.
