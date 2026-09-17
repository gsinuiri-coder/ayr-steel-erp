/**
 * RF-S3/M4 (hallazgo de `revisor`, cierre de la ventana): el sentinel de `/catalogo?bajoPiso=`
 * para "más de los que la card ya listó, sin resaltar ninguno en particular" — antes era el
 * literal `'1'` repetido en `price-floor-summary-card.tsx` y `catalogo-view.tsx` sin que un
 * lector de uno solo pudiera saber de dónde salía. Un `productId` real es siempre un UUID, así
 * que nunca puede coincidir con este valor por accidente.
 */
export const CATALOG_BAJO_PISO_VER_TODOS = '1';
