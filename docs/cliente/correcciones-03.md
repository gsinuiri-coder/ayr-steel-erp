# Correcciones 03 del cliente — 25 de septiembre de 2026

Texto íntegro del cliente (sin imágenes), tal como llegó. La numeración es la de los párrafos, en
orden; es la que usan los handoffs y `docs/cliente/revision-2026-09-25.md`.

1. en la tabla de reportes de piezas de la pagina de detalle de orden, agregar columna de la
   bobina usada

2. en la pagina de comprobantes sale al inicio de la pagina un aviso de estado del envio… que
   ocupa mucho espacio, se podria poner eso como modal con un boton de info? e inspeccionar si
   existe en otras paginas.

3. los items del sidebar hacer los grupos tipo acordeon con uno solo activo.

4. la tabla de kardex se muestre vacio por defecto, que aqui exista filtro para poder seleccionar
   el item o sku especifico. filtros de fechas recomendados.

5. para el drywall el costo minimo se produce de acuerdo a la produccion, es necesario el precio
   lista?. igual que coberturas de aluzinc se calcula el costo con el margen que esta en
   configuracion etc.

6. que no exista stock no es impedimento para generar cotizacion, en este caso se avisa que no
   existe stock el admin puede discernir si se va conseguir material o decir que no a dicha
   cotizacion, o algo parecido. aqui tu sugerencia.

7. en el catalogo de coberturas de aluzinc existe un nuevo subtipo Accesorio que solo se necesita
   su espesor por ejemplo ACCES030ROJO, al crear cotizacion el filtro seria bobinas +-0.002[0.30]
   color rojo, como lo hace actualmente con los otros subtipos, aqui el usuario digital los
   metros lineales que se va ocupar, las cantidad de piezas por alguna razon solo para
   informacion del usuario. y el detalle en descripcion lo va realizar el usuario. en produccion
   se pondria en los campos los metros usados.

8. en coberturas de aluzin aun se selecciona acabo, eso tiene importancia, si los filtros son
   solo por color, en el natural como lo harias? o esta parte ya esta solucionado?

9. factura que detalle la ganancia, el costo por kilo de venta, el costo por kilo de compra y la
   ganancia por kilogramo tanto en kilos como en metraje, reflejar la cantidad total vendida,
   venta, costo, diferencia de ganancia y el costo promedio por unidad, incorporando a la bobina
   de aluzinc como un tercer código de artículo independiente.

10. los formularios aun se ven desorganizado los textos se solpana, los campos horizontales no
    estan alineas o se desalinean por subtitulos debajo, podrias implementar otro modelo, en
    donde solucione todo esto?

11. las secciones en la interfaz a nivel general, como son puros bordes, aveces es confuso
    visualmente podrias mejorar la experiencia UX, usa skills o descargarlas de ser necesario,
    con claude code. un estilo compacto puede ser, en mi experiencia con antd significa texto mas
    chico o componentes mas chicos en general, investiga el estilo compacto de antd, quiza tiene
    su par en shadcn/ui.

12. analiza de nuevo todas las tablas e implementa filtros de columnas si son necesarias.

13. en algunos catalogos de lineas de negocio la lista es larga, conviene un campo de busqueda.

14. recomiendas uso de filtros en el path url, para que cuando se retorne o actualice la pagina
    se quede en el estado actual?

15. agrega este modelo PEPS como segunda opcion, quiza un dropdown de opciones para que no ocupe
    espacio

16. los anulados en general que se ve con un filtro especial, siento que contamina a lista de
    todos si hay una linea asi.

17. en pedidos, que haya 2 filtros especiales de atendidos y anulados, el resto que se muestre
    por defecto.

18. en el historial de ordenes, haslo en forma de tabla, tal como esta ahora parece una lista
    interminable. a tu criterio que muestre lo mas importante, quiza una columna de ordenes con
    modal de detalle o quiza en forma de acordeon para ver los detalles de ordenes de los
    pedidos.

## Dónde quedó cada punto

| Punto | Estado                                                                                                         | Dónde                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1     | Entregado                                                                                                      | D-291                                                                      |
| 2     | Entregado                                                                                                      | D-292                                                                      |
| 3     | Entregado                                                                                                      | D-292                                                                      |
| 4     | Entregado                                                                                                      | D-290 (y el formato del cliente, D-298)                                    |
| 5     | **A validar en demo**                                                                                          | D-135 (costo de drywall por producción) y D-068 (precio de lista opcional) |
| 6     | Cotizar sin stock ya no bloquea (D-188); lo que bloqueaba era **confirmar**, y se cambia para el administrador | D-188; a validar en demo                                                   |
| 7     | **A validar en demo**                                                                                          | subtipo «Accesorio» de coberturas de aluzinc                               |
| 8     | Resuelto: el filtro de bobinas es por color comercial; el acabado sigue en el producto                         | D-270, D-271, D-135                                                        |
| 9     | **A validar en demo**                                                                                          | reporte «Ventas y margen»                                                  |
| 10    | Entregado                                                                                                      | D-293                                                                      |
| 11    | Entregado                                                                                                      | D-294                                                                      |
| 12    | Entregado                                                                                                      | D-295                                                                      |
| 13    | Entregado                                                                                                      | D-290                                                                      |
| 14    | Entregado                                                                                                      | D-289                                                                      |
| 15    | Entregado                                                                                                      | D-296 (y el formato del cliente, D-298)                                    |
| 16    | Entregado                                                                                                      | D-289                                                                      |
| 17    | Entregado                                                                                                      | D-289                                                                      |
| 18    | Entregado                                                                                                      | D-291                                                                      |
