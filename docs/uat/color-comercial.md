# UAT — Color comercial (D-270..D-274, 2026-09-24)

En production después del deploy, **sin confirmar, montar ni guardar nada**, salvo lo que se
indica. Todo se puede repetir en `demo` si se prefiere probar montando.

## 1. Planta ofrece otro RAL del mismo color, primero el exacto (D-271)

1. Abrir en `/planta` una OP de una cobertura ROJO (por ejemplo, un producto con acabado
   ALZ-ROJO-3020) y **Buscar y montar bobinas**.
   **Esperado:** arriba las bobinas ALZ-ROJO-3020, con «RAL 3020» y la marca **Mismo
   acabado**; debajo, las ALZ-ROJO-3002 con «RAL 3002», sin la marca. Todas con su botón
   **Montar** habilitado. Cerrar sin montar.
2. En el filtro escribir `3002`. **Esperado:** quedan solo las 3002.
3. Descargar la **hoja de planta** del pedido de esa OP. **Esperado:** en «Medidas», «ROJO, de
   preferencia RAL 3020».

## 2. Inventario valorizado por color con el RAL como detalle (D-272)

1. `/reportes/inventario-valorizado`. **Esperado:** una fila ROJO por espesor, y debajo del
   nombre «RAL 3002 (ALZ-ROJO-3002): … kg · S/ …» y «RAL 3020 (ALZ-ROJO-3020): …».
   Las bobinas sin color salen como **Natural**.
2. **Esperado:** el total de bobinas es el mismo que antes del deploy (anotado en el runbook,
   paso 0).
3. Abrir un grupo ROJO. **Esperado:** cada bobina dice su acabado y su RAL.
4. **Descargar Excel**. **Esperado:** la hoja «Bobinas» tiene las columnas **Acabado** y
   **RAL**.

## 3. Candado del maestro de colores (D-273)

1. Catálogo → Colores → **Nuevo color** con código `ROJO-3020`. **Esperado:** aviso en el campo
   «Un color es el color comercial, sin número: el RAL va en el acabado». Cancelar.
2. Lo mismo con el nombre `Natural` o `Galvanizado`. **Esperado:** «es un tipo de acabado, no
   un color». Cancelar.
3. **Editar** el color ROJO y cambiar solo la muestra. **Esperado:** guarda. (Se puede volver a
   dejar como estaba.)
4. **Esperado:** el formulario ya no tiene el campo RAL; la columna de la tabla dice «RAL
   (histórico)».

## 4. Retiro del color NATURAL (D-274)

Solo después del paso 5 del runbook.

1. Catálogo → Colores. **Esperado:** NATURAL inactivo.
2. Registro de auditoría. **Esperado:** dos `raw_material_specs.delete` y un `colors.retire`,
   con el motivo D-274.
